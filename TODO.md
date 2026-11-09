# TODO

Backlog of things not built yet. Pick from the top when starting something new.

## Agentic — starts after the simple chat feature is finished

- [ ] **Kanna writes code into a real text editor** — code blocks already
  stay out of the bubble (a `⌘ lang · N lines — written to editor` chip
  appears instead). Next step, on finalize: if the reply contained fenced
  blocks, main writes each one to `%APPDATA%\Kanna\code\<n>.<ext>`
  (extension guessed from the fence tag), opens it with `shell.openPath` so
  the user's default editor picks it up, and the chip confirms. Chips are
  clickable to re-open their file later. The "writing…" state becomes the
  moment she types the file in — fs write while the model streams.

## Next candidates

- [x] **Installer sanity check** — `npm run dist` now runs end to end; a
  512×512 icon was generated from the happy emote (`assets/icon.png`,
  converted to .ico by electron-builder); the packaged app launches from
  `dist/win-unpacked/Kanna.exe` and the installer is `dist/Kanna Setup 0.1.0.exe`.
- [x] **TTS — she speaks her replies aloud (done; needs more testing)** — implemented: built-in
  `speechSynthesis`, cloud backends (ElevenLabs, OpenAI TTS, Azure Speech,
  Google Cloud TTS) and local Piper; provider/voice/rate/pitch config,
  encrypted keys, header mute toggle, speech-paced typing. Piper now loads a
  model from `resources/piper`, defaults to speaker `746`, and can run as a
  persistent local HTTP server (`resources/piper/piper_server.py`) for faster
  repeat synthesis, with `npm run piper:build` producing the optional
  `resources/piper/kanna-piper-server.exe`. Remaining polish: Piper checker
  diagnostics in Settings, crate/bundle cleanup, tune sync/timing, and tie
  rate/pitch/mood more closely to the reply's `speed`/mood fields.
- [x] **STT — push-to-talk (implemented via Python Vosk; needs more testing)** —
  mic button in header captures 16 kHz PCM in the renderer, streams it to
  the local Vosk server (`resources/stt/stt_server.py`), and inserts the
  final transcript into the composer. Partial results appear as toasts.

## Assistant / pet ideas (later)

- [ ] **Screen-aware reactions (opt-in)** — let Kanna capture a low-res
  screenshot on an explicit trigger or hotkey, send it to a vision-capable
  model, and react in character. Needs a visible capture indicator, strict
  opt-in, and blur/full-screen privacy controls.
- [ ] **Clipboard companion** — offer summarize/translate/explain/review
  actions when the clipboard changes, especially for pasted errors, links,
  JSON, or code.
- [ ] **Proactive check-ins** — suggest remembered tasks or follow-ups based on
  durable memory and time of day, with quiet hours and an easy mute/disable.
- [ ] **Action tools with confirmation** — safe explicit helpers such as
  opening files/URLs, searching notes, creating snippets, or changing
  settings; always show a confirmation chip before side effects.
- [ ] **Optional overlay pet window (settings toggle)** — a separate
  transparent, always-on-top sprite window walking along the bottom of the
  screen; click summons the chat window. Reinforces the pet feel but brings
  back a second-window lifecycle.
- [ ] **Lively in-window pet states** — idle animations, wandering/siting
  (sit/sleep), edge peeking, and reactions to long pauses without leaving the
  main window.
- [ ] **Active-window awareness (opt-in)** — position Kanna above/near the
  focused window using a native dependency and polled window rects. Privacy
  and performance implications need a clear opt-in.
- [ ] **Playful but harmless "dragging"** — let the pet appear to grab and
  drag an overlay-only object (plushie/icon/branch), not real OS windows.
