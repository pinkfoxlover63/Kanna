'use strict';

const { getSettings, DEFAULT_PERSONA } = require('./settings');
const affect = require('./affect');

let active = null;

function abortActive() {
  if (active) active.controller.abort();
}

// Streams one assistant reply. Emits ('chat:chunk', textDiff) to the renderer
// as tokens arrive and resolves to { stopped, text } at the end. Throws on
// hard errors (bad key, bad model, network) — the renderer shows the message.
// Phase 2 chat trigger: the user says the same thing over and over =
// spamming. Normalized hard (strip punctuation/emoji/spaces, collapse
// letter-runs like "hiiii"→"hi") so lazy variants count, then a small
// Levenshtein ratio catches near-misses ("…that" vs "…that to me"). A
// single letter/emoji doesn't count.
function normalizeForRepeat(t) {
  return String(t || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(.)\1{2,}/gu, '$1');
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similarEnough(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length > 80 || b.length > 80) return false;
  const ratio = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  return ratio >= 0.7;
}

function userRepeatCount(messages) {
  const texts = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === 'user')
    .map((m) => normalizeForRepeat(m?.content))
    .filter(Boolean);
  const cur = texts[texts.length - 1];
  if (!cur) return 0;
  let n = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (similarEnough(cur, texts[i])) n++;
    else break;
  }
  return n;
}

// Flooding: several unanswered user messages in a row (no reply between
// them) — she hasn't gotten to speak and messages keep arriving. Different
// contents still count; the pressure of "quiet, take them all!" is the trigger.
function rapidUserStreak(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === 'user') {
      if (String(messages[i]?.content || '').trim()) n++;
    } else if (role === 'assistant') break;
  }
  return n;
}

// Last user message raw text (same rule as main.js's copy, for tone reading).
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content || '');
  }
  return '';
}

async function runChat(messages, emit, system, opts = {}) {
  const { registerInActive = true, plain = false, noTriggers = false } = opts;
  const settings = await getSettings();
  const controller = new AbortController();
  if (registerInActive) active = { controller };

  // Affect triggers — real chat only (memory extraction passes plain:true
  // and system; synthetic scene prompts pass noTriggers). Neither kind is
  // user behavior, so neither may move her mood or decay anything.
  if (!plain && !noTriggers) {
    // Phase 1: fade whatever the previous turn left behind toward baseline
    // before the new mood arrives (idle time works in here).
    affect.beginTurn();
    // Phase 2 trigger #1: spam in either flavor — the same content again
    // and again (variants included), or an unanswered pile of new messages.
    const repeats = userRepeatCount(messages);
    if (repeats >= 3) affect.noteRepeat(repeats);
    else {
      const streak = rapidUserStreak(messages);
      if (streak >= 3) affect.noteFlood(streak);
    }
    // Phase 2 trigger #2: HOW the user says it — emotional language read.
    affect.noteUserTone(lastUserText(messages));
  }
  let text = '';
  let leaked = false; // fabricated placeholder found in the reply text
  let bridgeText = ''; // pre-tool talk from run #1 (never streamed; given back via .bridge)
  const reader = plain ? null : createReplyReader();
  // bufferToolText (agent chat): hold decoded text back until the stream
  // ends. A reply that carried a "tool" call gets its bridge text dropped
  // — the visible response is the next, note-fed pass — and a fabricated
  // bracket placeholder drops the whole pass with a `leak` flag. A reply
  // WITHOUT a tool call releases the buffer as-is: typing stays live.
  // Continuation chain passes are run WITHOUT this option: they stream
  // live, so she speaks right after each tool — never wait-for-all.
  const heldText = opts.bufferToolText && !plain ? [] : null;
  const releaseText = (t) => { if (t) { text += t; if (!heldText) emit('chat:chunk', t); else heldText.push(t); } };
  const push = (chunk) => {
    if (!reader) {
      text += chunk;
      emit('chat:chunk', chunk);
      return;
    }
    const meta = reader.feed(chunk); // announces mood/speed as soon as they arrive
    if (meta) {
      emit('chat:meta', meta);
      // Internal-only observation — the emitted meta above is untouched.
      if (meta.mood || meta.hold !== undefined || meta.speed || meta.intensity !== undefined) {
        affect.observe(meta, 'reply');
      }
    }
    releaseText(reader.takeText());
  };
  // Runs on success and on abort: hand over any decoded text left in the
  // reader buffer and a meta that was still pending.
  const flush = () => {
    if (!reader) return;
    const meta = reader.finish();
    if (meta) emit('chat:meta', meta);
    releaseText(reader.takeText());
    if (heldText) {
      // Tool call in a buffered pass = pure prelude — its text stays hidden
      // from the stream, but it comes back on the result as `bridge` so
      // main can dispatch it as a spoken lead-in line (voice-led chain).
      if (reader.tool) {
        bridgeText = heldText.join('');
        heldText.length = 0;          // bridge text — never streamed
        text = '';                    // same for the returned text
        return;
      }
      // Fabricated placeholder ("[time result] …" — she described a tool
      // instead of using one): drop the whole pass silently and flag it.
      // The recovery pass in main supplies the one clean answer.
      const agg = heldText.join('');
      if (/\[[^\]\n]{0,60}?\b(?:tool|result|time|placeholder)\b[^\]\n]{0,60}?\]/i.test(agg)
        || /(?:internal note|TOOL RESULT)[: ]/i.test(agg)) {
        leaked = true;
        heldText.length = 0;
        text = '';
        return;
      }
      for (const t of heldText) emit('chat:chunk', t);
    }
  };

  try {
    // Explicit system string wins (memory extraction uses this); otherwise
    // compose the persona with the long-term memory block.
    const systemPrompt = system !== undefined
      ? system
      : composeChatSystem(settings, affect.styleNote());

    if (settings.provider === 'anthropic') {
      await streamAnthropic(settings, messages, push, controller.signal, systemPrompt);
    } else if (settings.provider === 'gemini') {
      await streamGemini(settings, messages, push, controller.signal, systemPrompt);
    } else {
      await streamOpenAI(settings, messages, push, controller.signal, systemPrompt);
    }
    flush();
    affect.endTurn();
    return { stopped: false, text, tool: reader ? reader.tool : null, leak: leaked, silent: reader ? reader.silent === true : false, bridge: bridgeText };
  } catch (err) {
    flush();
    if (isAbort(err)) {
      affect.onInterrupt('interrupt');
      affect.endTurn();
      return { stopped: true, text, tool: null };
    }
    throw err;
  } finally {
    if (registerInActive) active = null;
  }
}

