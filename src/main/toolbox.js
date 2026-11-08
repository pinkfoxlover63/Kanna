'use strict';

// Toolbox — real desktop helpers the model can call. Phase 1 of the
// toolbox plan (design doc: %USERPROFILE%\.opencode\plan\toolbox.md).
// Registry + executor only: the model reaches tools through the reply
// protocol ("tool" key in its JSON, read by ai.js), and the agent loop
// in main.js runs the call and feeds the result back. Everything stays
// inside this allowlist — a tool name the model invents is rejected.

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

// Strict allowlist. Every tool: name, description, arg shape, run().
const TOOLS = [
  {
    name: 'time',
    description: 'today\'s date and time (day of week included) — use when the question needs real world time you cannot know',
    args: { type: 'object', properties: {}, additionalProperties: false },
    run: describeNow,
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
// for the model (never for direct display; the model phrases it).
function execute(name, args) {
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
  // Phase 1 tools take no args; later tools get per-tool schema checks
  // in this slot.
  try {
    const result = tool.run(args ?? {});
    const text = String(result?.text ?? result ?? '').slice(0, 800);
    log.info('[toolbox]', `used ${tool.name} args=${argStr}`);
    return { ok: true, text };
  } catch (err) {
    log.info('[toolbox]', `${tool.name} failed: ${err?.message || err}`);
    return { ok: false, text: `ERROR tool ${tool.name} failed: ${String(err?.message || err)}` };
  }
}

module.exports = { describeForPrompt, execute, has: byName };
