# Kanna 🦊

![Kanna](./assets/README/1.png)
A tiny desktop AI companion built with Electron. Kanna lives in a small window,
reacts to her own replies with expressions, and you can chat with her through
your choice of AI provider.

## Features

- **Simple chat** — streaming replies, Enter to send, Shift+Enter for a newline,
  and a stop button that interrupts Kanna mid-sentence.
- **Every emotion has an emote** — Kanna swaps between `assets/emotes/` artwork:
  a `-speak` variant while her reply streams in, then a mood-matched idle face
  (naive keyword-based mood detection) before settling back to neutral.
- **Settings drawer** — pick your AI provider, store its API key, model and
  (for custom endpoints) base URL, and edit the persona/system prompt.
- **Provider support**
  - OpenAI
  - Anthropic (Claude)
  - Google (Gemini)
  - Any OpenAI-compatible endpoint (OpenRouter, LM Studio, Ollama, …)
  - OpenCode (the opencode.ai gateway — GLM, Kimi, Qwen, Claude, GPT and
    friends, with some free models; pay-as-you-go key from the console)
- **Fetch models ↻** — the Brain tab can pull the live model list for the
  selected provider into a type-ahead list, so model IDs no longer have to
  be typed from memory.
- Per-provider keys/model are remembered separately, so switching providers
  keeps each one configured.
- **Keys are encrypted at rest** — API keys in `settings.json` are sealed
  with your OS account (safeStorage → DPAPI on Windows), decrypted only in
  memory. Existing plaintext keys migrate automatically on first launch.
- **Remembers where she lives** — the window reopens where you last dragged
  it (saved to settings.json), clamped to whichever screen is connected, so
  an unplugged monitor can't strand her offscreen.
- **Tray + summon hotkey** — she lives in the notification area
  (assets/icon.ico): clicking the tray raises her, Ctrl+Shift+K works from
  anywhere. The ✕ button hides her to the tray — **Quit only via the tray
  menu**, so chats and streaming survive accidental closes.
- **Turn-box chat** — one bordered box carries the exchange: her current
  reply fills it big (scrolling inside, no scrollbar), the other half of the
  exchange sits small on top. Clicking the very bottom of the box opens the
  composer *inside* the box — her reply pushes to the small top line, your
  last message takes the big spot — and while she's streaming the same click
  interrupts her. After you send, your message becomes the top line and her
  reply streams into the big spot. The 🕘 History tab in the header opens the
  full in-memory session log, older turns included.
- **Long-term memory** — after each turn, Kanna runs a quiet background
  request to the same provider asking "did anything durable just change?",
  and stores the answers as short facts in `memory.json` (never secrets).
  The facts ride along with every new conversation's system prompt, and you
  can inspect/clear them in ⚙ Settings → Memory.
- **Agent mode / Tools tab** - optional toolbox lives under Settings -> Tools: Agent mode on/off, a 1-5 "Max chained tools per turn" slider, per-tool switches (time, weather, remember, background, hide, timer, timer_cancel, etc.), Silent chaining toggle, and a Tool log in the History drawer. Off by default; timer results wake a follow-up "*Kanna's timer ringing*" turn.

- **Speech-to-text** — 🎤 in the composer transcribes locally with
  Vosk (click to talk, click again to insert); final text lands in the input
  as if typed.
- **Text-to-speech** — Kanna can speak her replies: built-in OS voices
  (`speechSynthesis`), cloud engines (ElevenLabs, OpenAI TTS, Azure Speech,
  Google Cloud TTS), or local Piper (default model `resources/piper/en_US.onnx`,
  downloaded from the [piper-voices `en_US` libritts-high voice](
  https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/libritts/high),
  speaker `746`). Piper prefers a persistent local HTTP server for speed and,
  if present, the optional `kanna-piper-server.exe` bundle. Pick the
  provider/voice/rate/pitch in ⚙ Settings → Voice, test Piper there, mute from
  the header toggle, and reply typing is paced to the spoken duration.
- **Mood + speech speed, decided by the model** — every reply is one JSON
  object `{"mood":"…","speed":…,"hold":…,"text":"…"}`. The mood picks which
  of the 10 emotes she wears (set *before* she starts talking), speed scales
  the typing pace (0.7 hushed → 1.8 excited), and `hold: true` keeps that
  emotion on her face across turns instead of easing back to neutral after
  a few seconds. Replies that don't follow the protocol degrade gracefully
  to plain text with keyword-based moods.
- **Optional NVIDIA GPU acceleration** — an NVIDIA-only
  `Kanna-Setup-*-cuda.exe` installer ships a CUDA-enabled Piper server (the
  **Piper GPU** checkbox in ⚙ Settings → Voice switches synthesis onto the
  GPU; falls back to CPU when drivers or the CUDA runtime are missing, and
  the server only restarts with the next spoken message).
- **Diagnostics** — a packaged app writes to `%APPDATA%\Kanna\logs\kanna.log`
  (rotating, ~1 MB) for startup snapshot, server lifecycle, and IPC traces.

## Quick start

```powershell
npm install
npm start
```

The app opens in development mode with default settings, then:

1. Click the ⚙ button (or let Kanna nudge you) to open Settings.
2. Choose a provider, paste its API key, adjust the model/persona, Save.
3. Chat away.