// --- reply protocol ---------------------------------------------------------
// Chat replies are one JSON object: {"mood":"…","speed":…,"text":"…"} — keys
// in this fixed order so mood and speed are known before any words stream.
// createReplyReader() feeds raw chunks through an incremental decoder and
// yields progressively the decoded `text` value, so the bubble still types
// out live. Mood/speed surface via 'chat:meta'. A reply that doesn't start
// as JSON (model ignored the protocol) degrades to raw passthrough, and a
// broken JSON object falls back to the raw output so the bubble is never
// empty. Memory extraction opts out entirely via plain:true.

function createReplyReader() {
  const r = {
    raw: '',
    mode: null,        // 'json' | 'plain' — decided on the first real char
    textFrom: -1,      // raw index where the "text" value starts
    textDone: false,   // closing quote reached
    pos: 0,            // decode cursor within the text value
    mood: '',          // as the model wrote it (lowercased)
    speed: 0,
    hold: false,
    intensity: null,   // optional, model-driven (0..1)
    tool: null,        // optional {"name","args"} tool call, read at finish
    moodEmit: undefined,
    speedEmit: undefined,
    holdEmit: undefined,
    intensityEmit: undefined,
    moodSent: false,
    speedSent: false,
    holdSent: false,
    intensitySent: false,
    silent: null,      // optional per-pass "silent" flag (voice skip)
    silentSent: false,
    out: '',           // decoded text not yet handed to the caller
  };

  const escMap = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

  function scanMeta() {
    if (!r.moodSent) {
      const m = /"mood"\s*:\s*"([^"]*)"/.exec(r.raw);
      if (m) {
        r.mood = m[1].trim().toLowerCase();
        r.moodSent = true;
      }
    }
    if (!r.speedSent) {
      const m = /"speed"\s*:\s*([0-9]*\.?[0-9]+)/.exec(r.raw);
      if (m) {
        r.speed = Number(m[1]);
        r.speedSent = true;
      }
    }
    if (!r.holdSent) {
      const m = /"hold"\s*:\s*(true|false)/.exec(r.raw);
      if (m) {
        r.hold = m[1] === 'true';
        r.holdSent = true;
      }
    }
    // Optional, model-driven intensity (0..1); unknown to older replies.
    if (!r.intensitySent) {
      const m = /"intensity"\s*:\s*([0-9]*\.?[0-9]+)/.exec(r.raw);
      if (m) {
        r.intensity = Number(m[1]);
        r.intensitySent = true;
      }
    }
    // Optional "silent": true — chain passes may skip the voice so the
    // next tool runs immediately (agent silent-chaining option).
    if (!r.silentSent) {
      const m = /"silent"\s*:\s*(true|false)/.exec(r.raw);
      if (m) {
        r.silent = m[1] === 'true';
        r.silentSent = true;
      }
    }
  }

  // Decodes as much of the "text" string value as has streamed in.
  function decode() {
    while (r.textFrom >= 0 && !r.textDone && r.pos < r.raw.length) {
      const ch = r.raw[r.pos];
      if (ch === '"') {
        r.textDone = true;
        break;
      }
      if (ch === '\\') {
        if (r.pos + 1 >= r.raw.length) break;        // escape split across chunks
        if (r.raw[r.pos + 1] === 'u') {
          if (r.pos + 6 > r.raw.length) break;       // \uXXXX split across chunks
          const code = parseInt(r.raw.slice(r.pos + 2, r.pos + 6), 16);
          if (!Number.isFinite(code)) break;          // not hex — skip rather than guess
          r.out += String.fromCharCode(code);
          r.pos += 6;
          continue;
        }
        const esc = escMap[r.raw[r.pos + 1]];
        r.out += esc !== undefined ? esc : r.raw[r.pos + 1];
        r.pos += 2;
        continue;
      }
      r.out += ch;
      r.pos++;
    }
  }

  function takeText() {
    const out = r.out;
    r.out = '';
    return out;
  }

  function takeMeta() {
    let meta = null;
    if (r.moodSent && r.mood !== r.moodEmit) {
      (meta ??= {}).mood = r.mood;
      r.moodEmit = r.mood;
    }
    if (r.speedSent && r.speed !== r.speedEmit) {
      (meta ??= {}).speed = r.speed;
      r.speedEmit = r.speed;
    }
    if (r.holdSent && r.hold !== r.holdEmit) {
      (meta ??= {}).hold = r.hold;
      r.holdEmit = r.hold;
    }
    if (r.intensitySent && r.intensity !== r.intensityEmit) {
      (meta ??= {}).intensity = r.intensity;
      r.intensityEmit = r.intensity;
    }
    return meta;
  }

  function feed(chunk) {
    r.raw += chunk;
    if (!r.mode) {
      // Tolerate a ```json fence before the object when deciding.
      const t = r.raw.replace(/^\s+/, '').replace(/^```(?:json)?\s*/i, '');
      if (!t) return null;
      r.mode = t[0] === '{' ? 'json' : 'plain';
    }
    if (r.mode === 'plain') {
      r.out += chunk;
      return null;
    }
    scanMeta();
    if (r.textFrom < 0) {
      const m = /"text"\s*:\s*"/.exec(r.raw);
      if (m) {
        r.textFrom = m.index + m[0].length;
        r.pos = r.textFrom; // start decoding at the value, not at the object
      }
    }
    decode();
    return takeMeta();
  }

  // Pulls the "tool" value out of the raw reply as one balanced JSON
  // fragment ({"name":…,"args":{…}} — the args object nests, so the
  // regex shortcut used for mood/speed won't work here). Runs once at
  // stream end; tools execute after the typed text is done by design.
  function scanTool() {
    if (r.tool || r.mode !== 'json') return;
    const m = /"tool"\s*:\s*\{/.exec(r.raw);
    if (!m) return;
    let depth = 0;
    let str = false;
    let esc = false;
    for (let i = m.index + m[0].length - 1; i < r.raw.length; i++) {
      const ch = r.raw[i];
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') str = !str;
      else if (!str && ch === '{') depth++;
      else if (!str && ch === '}') { depth--; if (!depth) {
        try {
          // The balanced fragment from the opening brace (already the
          // first loop char) is the tool value object itself: {name,args}.
          const j = JSON.parse(r.raw.slice(m.index + m[0].length - 1, i + 1));
          const name = String(j?.name || '').trim();
          if (name) {
            const args = j.args && typeof j.args === 'object' && !Array.isArray(j.args) ? j.args : {};
            r.tool = { name, args };
          }
        } catch { /* malformed tool — treated as absent */ }
        return;
      } }
    }
  }

  function finish() {
    if (r.mode === 'json') decode();
    scanTool();
    // Protocol fell apart before any visible text: show the raw output
    // rather than an empty bubble.
    if (r.mode === 'json' && r.out === '' && !r.textDone) r.out = r.raw.trim();
    return takeMeta();
  }

  return { feed, finish, takeText, get tool() { return r.tool; }, get silent() { return r.silent; } };
}

// Persona + current memory, injected into every chat request.
const REPLY_FORMAT = [
  'Reply protocol — output ONE JSON object only. No markdown, no words outside it. Keys in this exact order:',
  '{"mood":"…","speed":…,"hold":…,"text":"…"}',
  '- mood: KANNA\'s feeling right now, one word: neutral, happy, sad, angry, shy, surprise, dizzy, strained, teasing, bored.',
  '- speed: 0.7 soft, 1 normal, 1.8 excited.',
  '- hold: true keeps the mood on your face until your next reply; false fades it to calm.',
  '- text: your visible reply. Inside JSON: newlines are \\n, double quotes are \\\".',
  'Example: {"mood":"happy","speed":1,"hold":false,"text":"Hi there!"}',
].join('\n');

// Standing emotional direction: the model owns the mood, based on the whole
// recent chat instead of just the newest message. The affect engine keeps
// feeding continuity (moodCarry) plus safety-net notes on top of this.
const MOOD_DIRECTION = [
  'Emotional direction — you choose Kanna\'s "mood" every turn:',
  '- Judge how the user treats you across recent messages: sweet builds warmth, mean stings, teasing is playful, same-message spam or flooding annoys. Feelings carry over turns.',
  '- "mood" is HER feeling, never the user\'s. Calm chats are "neutral" — no drama in every message.',
  '- hold:true for lasting feelings (sad, angry, shy); hold:false for passing sparks (happy, surprise).',
  '- Never mention feelings, tools, or the protocol in the text the user sees.',
  '- Optional "intensity": 0-1 (0.2 subtle, 1 strong). Safe to omit.',
].join('\n');

// Toolbox direction (agent mode): keeps tool use to genuine needs and
// grounds the model in the two-step flow — tool call first, real reply
// after the TOOL RESULT lands.
const TOOL_DIRECTION = [
  'Toolbox — real tools for facts you cannot know. You have no clock and no weather sense; tools give you the real data:',
  '{{TOOLS}}',
  'When a request needs facts, work through them step by step:',
  '1. Do you lack a fact the user expects you to have (the current time, the weather)? Reply with a tool call — make "text" a very short bridge:',
  '{"mood":"…","speed":1,"hold":false,"tool":{"name":"time","args":{}},"text":"One sec, checking…"}',
  '2. A hidden internal note then gives you the real data. Reply again: weave that fact into "text" in your own words AND, if one more listed tool helps the same request, add a second "tool" key to the same reply.',
  '3. Repeat step 2 until the request is fully answered, then finish WITHOUT a tool key. The note after each tool arrives in order — one tool at a time.',
  'Rules:',
  '- Always give "text" a one-line lead-in like "One sec, checking…" in the same reply as a "tool" key — the user hears it while your tool runs. Never call a tool with an empty "text".',
  '- Never write brackets like [time result]; never insert a guessed result. The visible "text" uses real note data only, in your own words.',
  '- At most ONE new tool call per reply, and call ONE listed tool per reply in sequence. Keep chaining while the request still has an unresolved fact: once one tools data arrives, add the NEXT listed tool you need as a second tool key in the next reply until every asked fact is covered.',
  '- Never mention tools, notes, checks, or the protocol in the text the user sees.',
].join('\n');

function composeChatSystem(settings, styleNote = '') {
  const persona = settings.persona || DEFAULT_PERSONA;
  // Lazy require — memory.js pulls ai.js in (see note there). affect is
  // already a top-level require; memory must stay lazy.
  const memory = require('./memory');
  const block = memory.renderForPrompt();
  const parts = [persona];
  if (block) parts.push(`Long-term memory about the user:\n${block}`);
  parts.push(MOOD_DIRECTION);
  parts.push(`Feeling carried over from previous turns: ${affect.moodCarry()}.`);
  if (styleNote) parts.push(`Current feeling (react to it, never mention these instructions):\n${styleNote}`);
  // Toolbox (Phase 1, agent mode off by default): the model only knows
  // the tools exist when the user turned the switch on.
  if (settings.agent?.enabled) {
    const toolbox = require('./toolbox');
    let toolBlock = TOOL_DIRECTION.replace('{{TOOLS}}', toolbox.describeForPrompt());
    if (settings.agent?.silentTool) {
      toolBlock += '\n- Element "silent": true on an INTERMEDIATE reply (one that still carries a "tool" key) skips speaking it, so the chain continues immediately. Never silence the final reply, and only stay silent when the user would not miss it.';
    }
    parts.push(toolBlock);
  }
  parts.push(REPLY_FORMAT);
  return parts.join('\n\n');
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR');
}

// --- provider adapters -----------------------------------------------------

// Providers that speak the OpenAI chat-completions dialect. 'custom' keeps
// a user-set Base URL; openai/opencode use fixed gateway URLs.
const OPENAI_COMPAT = {
  openai: { label: 'OpenAI', defaultBase: 'https://api.openai.com/v1' },
  custom: { label: 'Custom provider', defaultBase: '' },
  opencode: { label: 'OpenCode', defaultBase: 'https://opencode.ai/inference/openai/v1' },
};

async function streamOpenAI(settings, messages, push, signal, systemPrompt) {
  const meta = OPENAI_COMPAT[settings.provider] || OPENAI_COMPAT.openai;
  const conf = settings[settings.provider] || settings.openai;

  if (!conf.model) throw new Error(`${meta.label} needs a model name — set one in Settings.`);
  if (settings.provider !== 'custom' && !conf.apiKey) throw new Error(`${meta.label} needs an API key — add one in Settings.`);

  const baseUrl = (settings.provider === 'custom' ? conf.baseUrl : meta.defaultBase || '')
    .replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Custom provider needs a base URL — set one in Settings.');

  const headers = {};
  if (conf.apiKey) headers.authorization = `Bearer ${conf.apiKey}`;

  const res = await post(`${baseUrl}/chat/completions`, headers, {
    stream: true,
    model: conf.model,
    // No max_tokens/temperature here: newer OpenAI models and many
    // OpenAI-compatible servers reject the legacy parameters.
    messages: [{ role: 'system', content: systemPrompt }, ...normalize(messages)],
  }, signal, meta.label);

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // Some OpenAI-compatible local servers ignore stream:true — fall back to JSON.
    const j = await res.json();
    const t = j.choices?.[0]?.message?.content;
    if (t) push(t);
    return;
  }

  await streamSSE(res, (data) => {
    if (data === '[DONE]') return false;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    const t = j.choices?.[0]?.delta?.content;
    if (t) push(t);
  });
}

// --- model listing (the "↻ fetch models" button) -----------------------------

// GET variant of post(): same error translation, no request body.
async function getJson(url, headers, label) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(friendlyNetworkError(err, url));
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(humanHttpError(label, res.status, text));
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${label} answered with data that is not JSON.`);
  }
}

