'use strict';

// Long-term memory: a small JSON file of durable facts the model elects to
// keep. After each completed chat turn, main asks the same configured
// provider for a compact JSON diff (add/remove) — nothing is stored unless
// the model judges something worth remembering. The user can inspect and
// clear the store from the settings drawer.

const app = require('electron').app;
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 60;
const MAX_KEY = 48;
const MAX_VALUE = 280;

let cachedFile = null;

function memoryFile() {
  if (!cachedFile) cachedFile = path.join(app.getPath('userData'), 'memory.json');
  return cachedFile;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(), 'utf8'));
    if (Array.isArray(raw?.entries)) return raw.entries;
  } catch {
    // fresh store
  }
  return [];
}

function save(entries) {
  fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
  fs.writeFileSync(memoryFile(), JSON.stringify({ entries }, null, 2), 'utf8');
}

function clearAll() {
  save([]);
  return load();
}

function removeEntry(key) {
  const entries = load().filter((e) => e.key !== key);
  save(entries);
  return entries;
}

// "- key: value" block injected into the chat system prompt ('' when empty).
function renderForPrompt() {
  const entries = load();
  if (!entries.length) return '';
  return entries.map((e) => `- ${e.key}: ${e.value}`).join('\n');
}

function applyOps(add, removeKeys) {
  let entries = load();

  for (const k of removeKeys) entries = entries.filter((e) => e.key !== k);

  for (const op of add) {
    const key = String(op?.key || '').trim().toLowerCase().slice(0, MAX_KEY);
    const value = String(op?.value || '').trim().slice(0, MAX_VALUE);
    if (!key || !value) continue;
    entries = entries.filter((e) => e.key !== key); // upsert by key
    entries.push({ key, value, ts: Date.now() });
  }

  entries.sort((a, b) => b.ts - a.ts);
  entries = entries.slice(0, MAX_ENTRIES);
  if (add.length || removeKeys.length) save(entries);
  return entries;
}

// Self-memory write (toolbox `remember`): upsert one durable fact the
// model chose to keep, with the same key rules as the extraction ops.
function addSelfNote(key, text) {
  const k = String(key || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, MAX_KEY);
  const value = String(text || '').trim().slice(0, MAX_VALUE);
  if (!k || !value) return { ok: false, text: 'nothing to remember (need a one-sentence fact)' };
  const entries = applyOps([{ key: k, value }], []);
  return { ok: true, key: k, value, count: entries.length };
}

const EXTRACTION_SYSTEM = [
  'You maintain a compact long-term memory store about the user for a desktop companion called Kanna.',
  'Given the current memory and the latest exchange, decide whether durable facts should be added or removed.',
  'Reply with ONLY compact JSON: {"add":[{"key":"short.id","value":"one sentence"}],"remove":["old.key"]}',
  'Rules:',
  '- keys: 1-4 lowercase words joined by dots, no spaces (e.g. user.name, projects.kanna)',
  '- remember stable facts only. Examples: names, preferences, ongoing projects, plans, important events, user corrections,...',
  '- never store passwords, API keys, tokens, or any other secrets',
  '- skip small talk, moods, and anything ephemeral',
  '- if nothing changed, reply just {}',
].join('\n');

function extractUserMessage(user, reply, entries) {
  const memoryText = entries.length
    ? entries.map((e) => `- ${e.key}: ${e.value}`).join('\n')
    : '(empty)';
  return [
    'Current memory entries:',
    memoryText,
    '',
    'The latest exchange with the user:',
    `User: ${String(user).trim().slice(0, 1000)}`,
    `Kanna: ${String(reply).trim().slice(0, 2000)}`,
    '',
    'Decide if anything durable changed. Reply with ONLY the JSON.',
  ].join('\n');
}

function parseOps(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let j;
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const add = Array.isArray(j?.add) ? j.add.slice(0, 5) : [];
  const remove = Array.isArray(j?.remove) ? j.remove.map((k) => String(k||'').trim()).filter(Boolean).slice(0, 10) : [];
  if (!add.length && !remove.length) return null;
  return { add, remove };
}

function worthRemembering(user, reply) {
  // Frequent mode: every real exchange can teach, so short turns like
  // "my cat's name is oli" are not skipped. Only tone out empty and
  // near-empty turns so 'ok'/'lol' don't wake the extractor model.
  return String(user || '').trim().length >= 10 && String(reply || '').trim().length >= 10;
}

const MAX_QUEUE = 3;
let inFlight = false;
let queue = [];

function scheduleRemember(userText, replyText) {
  if (!worthRemembering(userText, replyText)) return;
  if (inFlight) {
    // Keep room for fresh turns instead of overwriting the slot; when
    // full, drop the oldest since the extractor always reads only the
    // latest exchange anyway.
    const pair = [userText, replyText];
    if (!queue.length || queue[queue.length - 1][0] !== pair[0]) queue.push(pair);
    if (queue.length > MAX_QUEUE) queue.shift();
    return;
  }
  runRemember(userText, replyText);
}

async function runRemember(userText, replyText) {
  inFlight = true;
  try {
    // Lazy require: ai.js loads this module at startup too, so a top-level
    // require would be circular. By call time it is fully initialized.
    const { runChat } = require('./ai');

    const result = await runChat(
      [{ role: 'user', content: extractUserMessage(userText, replyText, load()) }],
      () => {},           // swallow stream events — the UI must never see this
      EXTRACTION_SYSTEM,
      // registerInActive: false — can't be aborted by the chat stop button.
      // plain: true — returns the raw JSON diff; the reply-protocol reader
      // must not unwrap it.
      { registerInActive: false, plain: true },
    );

    const ops = parseOps(result?.text);
    if (!ops) return;
    const entries = applyOps(ops.add, ops.remove);
    console.log('[memory]', `store updated (${entries.length} entries)`);
  } catch (err) {
    console.log('[memory]', 'extraction skipped:', err?.message || err);
  } finally {
    inFlight = false;
    if (queue.length) {
      const next = queue.shift();
      runRemember(next[0], next[1]);
    }
  }
}

module.exports = { load, clearAll, removeEntry, renderForPrompt, scheduleRemember, addSelfNote };
