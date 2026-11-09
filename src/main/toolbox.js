'use strict';

// Toolbox — real desktop helpers the model can call. Phase 2 of the
// toolbox plan (design doc: %USERPROFILE%\.opencode\plan\toolbox.md):
// allowlist registry + first chained tools (time, weather). The model
// reaches tools through the reply protocol ("tool" key in its JSON, read
// by ai.js), and the agent loop in main.js runs the call and feeds the
// result back. Everything stays inside this allowlist — a tool name the
// model invents is rejected.

const log = require('./log');

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
  // No-arg apparats; later tools get per-tool schema checks in this slot.
  try {
    const result = await tool.run(args ?? {});
    const text = String(result?.text ?? result ?? '').slice(0, 800);
    log.info('[toolbox]', `used ${tool.name} args=${argStr}`);
    return { ok: true, text };
  } catch (err) {
    log.info('[toolbox]', `${tool.name} failed: ${err?.message || err}`);
    return { ok: false, text: `ERROR tool ${tool.name} failed: ${String(err?.message || err)}` };
  }
}

module.exports = { describeForPrompt, execute, has: byName };