- [ ] **Fall out of the stage when shaken too hard (overlay pet tie-in)** —
  if the user keeps rattling the window past the angry threshold, give
  Kanna a small random chance to comically "fall out" of the stage: the
  sprite tumbles off the bottom edge (spin + gravity easing), disappears
  for a few seconds, then climbs back up scowling. Requires the future
  overlay pet window / sprite layer (`assets/pet-model/` art is already
  reserved) or at least a canvas overlay on the main window; must stay
  scratch-free and reversible, and must never fire while she's busy.

## Protocol / hardening ideas

- [ ] **JSON mode where supported** — OpenAI-compatible endpoints often take
  `response_format: { type: 'json_object' }`; passing it would stop weak
  local models from breaking the reply protocol.
- [ ] **Extraction alias for failed providers** — if the memory-extraction
  request keeps failing on tiny models, consider letting the panel add/edit
  facts by hand.

## Deliberately not done (revisit only if asked)

- Full chat history persistence — memory is durable **facts** only, by
  design; history is in-memory and cleared on close.
- Pet / separate sprite window — tried, undone, then decided against in
  favor of the turn-box chat box (no second window at all).
- Maximize/resize handling — the window is fixed 340×400 (`resizable: false`,
  maximize button removed) on purpose.

## Completed recently (v0.1.3)

- [x] **Toolbox Phase 4 — tool usage log + per-tool switches** — every real
  tool run (success or failure) records `{ts, name, ok}` into
  `%APPDATA%\Kanna\toollog.json` (newest first, cap 120, written per run by
  `toolbox.recordToolUse`). History drawer gains tabs: **Chat** (as before)
  and **Tool log** — one row per run with date/time, tool name, ok/failed
  (failed rows strike the tool name), via the new `tools:log` handle +
  `window.kanna.toolLog()`. Settings → Tools gains **Tool switches
  (per tool)**: one checkbox per allowlisted tool fed by the new `tools:list`
  handle (`toolsForSettings()`), unchecked names land in
  `agent.disabledTools` on Save; main syncs the set on startup and on every
  settings save (`toolbox.setDisabledTools`) — disabled tools vanish from
  `describeForPrompt()` so the model never sees them, and the executor
  hard-refuses with a polite ERROR note if one slips through.


- [x] **Toolbox background timer tool** - new `timer` and `timer_cancel` tools: `timer` arms a background delay in minutes/seconds and returns immediately; on expiry main pushes `kanna:timerRinging`, which the renderer turns into a real user pseudo-turn `*Kanna's timer ringing*` (she can then use another tool or notify). Cancel stops pending timers. Stored in AGENTS.md and the tool registry.
- [x] **Toolbox Phase 3 — remember / background / hide** — three new
  allowlist tools in `src/main/toolbox.js`. `remember` self-writes ONE
  durable fact through new `memory.addSelfNote` (same key rules as the
  extraction ops, upsert, args `{text, key?}`); a regex gate at the
  executor rejects password/key/token-shaped text — the blocklist lives in
  code, not the prompt. `background` validates a numbered
  `assets/background/N.png` scene (no args = list scenes) and returns
  `applied`; main's new `applyToolEffects` pushes `kanna:background {index}`
  and the renderer swaps the stage art (CSSOM — CSP-safe), defaulting back
  to scene 1 on restart. `hide` ducks the window off the desktop
  (`win.hide()`, tray stays); main enforces the post-hide gate — no further
  tool executes that turn, the note says finish (she never summons herself;
  Ctrl+Shift+K belongs to the user). Per-tool arg validation in
  `execute`: required keys for arg tools, unknown-key rejection, no-arg
  tools reject anything beyond `{}`.

- [x] **Toolbox voice-sequenced chaining + silent passes** — the voice leads
  the chain now: each woven pass is dispatched whole to the renderer via
  `chat:passDone` {index, text, silent} and main awaits `kanna:chainResume`
  before running that pass's tool — she speaks each tool result one by one,
  next tool only after her voice finishes (~5 min safety ceiling per wait).
  Reader gains an optional `"silent": true` key (ai.js); `agent.silentTool`
  (default on, Settings → Tools toggle) lets an intermediate pass
  mark itself silent to skip its voice and continue mid-chain instantly —
  final reply never silent. Old `chat:pass` promote machinery removed
  (passDone replaces it); battery of resume paths: builtin speech ends via
  `onend` (then any clipped typewriter tail is painted), cloud providers
  resume after the audio `durationMs`, muted/silent/empty passes resume
  instantly. `chat:stop` also unwinds a mid-voice wait (cancels speech).

