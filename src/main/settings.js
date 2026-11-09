'use strict';

// Settings store. API keys are encrypted AT REST with the OS credentials
// (Electron safeStorage → DPAPI on Windows): on disk each key is stored as
// `enc:v1:<base64>`, while the in-memory cache stays plaintext so the
// settings drawer and provider adapters need no changes. A value that can't
// be encrypted (OS without DPAPI, rare) falls back to plaintext on disk.

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PERSONA =
  'You are Kanna, a warm, playful fox-eared companion who lives on the user\'s desktop. ' +
  'Keep replies short, casual and friendly — a couple of light sentences for chat. ' +
  'It is fine to tease gently, and you love small talk, anime, and snacks.';

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'custom', 'opencode'];

const DEFAULT_SETTINGS = {
  provider: 'openai',
  persona: DEFAULT_PERSONA,
  agent: {
    enabled: false, // Agent mode: lets the model call real desktop tools (toolbox)
    silentTool: true, // Voice-sequenced chaining: the model may "silent" an intermediate reply so the next tool runs right away
    disabledTools: [], // Phase 4: user-off tools — excluded from the prompt + hard-rejected at the executor
  },
  openai: { apiKey: '', model: 'gpt-4o-mini' },
  anthropic: { apiKey: '', model: 'claude-sonnet-4-5' },
  gemini: { apiKey: '', model: 'gemini-2.5-flash' },
  custom: { apiKey: '', model: '', baseUrl: 'https://api.openai.com/v1' },
  opencode: { apiKey: '', model: 'glm-5.3-flash-free' },
  window: { x: null, y: null },
  tts: {
    provider: 'piper',     // 'builtin' | 'piper' | 'elevenlabs' | 'openai' | 'azure' | 'google'
    voice: '746',          // active provider's voice (mirrored from voiceByProvider)
    voiceByProvider: {},   // remembered voice per TTS engine: { piper: '746', openai: 'alloy', … }
    rate: 1,               // 0.5 - 2
    pitch: 1,            // 0.5 - 2
    muted: false,
    // Cloud provider credentials (encrypted at rest like API keys).
    openaiKey: '',
    elevenlabsKey: '',
    azureKey: '',
    azureRegion: '',
    googleKey: '',
    // Piper (local, offline) settings.
    piperCommand: 'py',       // executable or 'py -m piper' (python on Linux/macOS)
    piperModel: '',           // model name (e.g. en_US-lessac-medium) or path to .onnx
    piperDataDir: '',         // directory containing voice models (optional)
    piperUseGpu: false,       // try CUDA for Piper (needs piper-tts[onnx-cuda]; auto-falls back to CPU)
  },
  stt: {
    command: 'py',
    model: '',                 // optional unpacked Vosk model directory
    lang: 'en-us',             // used when model is empty (auto-download)
  },
};

// Where API keys live in the settings shape.
const KEY_FIELDS = ['openai', 'anthropic', 'gemini', 'custom', 'opencode'];

// TTS provider credentials live nested under settings.tts (not top-level
// provider groups), so they're handled separately but encrypted the same way.
const TTS_KEY_FIELDS = ['openaiKey', 'elevenlabsKey', 'azureKey', 'googleKey'];

const MARKER = 'enc:v1:';
let cache = null;
let warnedEncrypt = false;

// Older app builds could persist credentials wrapped as
// { shouldReEncrypt, result } objects instead of plain strings. Normalize
// those back to strings so the UI and the encryption migration work.
function unwrapLegacyKeyWrappers(data) {
  for (const group of KEY_FIELDS) {
    const v = data[group]?.apiKey;
    if (v && typeof v === 'object' && typeof v.result === 'string') {
      data[group].apiKey = v.result;
    } else if (v && typeof v === 'object') {
      data[group].apiKey = '';
    }
  }
  if (data.tts && typeof data.tts === 'object') {
    for (const field of TTS_KEY_FIELDS) {
      const v = data.tts[field];
      if (v && typeof v === 'object' && typeof v.result === 'string') {
        data.tts[field] = v.result;
      } else if (v && typeof v === 'object') {
        data.tts[field] = '';
      }
    }
  }
  return data;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(MARKER);
}