// Returns { models: [id] } for the given provider, reusing the provider's
// stored key/models so the listing matches what chat will actually use.
async function listModels(provider) {
  const settings = await getSettings();
  const name = String(provider || settings.provider);

  if (name === 'anthropic') {
    if (!settings.anthropic.apiKey) throw new Error('Anthropic needs an API key — add one in Settings.');
    const j = await getJson('https://api.anthropic.com/v1/models', {
      'x-api-key': settings.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
    }, 'Anthropic');
    return { models: (j.data || []).map((m) => m.id).filter(Boolean) };
  }

  if (name === 'gemini') {
    if (!settings.gemini.apiKey) throw new Error('Gemini needs an API key — add one in Settings.');
    const j = await getJson('https://generativelanguage.googleapis.com/v1beta/models', {
      'x-goog-api-key': settings.gemini.apiKey,
    }, 'Gemini');
    // Gemini names come as "models/gemini-…"; keep chat-capable ones only.
    return {
      models: (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean),
    };
  }

  if (name === 'custom') {
    const baseUrl = (settings.custom.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Custom provider needs a base URL — set one in Settings.');
    const headers = {};
    if (settings.custom.apiKey) headers.authorization = `Bearer ${settings.custom.apiKey}`;
    const j = await getJson(`${baseUrl}/models`, headers, 'Custom provider');
    return { models: (j.data || []).map((m) => m.id).filter(Boolean) };
  }

  if (name === 'opencode') {
    const headers = {};
    if (settings.opencode.apiKey) headers.authorization = `Bearer ${settings.opencode.apiKey}`;
    const j = await getJson('https://opencode.ai/inference/v1/models', headers, 'OpenCode');
    return { models: (j.data || []).map((m) => m.id).filter(Boolean) };
  }

  if (!settings.openai.apiKey) throw new Error('OpenAI needs an API key — add one in Settings.');
  const j = await getJson('https://api.openai.com/v1/models', {
    authorization: `Bearer ${settings.openai.apiKey}`,
  }, 'OpenAI');
  return { models: (j.data || []).map((m) => m.id).filter(Boolean) };
}

async function streamAnthropic(settings, messages, push, signal, systemPrompt) {
  if (!settings.anthropic.apiKey) throw new Error('Anthropic needs an API key — add one in Settings.');
  if (!settings.anthropic.model) throw new Error('Anthropic needs a model name — set one in Settings.');

  const res = await post('https://api.anthropic.com/v1/messages', {
    'x-api-key': settings.anthropic.apiKey,
    'anthropic-version': '2023-06-01',
  }, {
    stream: true,
    max_tokens: 1024,
    temperature: 0.8,
    model: settings.anthropic.model,
    system: systemPrompt,
    messages: normalize(messages),
  }, signal, 'Anthropic');

  await streamSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.type === 'content_block_delta' && j.delta?.text) push(j.delta.text);
    if (j.type === 'message_stop') return false;
  });
}