- [x] **Toolbox Phase 2 — weather tool + reply-per-tool chaining** — new
  `weather` tool in `src/main/toolbox.js` (wttr.in one-line lookup, no key,
  ~9 s abort window; executor is async). Chain loop in `chat:send`: every
  note-fed pass WEAVES the previous tool result into visible text and may
  carry the next tool call in the same reply (time → weather, capped by
  `agent.maxChain`). Each woven reply is its own chat turn — resolve
  carries `passes` + `notes`, the renderer pushes one assistant entry per
  pass with `*Waiting while Kanna uses her X tool…*` user-side notes in
  the gaps (shake-scene pattern), and `chat:pass` slides the finished pass
  into the small prior-turn slot before the next types. `bufferToolText`
  gains `'chain'` mode (hold + release even with a tool key); run #1 stays
  bridge-only (text dropped). Placeholder leak → whole pass dropped +
  recovery pass with the named tool. Prompt: small-model-friendly steps.

- [x] **Toolbox Phase 1 — agent mode core + time tool** — per the toolbox plan
  (`%USERPROFILE%\.opencode\plan\toolbox.md`): new `src/main/toolbox.js`
  registry/executor (allowlist, unknown-tool + oversized-args rejection,
  `[toolbox]` log lines), `time` tool (real date/time/day of week).
  Reply protocol gains an optional `"tool"` key — ai's reader extracts it
  with a balanced-brace scan at stream end (truncated tool = absent, raw
  fallback unaffected). `main.js` chat loop: one tool per turn → `chat:tool`
  toast → TOOL RESULT fed back → second pass with the real answer, typed
  into the same bubble. Settings → Tools → Agent mode toggle
  (`agent.enabled`, default OFF — no tools when off). 13 headless reader/
  executor tests green.

- [x] **Phase 5 — long-term affinity + mood debug panel** — per the plan's
  "memory + soul" section: `affect.affinity` (0–100, starts 30) persisted in
  `%APPDATA%\Kanna\affect.json` (debounced writes, flush on quit, load
  fallback to defaults). Scoring from real turns: sweet/praise/apology
  turns +1, grudge bumps (spam/shaken) −1, unkind −2, tease +0.5 unless
  she's fed up. Effect so far is deliberately small: the resting valence
  baseline tilts up to +0.10 (down to −0.04) with the score, so a warm
  relationship wakes up sunnier but never hijacks the model's own moods.
  Settings got a **Mood tab** (Phase 5 "report UI"): live snapshot
  (family, hold, intensity, valence/arousal/social, grudge/tone markers),
  affinity bar, "Reset mood" (keeps affinity) and "Reset affinity"
  (back to 30), auto-refreshing every 1.5 s while open.

- [x] **Phase 3 — `intensity` protocol addon** — per the mood-system plan:
  the model may add an optional `"intensity": 0-1` key to its JSON reply
  (0.2 subtle → 1 overwhelming). `ai.js` parses it mid-stream and emits it
  on `chat:meta` (`intensity?`); `affect.js` stores it as
  `modelIntensity` and the snapshot prefers it over the computed one.
  The renderer now consumes it (previously dropped): `liveIntensity`
  drives three face-scale bands (`i-low` 0.96 / `i-mid` 0.99 /
  `i-high` 1.04 sprite classes), reset to the mid 0.5 band each turn.
  Fallback behavior (documented in AGENTS.md): replies without the key —
  or plain-text fallbacks — leave the face in the mid band and let the
  affect engine's valence/arousal-based snapshot intensity stand in;
  nothing required, nothing breaks.