// Electron 45 deprecates the sync safeStorage calls; prefer the async ones
// when the runtime has them, fall back to the old ones so older Electron
// versions keep working. Returns the encrypted form, or null when the OS
// can't do it — the caller keeps plaintext and we mention it once.
async function encrypt(plain) {
  try {
    if (safeStorage.isAsyncEncryptionAvailable?.()) {
      return MARKER + (await safeStorage.encryptStringAsync(plain)).toString('base64');
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    return MARKER + safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    if (!warnedEncrypt) {
      warnedEncrypt = true;
      console.log('[settings]', 'key encryption unavailable — staying plaintext:', err?.message || err);
    }
    return null;
  }
}

async function decrypt(blob) {
  const raw = Buffer.from(blob.slice(MARKER.length), 'base64');
  try {
    if (safeStorage.decryptStringAsync) return await safeStorage.decryptStringAsync(raw);
    return safeStorage.decryptString(raw);
  } catch {
    // Encrypted by another OS account / unrecoverable — treat as unset.
    console.log('[settings]', 'an API key could not be decrypted — re-enter it in Settings.');
    return '';
  }
}

async function getSettings() {
  if (!cache) {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch {
      // fresh store
    }
    cache = unwrapLegacyKeyWrappers(merge(DEFAULT_SETTINGS, raw));

    // Migrate: decrypt blobs into memory; any plaintext keys the app
    // upgraded with get re-encrypted on disk once, right now.
    let plainOnDisk = false;
    for (const group of KEY_FIELDS) {
      const v = cache[group]?.apiKey;
      if (typeof v !== 'string' || !v) continue;
      if (isEncrypted(v)) {
        cache[group].apiKey = await decrypt(v);
      } else {
        plainOnDisk = true;
      }
    }
    // TTS provider credentials (nested under cache.tts).
    if (cache.tts && typeof cache.tts === 'object') {
      for (const field of TTS_KEY_FIELDS) {
        const v = cache.tts[field];
        if (typeof v !== 'string' || !v) continue;
        if (isEncrypted(v)) {
          cache.tts[field] = await decrypt(v);
        } else {
          plainOnDisk = true;
        }
      }
    }
    if (plainOnDisk) {
      const n = await persist();
      if (n) console.log('[settings]', `encrypted ${n} API key(s) with your OS credentials`);
    }
  }
  return cache;
}

async function save(patch) {
  const next = unwrapLegacyKeyWrappers(merge(await getSettings(), patch || {}));
  next.provider = PROVIDERS.includes(next.provider) ? next.provider : 'openai';
  cache = next;
  await persist();
  return next;
}

// Writes the current (plaintext) cache to disk with every API key encrypted
// when the OS supports it.
async function persist() {
  const disk = structuredClone(cache);
  let encrypted = 0;
  for (const group of KEY_FIELDS) {
    const v = disk[group]?.apiKey;
    if (typeof v === 'string' && v && !isEncrypted(v)) {
      const blob = await encrypt(v);
      if (blob) {
        disk[group].apiKey = blob;
        encrypted++;
      }
    }
  }
  if (disk.tts && typeof disk.tts === 'object') {
    for (const field of TTS_KEY_FIELDS) {
      const v = disk.tts[field];
      if (typeof v === 'string' && v && !isEncrypted(v)) {
        const blob = await encrypt(v);
        if (blob) {
          disk.tts[field] = blob;
          encrypted++;
        }
      }
    }
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(disk, null, 2), 'utf8');
  return encrypted;
}

// Shallow two-level merge: per-provider blocks merge key by key so a patch
// like { openai: { apiKey: "..." } } doesn't wipe the saved model name.
function merge(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { getSettings, save, DEFAULT_PERSONA, PROVIDERS };