Conversations are kept in memory only — closing the window clears the chat.
Settings persist across launches. For the offline voice stack (Piper TTS +
Vosk STT) see [Packaging](#packaging--from-python-packages-to-the-electron-build).

## Where settings live

`%APPDATA%\Kanna\settings.json` (created on first save), holding the provider
choice, per-provider keys/models, the persona, and the custom base URL.
Keys (AI and TTS) are encrypted at rest on this device with
Electron's `safeStorage` (DPAPI on Windows) and decrypted only in memory;
plaintext keys from older installs migrate automatically. They are never
sent anywhere except to the provider you chose.

## Packaging — from Python packages to the Electron build

Kanna's local voice stack uses prepared artifacts, not npm modules: the
Piper/STT servers are plain Python sources and the optional
`kanna-piper-server.exe` freezes them with PyInstaller; electron-builder then
packs the Electron app around them.

### 1. Python prerequisites

```powershell
py -3 -m pip install piper-tts onnxruntime vosk PyInstaller
```

- `piper-tts` + `onnxruntime` — the Piper TTS server (`resources/piper/piper_server.py`).
- `vosk` — the local STT server (`resources/stt/stt_server.py`).
- `PyInstaller` — builds the freezeable Piper server (step 3).

Optional — NVIDIA GPU acceleration for Piper. Note that `piper-tts` offers no
`onnx-cuda` extra in current versions; the CUDA bits come from onnxruntime
wheels (plus the NVIDIA runtime DLLs, which the server stages itself):

```powershell
py -3 -m pip install onnxruntime-gpu nvidia-cuda-runtime nvidia-cublas nvidia-cudnn-cu13
```

With those wheels installed, Settings → Voice → **Piper GPU** makes synthesis
run on the GPU; when drivers or the CUDA runtime are missing, the server falls
back to CPU. No Python at all? The **CUDA installer** (`npm run dist:cuda`,
step 4) bundles the GPU-capable server.

### 2. Piper voice model (~130 MB, never committed)

Download the `en_US-high` voice from the
[piper-voices libritts/high tree](
https://huggingface.co/rhasspy/piper-voices/tree/c10ece1aade47bb51c153c893d14e5bf8e5b7117/en/en_US/libritts/high)
— grab both the `.onnx` and its `.onnx.json`, drop them into
`resources/piper/` as `en_US.onnx` + `en_US.onnx.json`. They stay unnamed
exactly like this; the build packs them unmodified, so the Windows
installer ships them and end users get offline speech out of the box.
Git ignores them (never commit a 130 MB model), but that only guards git —
electron-builder still packs local files.

### 3. Freeze the Python servers into executables (optional but recommended)

```powershell
npm run piper:build      # → resources/piper/kanna-piper-server.exe (CPU, uses the system Python)
npm run stt:build        # → resources/stt/kanna-stt-server.exe
```

Both run PyInstaller against the server scripts; the exes are gitignored.
With them present, Piper and STT run with **no system Python at all**;
without them, the app spawns the Python interpreter from step 1 instead.

#### CUDA Piper build (separate venv)

The GPU-capable Piper exe must be frozen from an environment that has the
CUDA onnxruntime wheel, so it builds in its own venv — the normal exe stays
CPU-only and reproducible:

```powershell
py -3 -m venv .opencode\cuda-venv
.opencode\cuda-venv\Scripts\python.exe -m pip install piper-tts onnxruntime-gpu
npm run piper:build:cuda # → .opencode/cuda/kanna-piper-server-cuda.exe
```

### 4. Electron build

```powershell
npm install
npm run dist             # normal installer -> dist/"Kanna Setup <version>.exe"
npm run dist:cuda        # CUDA installer  -> dist/Kanna-Setup-<version>-cuda.exe
npm run dist:all         # clean + piper normal + app + piper CUDA + app CUDA
npm run dist -- --win    # explicit Windows target
```

`npm run dist:cuda` (`scripts/dist-cuda.js`) swaps the frozen Piper exe for
the CUDA build, runs electron-builder with `-cuda` appended to the artifact
name, then restores the normal exe. **Run `npm run dist` first** — the CUDA
build only repackages, and both installers must exist in `dist/`.

`resources/piper/**` and `resources/stt/**` are `asarUnpack`ed, so the
installed app finds the exe, the model, and the server scripts outside
`app.asar` and can spawn them.

## Project structure

```
src/
  main/      Electron main process
    main.js       window + IPC wiring
    settings.js   settings store (defaults, merge, persistence)
    ai.js         provider adapters + SSE streaming
    tts.js        TTS backends (cloud + Piper) via main process
    memory.js     long-term memory store + extraction
  preload/
    preload.js    contextBridge API (window.kanna)
  renderer/
    index.html    layout (header, stage, chat, settings drawer)
    style.css     theme
    renderer.js   chat + emote/mood logic
    settings.js   settings drawer logic
assets/        emote pairs + background art
```

## Build

```bash
npm run dist
```

Produces `dist/Kanna Setup 0.1.0.exe` (NSIS installer) plus `dist/win-unpacked/`
(the unpacked app, handy for a quick smoke test). The tray/window icon is
`assets/icon.ico` (32×32); the installer icon is `assets/icon.png` (512×512,
generated from the happy emote).

- Requests run in the main process (no CORS headaches), stream over IPC, and
  can be aborted.
- API/TTS keys are stored encrypted in `settings.json`; treat the file like a
  `.env`.