- [x] **Shake → freeze → AI reaction flow** — a finished shake burst now
  freezes the window in place (each `move` event is undone immediately,
  which also breaks the user's drag), toasts
  "Position locked until I settle…", and asks the model: main sends
  `kanna:shakeAsk` with a hidden scene prompt (shake count, dizzy 1–3 /
  angry 4+, run with `noTriggers:true` so the synthetic prompt can't
  pollute tone/repeat detection; the renderer's last 24 chat messages
  ride along so the reaction is grounded in the ongoing conversation and
  reads continuous), streaming through the normal
  `chat:chunk`/`chat:meta` channels. The renderer runs it as a full turn
  (dots → mood face from the model's own meta → text typed out paced to
  TTS). When typing + voice are done it calls `kanna:unfreeze`; main
  releases the position and pushes `kanna:freezeOff` → "position
  unfrozen" toast. Safety bits: `FREEZE_MAX_MS` 90 s auto-unfreeze,
  hidden-window instant unfreeze, absence of model/crashes fall back to
  the canned dizzy/angry pool, composer state restored after the
  takeover, `busy` shakes defer to the running reply with a toast.

- [x] **Shake reaction** — main counts window-drag direction reversals
  (amplitudes ≥ 14 px within a 600 ms burst, either axis). After the burst
  settles: 1–3 shakes → `dizzy` face + canned line, >3 → `angry` + sterner
  line, pushed as `kanna:shake` (new preload bridge `onShake`) and played
  through the shared `playCanned` stage path (face → TTS-paced typing →
  mood flash). 6 s cooldown between reactions; mood observed into the
  affect engine. Shakes ≥ 8 now flirt with the TODO's future "fall out of
  the stage" gag.
- [x] **Renderer canned-speech refactor** — `sayWelcomeBack` and shake
  reactions share one `playCanned(g)` routine (welcome-back fetches its
  line first; shake lines arrive pushed from main).

- [x] **Welcome-back greeter (AFK detection)** — renderer tracks
  pointer/key/focus activity; a return after ≥5 min pings `kanna:back`
  (new IPC + preload bridge) and new `src/main/welcome.js` answers with a
  canned line + mood sized to the silence: ≥5 min `bored`, ≥30 min
  `happy`, ≥90 min `teasing`, ≥4 h `sad` (hurt-pouty), ≥12 h `shy`
  (overnight). No model call — instant, works with no provider set,
  6 lines per tier with no-repeat, `{name}` splices the remembered user
  name from memory.json. Greeting plays through the normal reply stage
  (face → typed text paced to TTS → mood flash) and is observed into the
  affect engine (`[affect] back:`) so the next model turn inherits the
  reunion feeling. Skipped when busy/composer-open; never pushed into
  model history.
- [x] **`assets/pet-model/` reserved** — sprite art for Kanna living
  outside the stage window later (`animated/lay.webp`, `animated/walk.webp`,
  `static/sleep.png`); documented for the future overlay pet, no wiring yet.

- [x] **New emotes: teasing + bored, dozing still** — two new emote pairs
  (`teasing`, `bored`, with `-speak` variants) wired into `EMOTES`,
  `MOOD_ALIASES`, the keyword `MOOD_RULES` fallback, the protocol's mood
  list, and the affect engine (`MOOD_DIMS` + `FAMILY_ALIASES`; teaser
  words like `smirk`/`mischievous` → teasing, `meh`/`unimpressed`/`sleepy`
  → bored). Non-mood art lives in `assets/still/`: after ~3 min idle
  (nothing held, not busy) the renderer shows `assets/still/sleep.png`;
  any pointer/key activity or new turn wakes her back to neutral.
  Tone-note for user teasing now suggests the `teasing` mood.

- [x] **Mood system — model directs the mood (history-aware)** — every chat
  system prompt now carries a standing `Emotional direction` block: the
  model judges mood from the whole recent history (not per-message), keeps
  `hold` for lingering feelings, and can optionally write
  `"intensity": 0-1` (parsed in the reply reader, feeds
  `affect.state.modelIntensity` for snapshot/TTS use). A one-line
  `Feeling carried over from previous turns: …` (`affect.moodCarry()`)
  gives the model continuity: current family, held flag, and active
  irritation level/kind.
- [x] **Mood system — broader spam detection** — `userRepeatCount` now
  normalizes hard (case/whitespace/punctuation/emoji stripped, letter-runs
  like `hiiii`→`hi` collapsed) and applies a Levenshtein ratio ≥ 0.7 so
  near-variants ("why did you say that" vs "WHY DID YOU SAY THAT…!").
  New `rapidUserStreak` catches the other shape: ≥ 3 unanswered user
  messages in a row (`noteFlood`) — different content still counts, style
  note differs (flustered "one at a time!" vs exasperated "stop flooding
  me"). Repeat and flood share one irritation pool; only escalation moves
  the dimensions.

- [x] **Mood system — Phase 2 trigger #2 (emotional tone read)** —
  `noteUserTone` in `src/main/affect.js` keyword-reads the user's latest
  message (unkind / affectionate / apology / tease / praise, incl. hearts,
  `<3`, `:3`; severity-ordered so unkind beats sweet). Each tone nudges
  valence/arousal/social plus emits a level-matched in-character style note
  (sweet → shy/happy flustered, mean → hurt sad, sorry → warm forgiveness,
  tease → pouting comeback, praise → beaming happy). Tones cool one level
  per turn, and `beginTurn`/`noteRepeat`/`noteUserTone` are all skipped for
  memory-extraction chat runs (`plain: true`) so her mood isn't polluted
  by background calls.

- [x] **Mood system — Phase 2 first trigger (repeat-spam annoyance)** —
  consecutive identical user messages (case/whitespace-normalized, 3+ in a
  row) raise Kanna's annoyance level (1–3, capped) in `src/main/affect.js`:
  internal valence/arousal nudge plus a level-matched style note injected
  into the system prompt so she visibly calls it out in character
  (strained → fed-up → angry). Annoyance cools one level per turn without
  repeats. `[affect] repeat xN` log line per escalation.

- [x] **Mood system — Phase 1 (affect engine)** — new `src/main/affect.js`:
  internal valence/arousal/socialEnergy per emote family, blend toward the
  model's chosen mood with per-turn jump caps, time decay back to the neutral
  baseline (held moods decay slower), alias table for loose mood words
  (`furious`, `cheerful`, …), stop/interrupt nudges, and `[affect]` log lines
  for every family transition + one turn-end snapshot line. In-memory only —
  reply protocol, `chat:meta`, and the 8 emote pairs are unchanged (renderer
  untouched). Phase 2 (trigger priorities, error stress, persistent affinity)
  still to do.

- [x] **Packaging split** — `npm run dist:all` cleans `dist/`, then builds normal Piper + app + CUDA Piper + CUDA app. Installers: `Kanna Setup X.Y.Z.exe` and `Kanna-Setup-X.Y.Z-cuda.exe`.
- [x] **Piper GPU (NVIDIA)** — `--gpu` flag with CUDA/cuDNN staged via `_add_cuda_dll_dirs()`; Settings → Voice **Piper GPU** checkbox (`tts.piperUseGpu`); server stops on save and the next speak rebuilds it with refreshed flags.
- [x] **File logging** — rotating `kanna.log` under `%APPDATA%\Kanna\logs`, including startup snapshot, server lifecycle (with deliberate-stop vs. crash distinction), IPC traces, and global exception/rejection handlers.
- [x] **One-file CUDA EXE** — isolated `.opencode/cuda-venv` with onnxruntime-gpu (CUDA execution provider verified via nvidia-smi).