## Kanna v0.1.5 — native capture, click precision, attach files

Since v0.1.4: native capture/input core, two-phase click verify, screen resolution in tool results, chat file attachments, OpenAI-compatible image support, and API key persistence hardening.

### Native capture + input core (nut-tree fork)
- `read_screen` now grabs the primary display via `@nut-tree-fork/libnut-win32` (~35 ms, true physical pixels, no DPI virtualization) instead of `desktopCapturer` (~2 s)
- Clicks land via native `moveMouse` + `mouseClick` — no PowerShell spawn, no console flash
- PowerShell helper kept as fallback; missing native binary degrades gracefully (`native core loaded | unavailable` logged at startup)
- `package.json` gains one runtime dep: `@nut-tree-fork/libnut-win32@^2.7.5`, `asarUnpack`ed for packaged builds

### Click precision (Phase 5c/5d follow-up)
- `use_click` is now two-phase: first call `{x,y}` draws a magenta crosshair on the retained screenshot for the model to verify against the target
- Confirm with `{"confirm": true}` to land the click, or correct `{x,y}` (max 3 corrections, then it clicks anyway)
- Marking needs no consent; verify round-trips are free chain slots (works even at Max-chain=1)
- After a real click lands, a post-click screenshot is returned so the model can see a miss and realign once (free correction slot)

### read_screen resolution
- Tool result now states the actual screenshot dimensions (`${imgW}×${imgH}`) so the model aims with exact pixel numbers even if the provider compresses the image
- Constitution rule updated: `use_click` first call returns the screenshot with a magenta crosshair instead of clicking — look at the marker before confirming

### Attach files (chat)
- Composer paperclip button, drag/drop, and paste add image and text attachments
- Chips show what's riding the message; cleared after send
- `attachFiles` glues images as provider-native content parts (OpenAI `image_url`, Anthropic blocks, Gemini `inlineData`) and text files as fenced blocks — one request only, never stored
- Caps: 4 images, 25 MB per file, 40 k chars of inlined text

### OpenAI-compatible image support
- Custom and OpenCode providers now accept images (screen screenshots + user attachments), same as OpenAI/Anthropic/Gemini
- `imageCapable` gate expanded to `openai/custom/opencode/anthropic/gemini`

### API key persistence fixes
- Renderer only sends provider blocks carrying a real key on save (empty blocks omitted)
- `merge()` never wipes a saved key with an empty string or non-string value
- `persist()` preserves existing non-empty keys from the disk file before writing
- `decrypt()` handles Electron builds where `safeStorage.decryptStringAsync` returns `{ shouldReEncrypt, result }` instead of a plain string — extracts `.result`
- Fixes keys vanishing on restart and `.trim()` crashes on stored key wrappers

### Installers
- `Kanna Setup 0.1.5.exe` — regular, CPU Piper voice server