async function streamGemini(settings, messages, push, signal, systemPrompt) {
  if (!settings.gemini.apiKey) throw new Error('Gemini needs an API key — add one in Settings.');
  if (!settings.gemini.model) throw new Error('Gemini needs a model name — set one in Settings.');

  const model = encodeURIComponent(settings.gemini.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

  const res = await post(url, { 'x-goog-api-key': settings.gemini.apiKey }, {
    contents: normalize(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
  }, signal, 'Gemini');

  await streamSSE(res, (data) => {
    let j;
    try { j = JSON.parse(data); } catch { return; }
    for (const part of j.candidates?.[0]?.content?.parts || []) {
      if (part.text) push(part.text);
    }
  });
}

// --- plumbing --------------------------------------------------------------

async function post(url, headers, body, signal, label) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new Error(friendlyNetworkError(err, url));
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(humanHttpError(label, res.status, text));
  }
  return res;
}

// Fetch-level failures (connection refused, TLS mismatches, DNS) surface as
// raw "fetch failed" — translate the common ones into actionable messages.
function friendlyNetworkError(err, url) {
  const cause = err?.cause || {};
  const code = cause.code || cause.opensslErrorStack || '';
  const detail = `${cause.reason || cause.message || err.message || ''} ${code}`;
  let host = url;
  try { host = new URL(url).host; } catch { /* keep url */ }

  if (detail.includes('WRONG_VERSION_NUMBER')) {
    return `${host} answers in plain HTTP but the Base URL is https:// — local servers speak http:// (LM Studio: http://localhost:1234/v1, Ollama: http://localhost:11434/v1). Fix it in Settings.`;
  }
  if (code === 'ECONNREFUSED') {
    return `Can't connect to ${host} — the server isn't running, or the port in Settings is wrong.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Can't resolve ${host} — check the Base URL in Settings.`;
  }
  if (code === 'CERT_HAS_EXPIRED' || detail.includes('certificate')) {
    return `TLS certificate problem with ${host}: ${detail.trim()}`;
  }
  return `Network error talking to ${host}: ${detail.trim() || 'unknown'}`;
}

function humanHttpError(label, status, bodyText) {
  let msg = '';
  try { msg = JSON.parse(bodyText)?.error?.message || ''; } catch { /* keep '' */ }
  if (!msg) msg = (bodyText || '').trim().slice(0, 240);
  const base = `${label} request failed (HTTP ${status}): ${msg}`;
  if (status === 401 || status === 403) return `${base} — check the API key in Settings.`;
  if (status === 404) return `${base} — check the model name in Settings.`;
  if (status === 429) return `${base} (rate limited, try again soon)`;
  return base;
}

// Reads an SSE body, splitting events on blank lines and handing each
// `data:` line to onData. onData returning false stops the stream early.
async function streamSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    const events = buf.split('\n\n');
    buf = events.pop() || '';

    let stop = false;
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data && onData(data) === false) { stop = true; break; }
      }
      if (stop) break;
    }
    if (stop) break;
  }
}

// Kept simple: strings only, merged so roles alternate.
function normalize(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m?.content ?? '').trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + content;
    else out.push({ role, content });
  }
  return out;
}

module.exports = { runChat, listModels, abortActive, userRepeatCount, rapidUserStreak, composeChatSystem, normalize, createReplyReader };
