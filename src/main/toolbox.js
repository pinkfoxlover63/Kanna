'use strict';

// Toolbox — real desktop helpers the model can call. Phase 2 of the
// toolbox plan (design doc: %USERPROFILE%\.opencode\plan\toolbox.md):
// allowlist registry + first chained tools (time, weather). The model
// reaches tools through the reply protocol ("tool" key in its JSON, read
// by ai.js), and the agent loop in main.js runs the call and feeds the
// result back. Everything stays inside this allowlist — a tool name the
// model invents is rejected.

const fs = require('fs');
const path = require('path');
const log = require('./log');
const memory = require('./memory');

// Current date/time, phrased for a reply the user can act on.
function describeNow() {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const time = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return { text: `It is ${date}. Clock says ${time}.` };
}

// Current weather near the user via wttr.in (free, no key; a one-line
// format keeps the result small for the prompt). City is derived from the
// network IP on the service side — good enough for "what's it like out".
const WEATHER_FORMAT = '%l: %t, %C (wind %w), humidity %h';

async function describeWeather() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch('https://wttr.in/?format=' + encodeURIComponent(WEATHER_FORMAT), {
      signal: ac.signal,
      headers: { 'User-Agent': 'Kanna/0.1 desktop companion' },
    });
    if (!res.ok) {
      return { ok: false, text: `weather check failed (service said ${res.status})` };
    }
    const body = (await res.text()).replace(/\s+/g, ' ').trim();
    if (!body) return { ok: false, text: 'weather check returned nothing' };
    return { ok: true, text: `Weather right now: ${body}.` };
  } catch (err) {
    return { ok: false, text: `weather check failed: ${String(err?.message || err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- Phase 3 tools: background scene, hide, self-memory write ---------------

// Numbered png scenes in assets/background. The renderer swaps the CSS on
// the stage; this tool only validates the scene id (main applies it).
const BG_DIR = path.join(__dirname, '..', '..', 'assets', 'background');

function listBackgroundScenes() {
  try {
    return fs.readdirSync(BG_DIR)
      .map((f) => (/^(\d+)\.png$/i.exec(f) || [])[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function runBackground(args) {
  const scenes = listBackgroundScenes();
  if (!scenes.length) return { text: 'no background scenes are installed' };
  const idx = Number(args?.index);
  const list = scenes.join(', ');
  if (!Number.isFinite(idx) || !scenes.includes(idx)) {
    return { text: `backgrounds available: ${list}. Call with {"index": N} to change it; the art behind her swaps right away.` };
  }
  // `applied` is the hard signal for main to push kanna:background.
  return { ok: true, applied: idx, text: `scene ${idx} of ${list} is set — describe the change in your own words.` };
}

// Self-memory write; the allowlist tier stays out of secrets at the gate
// (this regex pass), not in the prompt.
// Self-memory write; the allowlist tier stays out of secrets at the gate
// (this regex pass), not in the prompt.
const SECRET_RE = /\b(?:sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|gho_[A-Za-z0-9]|ghs_[A-Za-z0-9]|ghr_[A-Za-z0-9]|AKIA[A-Z0-9]|xoxb-|xoxp-|-----BEGIN [A-Z ]*PRIVATE KEY)/;

function runRemember(args) {
  const text = String(args?.text || '');
  if (SECRET_RE.test(text) || /(?:password|api[\s_-]?key|token)\s*[:=]/i.test(text)) {
    return { text: 'ERROR never store passwords, keys or tokens in memory — remember stable personal facts only.' };
  }
  const r = memory.addSelfNote(args?.key, text);
  if (!r.ok) return r;
  return { text: `noted in her long-term memory as "${r.key}" (${r.count} fact${r.count === 1 ? '' : 's'} now) — react as if she chose to keep it.` };
}

// Hide: she ducks away mid-chat — window off the desktop (tray stays).
// Main applies the visibility change after the result returns; the tool
// result itself tells the model to sign off instead of chaining on.
function runHide() {
  return { text: 'she slipped away — her window is off the desktop now and only the user can summon her back with Ctrl+Shift+K. Finish this reply as if excusing yourself to rest; call no further tools.' };
}

// Strict allowlist. Every tool: name, description, arg shape, run().
const TOOLS = [
  {
    name: 'time',
    description: 'today\'s date and time (day of week included) — use when the question needs real world time you cannot know',
    args: { type: 'object', properties: {}, additionalProperties: false },
    run: describeNow,
  },
  {
    name: 'weather',
    description: 'current weather near the user — city, temperature, sky condition, wind, humidity; use when asked how the weather/temperature/rain is',
    args: { type: 'object', properties: {}, additionalProperties: false },
    run: describeWeather,
  },
  {
    name: 'remember',
    description: 'write ONE durable fact about the user into her own long-term memory — args {"text": "one short fact sentence"} (optional "key": "short.id" like clothes.style)',
    args: { type: 'object', properties: { text: { type: 'string' }, key: { type: 'string' } }, required: ['text'], additionalProperties: false },
    run: runRemember,
  },
  {
    name: 'background',
    description: 'swap the desktop wallpaper scene behind her — call with no args to list scenes, or {"index": N}',
    args: { type: 'object', properties: { index: { type: 'number' } }, additionalProperties: false },
    run: runBackground,
  },
  {
    name: 'hide',
    description: 'duck away and hide her window from the desktop (she rests); nothing follows it — the user summons her back with Ctrl+Shift+K',
    args: { type: 'object', properties: {}, additionalProperties: false },
    run: runHide,
  },
];

function byName(name) {
  return TOOLS.find((t) => t.name === String(name || '').trim());
}

// One line per tool for the system prompt's toolbox block.
function describeForPrompt() {
  return TOOLS.map((t) => `- ${t.name}: ${t.description}`).join('\n');
}

// Validate then run. Returns { ok, text } — `text` is the tool's result
// for the model (never for direct display; the model phrases it). Async:
// some tools fetch real data.
async function execute(name, args) {
  const tool = byName(name);
  if (!tool) {
    log.info('[toolbox]', `unknown tool requested: ${String(name)}`);
    return { ok: false, text: `ERROR unknown tool "${String(name)}" — valid: ${TOOLS.map((t) => t.name).join(', ')}` };
  }
  const argStr = JSON.stringify(args ?? {});
  if (argStr.length > 512) {
    log.info('[toolbox]', `args too large for ${tool.name}`);
    return { ok: false, text: 'ERROR tool args too large (512 char limit)' };
  }
  // Per-tool schema checks: args tools declare `required` and reject
  // unknown keys; no-arg tools reject anything beyond {}.
  const schemaChecks = [];
  if (tool.args?.required) {
    for (const keyName of tool.args.required) {
      const v = args?.[keyName];
      schemaChecks.push(v !== undefined && v !== null && String(v).trim() !== ''
        ? null
        : `ERROR tool ${tool.name} needs "${keyName}" in args — example: ${tool.name === 'remember' ? '{"text": "she prefers tea over coffee"}' : '{"index": 1}'}`);
    }
  }
  if (tool.args?.properties && Object.keys(tool.args.properties).length) {
    const extras = tool.args.additionalProperties === false
      ? Object.keys(args ?? {}).filter((k) => !tool.args.properties[k])
      : [];
    schemaChecks.push(extras.length
      ? `ERROR tool ${tool.name} got unknown arg keys (${extras.join(', ')}) — accepts: ${Object.keys(tool.args.properties).join(', ')}`
      : null);
  } else {
    const hasArgs = args && Object.keys(args).length > 0;
    schemaChecks.push(hasArgs ? `ERROR tool ${tool.name} takes no arguments (pass {})` : null);
  }
  const schemaErr = schemaChecks.find(Boolean);
  if (schemaErr) {
    log.info('[toolbox]', `bad args for ${tool.name}: argStr=${argStr}`);
    return { ok: false, text: schemaErr };
  }
  try {
    const result = await tool.run(args ?? {});
    const text = String(result?.text ?? result ?? '').slice(0, 800);
    log.info('[toolbox]', `used ${tool.name} args=${argStr}`);
    return { ok: result?.ok !== false, applied: result?.applied, text };
  } catch (err) {
    log.info('[toolbox]', `${tool.name} failed: ${err?.message || err}`);
    return { ok: false, text: `ERROR tool ${tool.name} failed: ${String(err?.message || err)}` };
  }
}

module.exports = { describeForPrompt, execute, has: byName };
