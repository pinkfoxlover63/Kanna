'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut } = require('electron');
const path = require('node:path');

const settings = require('./settings');
const ai = require('./ai');
const tts = require('./tts');
const stt = require('./stt');
const log = require('./log');
const affect = require('./affect');
const welcome = require('./welcome');
const toolbox = require('./toolbox');

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content || '');
  }
  return '';
}
const memory = require('./memory');

let win = null;
let tray = null;
let isQuitting = false;

function toggleDevTools() {
  if (!win) return;
  const wc = win.webContents;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

function kannaIconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'icon.ico');
}

// Bring her up however she was last left (hidden to tray, minimized…).
function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Tray: a presence in the corner, the summon target, and the only Quit that
// means it — closing the window hides her here instead of exiting.
function setupTray() {
  try {
    tray = new Tray(kannaIconPath());
  } catch (err) {
    console.log('[tray]', 'could not load the tray icon:', err?.message || err);
    return;
  }
  tray.setToolTip('Kanna');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Kanna', click: showWindow },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// Global summon hotkey: Ctrl+Shift+K (Cmd+Shift+K on macOS builds).
function setupSummonHotkey() {
  const ok = globalShortcut.register('CommandOrControl+Shift+K', showWindow);
  if (!ok) console.log('[hotkey]', 'Ctrl+Shift+K is taken by another app — no summon shortcut');
}

// Dev menus are handy for hacking on the UI live; the menubar stays hidden
// behind autoHideMenuBar (press Alt to see it), accelerators work regardless.
function setupMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { label: 'Developer tools', accelerator: 'F12', click: () => toggleDevTools() },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// Restores a saved position only if the window would still sit fully on a
// connected screen — unplugged monitors must not strand her offscreen.
// { x: null } means "let the OS center it".
function sanePosition(saved) {
  const W = 340;
  const H = 400;
  const x = Number(saved?.x);
  const y = Number(saved?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: null, y: null };
  const { screen } = require('electron');
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    if (x >= a.x && x + W <= a.x + a.width && y >= a.y && y + H <= a.y + a.height) {
      return { x, y };
    }
  }
  return { x: null, y: null };
}

async function createWindow() {
  const pos = sanePosition((await settings.getSettings()).window);

  win = new BrowserWindow({
    width: 340,
    height: 400,
    resizable: false,
    title: 'Kanna',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    icon: kannaIconPath(),
    // Saved position wins when sane; otherwise the OS decides.
    ...(Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (event) => {
    console.log('[renderer]', event.message ?? '');
  });

  // Developer loop: plain Ctrl+R/F5 must always re-read renderer files from
  // disk — file:// stylesheets otherwise get served stale from the cache.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrlR = (input.control || input.meta) && !input.alt
      && input.key.toLowerCase() === 'r';
    if (ctrlR || input.key === 'F5') {
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
    }
  });

  if (!app.isPackaged) win.webContents.session.clearCache();

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Persist where she ends up — debounced so a drag writes once, and a
  // final flush on close so a quick "drag then hide" keeps too.
  let moveTimer = null;
  const savePosition = () => {
    clearTimeout(moveTimer);
    moveTimer = null;
    if (!win || win.isDestroyed() || isQuitting) return;
    const [x, y] = win.getPosition();
    settings.save({ window: { x, y } })
      .catch((err) => console.log('[window]', 'position save failed:', err?.message || err));
  };

  // --- shake detector -------------------------------------------------------
  // Grabbing and rattling the window (rapid back-and-forth drags) is its own
  // kind of user attention. Each completed swing adds to the shake count
  // weighted by how far Kanna was flung: gentle ripples add 1, firmer
  // swings 2, violent ones 3 — so hard shakes escalate fast, soft rattling
  // builds slowly. The burst totals up only when she stops shaking: a quiet
  // gap closes it, and the mood comes from the weighted count (dizzy 1–3,
  // angry past that). Cooldown keeps repeated rattling from spamming.
  const SHAKE_AMP = 14;      // px sample-to-sample swing that closes a swing
  const SHAKE_QUIET = 600;   // ms of stillness that ends a shake burst
  const SHAKE_W2 = 60;       // swing span (px) ≥ this → weight 2
  const SHAKE_W3 = 140;      // swing span (px) ≥ this → weight 3
  const SHAKE_COOLDOWN = 6000; // ms after a reaction before the next one fires
  const FREEZE_MAX_MS = 90_000; // safety: never stay frozen past this
  const WIN_W = 340;         // matches createWindow — re-asserted while frozen
  const WIN_H = 400;         // because setPosition during an active drag-loop
                             // can let the window rect drift/grow on Windows.
  const shake = {
    x: null, y: null,
    axX: { dir: 0, travel: 0 }, axY: { dir: 0, travel: 0 },
    count: 0, flips: 0,
    lastAt: 0, quietTimer: null, cooldownUntil: 0, freezeTimer: null,
  };
  let frozenShake = null;    // { x, y, shakes } while the window can't be moved
  let repositioning = false; // guards recursion from our own setPosition

  // Weight tier for a completed swing: distance traveled since the last
  // decisive reversal decides how hard that rattle gets counted.
  function swingWeight(span) {
    if (span >= SHAKE_W3) return 3;
    if (span >= SHAKE_W2) return 2;
    return 1;
  }

  function feedAxis(a, dx) {
    if (!dx) return;
    const s = Math.sign(dx);
    if (a.dir === 0) { a.dir = s; a.travel = 0; return; }
    if (s === a.dir) { a.travel += Math.abs(dx); return; }
    if (Math.abs(dx) < SHAKE_AMP) return; // micro-wobble — wait for a real reversal
    // Decisive reversal: the previous swing is complete. Weight it by the
    // distance traveled across it (both legs best-effort at ±1 sample).
    const span = a.travel + Math.abs(dx);
    a.dir = s;
    a.travel = Math.abs(dx);
    if (span >= SHAKE_AMP) {
      shake.count += swingWeight(span);
      shake.flips++;
    }
  }

  function shakeSample(x, y) {
    const now = Date.now();
    if (shake.x !== null) {
      if (now - shake.lastAt > SHAKE_QUIET) {
        // Fresh burst: re-anchor directions, forget the old count.
        shake.count = 0;
        shake.flips = 0;
        shake.axX.dir = 0; shake.axX.travel = 0;
        shake.axY.dir = 0; shake.axY.travel = 0;
      } else {
        feedAxis(shake.axX, x - shake.x);
        feedAxis(shake.axY, y - shake.y);
      }
    }
    shake.x = x;
    shake.y = y;
    shake.lastAt = now;
    clearTimeout(shake.quietTimer);
    shake.quietTimer = setTimeout(shakeBurstEnd, SHAKE_QUIET);
  }

  // Burst is over: freeze the window in place, toast it, and let the model
  // answer for her (dizzy after 1–3 shakes, angry past that). The renderer
  // runs the reply, then calls kanna:unfreeze once text + voice are done.
  function shakeBurstEnd() {
    const count = shake.count;
    const flips = shake.flips;
    shake.count = 0;
    shake.flips = 0;
    shake.x = null;
    shake.y = null;
    shake.axX.dir = 0; shake.axX.travel = 0;
    shake.axY.dir = 0; shake.axY.travel = 0;
    if (count < 1 || flips < 1 || Date.now() < shake.cooldownUntil || !win || win.isDestroyed()) return;
    const [cx, cy] = win.getPosition();
    frozenShake = { x: cx, y: cy, shakes: count };
    // The rattle feeds her grudge pool: heavier bursts climb toward fed-up
    // and the annoyance persists across turns (cools one level per turn).
    affect.noteShake(count);
    shake.cooldownUntil = Date.now() + SHAKE_COOLDOWN;
    clearTimeout(shake.freezeTimer);
    shake.freezeTimer = setTimeout(() => unfreezeForShake('timeout'), FREEZE_MAX_MS);
    log.info('[shake]', `${count} shakes (${flips} swings) → position frozen, asking the model`);
    if (win.isVisible()) win.webContents.send('kanna:shakeLock', { shakes: count });
    else unfreezeForShake('hidden');
  }

  function unfreezeForShake(reason) {
    if (!frozenShake) return;
    clearTimeout(shake.freezeTimer);
    frozenShake = null;
    // Last line of defense: if the drag-loop drifted the rect between
    // events, snap the true size back once more when releasing.
    try {
      const [w, h] = win.getSize();
      if (w !== WIN_W || h !== WIN_H) win.setSize(WIN_W, WIN_H);
    } catch { /* window gone mid-flight */ }
    log.info('[shake]', `position unfrozen (${reason})`);
    if (win && !win.isDestroyed()) win.webContents.send('kanna:freezeOff', { reason });
  }

  win.on('move', () => {
    // While frozen: immediately undo any attempt to move (or, thanks to
    // Windows quirks in the active drag-loop, resize) her. setBounds with
    // explicit W×H corrects both in one call — setPosition alone can leave
    // the rect enlarged. This also breaks the user's modal drag.
    if (frozenShake && !repositioning) {
      repositioning = true;
      try {
        const [x, y] = win.getPosition();
        const [w, h] = win.getSize();
        if (x !== frozenShake.x || y !== frozenShake.y || w !== WIN_W || h !== WIN_H) {
          win.setBounds({
            x: frozenShake.x,
            y: frozenShake.y,
            width: WIN_W,
            height: WIN_H,
          });
        }
      } finally {
        repositioning = false;
      }
      return;
    }
    // 'move' streams continuously while dragging (Windows), so reversal
    // sampling sees the back-and-forth; 'moved' only fires once at the end.
    const [x, y] = win.getPosition();
    shakeSample(x, y);
  });

  ipcMain.on('kanna:unfreeze', () => unfreezeForShake('voice done'));

  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(savePosition, 500);
  });

  // The ✕ button hides her to the tray instead of exiting — she keeps
  // living there until the tray menu's Quit (or the summon hotkey).
  win.on('close', (event) => {
    if (!isQuitting) {
      savePosition();
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    ai.abortActive();
    win = null;
  });
}

app.whenReady().then(async () => {
  // Startup snapshot — the single most useful block when reading logs from a
  // user's machine: which build, which paths, which providers are configured.
  log.info('app starting', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions?.electron,
    resourcesPath: process.resourcesPath,
    appPath: (() => { try { return app.getAppPath(); } catch { return ''; } })(),
    userData: (() => { try { return app.getPath('userData'); } catch { return ''; } })(),
    log: log.logFilePath(),
  });
  ipcMain.handle('settings:get', () => settings.getSettings());

  ipcMain.handle('settings:save', async (_e, patch) => {
    const before = await settings.getSettings();
    const saved = await settings.save(patch);
    const wasPiper = before?.tts?.provider === 'piper';
    const isPiper = saved?.tts?.provider === 'piper';
    if (wasPiper || isPiper) {
      // Piper options (command/model/GPU/data dir) only bind when the server
      // starts. Spawning here races PyInstaller's onefile bootloader: the
      // serving child appears a few seconds after the parent, so killing
      // "now" then spawning can orphan the not-yet-born child. Instead only
      // stop the old instance — the next spoken message restarts it with
      // the fresh flags the renderer sends along.
      tts.stopPiperServer();
    }
    return saved;
  });
  ipcMain.handle('models:list', (_e, provider) => ai.listModels(provider));

  ipcMain.handle('tts:speak', async (_e, payload) => {
    try {
      return await tts.speak(payload);
    } catch (err) {
      log.error('[tts:speak] failed:', err);
      throw err;
    }
  });
  ipcMain.on('tts:cancel', () => { /* cloud audio cancelled in renderer by destroying <audio> */ });

  ipcMain.handle('stt:start', async () => {
    const s = await settings.getSettings();
    return stt.sttStart({ command: s?.stt?.command, model: s?.stt?.model, lang: s?.stt?.lang });
  });
  ipcMain.handle('stt:audio', async (_e, pcm) => stt.sttAudio(pcm));
  ipcMain.handle('stt:finish', async () => stt.sttFinish());
  ipcMain.on('stt:cancel', () => { stt.sttCancel().catch(() => {}); });

  ipcMain.handle('memory:get', () => ({ entries: memory.load() }));
  ipcMain.handle('memory:remove', (_e, key) => ({ entries: memory.removeEntry(String(key || '')) }));
  ipcMain.handle('memory:clear', () => ({ entries: memory.clearAll() }));

  // Phase 5: mood debug panel (Settings -> Mood). Read-only snapshot plus a
  // mood reset and a separate relationship reset (the affinity survives a
  // normal mood reset on purpose).
  ipcMain.handle('affect:get', () => affect.snapshot());
  ipcMain.handle('affect:reset', () => affect.reset());
  ipcMain.handle('affect:resetAffinity', () => affect.resetAffinity());

  // Welcome-back: the renderer pings main when the user becomes active
  // again after ≥5 min away. Main picks a tier-matched canned line (no
  // model call) and lets the affect engine feel it too, so the next
  // model turn inherits the reunion mood.
  ipcMain.handle('kanna:back', (_e, awayMs) => {
    const g = welcome.greet(awayMs);
    affect.observe({ mood: g.mood, speed: g.speed, hold: false }, 'back');
    return g;
  });

  // Shaken Kanna: the model answers for her. The renderer's recent chat tail
  // rides along so the reaction is grounded in the ongoing conversation
  // (topical callbacks, her current feeling) instead of being disjointed.
  // A hidden scene prompt is appended after it — never user-visible.
  // Persona/emotional-direction/carry all apply; affect triggers are
  // skipped so the fake prompt can't pollute tone/repeat detection.
  // Streaming flows through the same chat:chunk / chat:meta channels the
  // renderer already consumes.
  ipcMain.handle('kanna:shakeAsk', async (event, shakes, hist) => {
    const n = Math.max(1, Math.min(24, Number(shakes) || 1));
    const prompt = [
      '[Hidden scene note — the user cannot see, hear, or "send" this message]',
      `The user just grabbed Kanna's window and rattled it back and forth ${n} time${n === 1 ? '' : 's'} in a row, shaking her around like a plushie. Kanna is frozen in place and can't move until she reacts and the moment settles.`,
      n > 3
        ? `${n} shakes is far past fun — Kanna is genuinely angry and scolds the user properly.`
        : `${n} shakes are over quickly but leave Kanna dizzy and flustered — she protests the spinning world.`,
      'This happens in the middle of the ongoing conversation above — read it first and stay continuous: pick up the latest topic, your earlier feeling about it, or earlier shake incidents when it fits. It should read like the same Kanna from the chat, mid-thought, just now getting shaken.',
      'Keep the reply very short (1–2 sentences, spoken-style). No markdown. Pick the matching mood yourself (dizzy for 1–3, angry for 4+).',
    ].join('\n');
    const emit = (type, payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send(type, payload);
      } catch {
        // window gone mid-stream — nothing to do
      }
    };
    const messages = [
      ...ai.normalize(hist),
      { role: 'user', content: prompt },
    ];
    return ai.runChat(messages, emit, undefined, { noTriggers: true });
  });

  ipcMain.handle('chat:send', (event, messages) => {
    const emit = (type, payload) => {
      try {
        if (!event.sender.isDestroyed()) event.sender.send(type, payload);
      } catch {
        // window gone mid-stream — nothing to do
      }
    };
    return ai.runChat(messages, emit).then(async (result) => {
      let finalText = result.text;
      let stopped = result.stopped;
      // Toolbox (agent mode, Phase 1): at most one tool per turn. When the
      // reply carried a tool call, run it and let the model answer again
      // with the TOOL RESULT in hand. The second pass skips affect triggers
      // (they already ran on the user's turn) but streams to the same
      // channels, so the bridge text and the real answer type out as one.
      if (result.tool) {
        try {
          const s = await settings.getSettings();
          if (s.agent?.enabled) {
            const call = result.tool;
            emit('chat:tool', { name: call.name });
            const exec = toolbox.execute(call.name, call.args);
            const bridge = (result.text || '').trim();
            const secondMessages = [
              ...messages,
              ...(bridge ? [{ role: 'assistant', content: bridge }] : []),
              {
                role: 'user',
                content: `TOOL RESULT (you called the ${call.name} tool):\n${exec.text}\n`
                  + 'Answer the user now with the usual JSON reply protocol — no tool key this time.',
              },
            ];
            const second = await ai.runChat(secondMessages, emit, undefined, { noTriggers: true });
            if (second.text) finalText = second.text;
            if (second.stopped) stopped = true;
          }
        } catch (err) {
          log.error('[toolbox] tool loop failed:', err);
        }
      }
      // Let the model decide, in the background, whether this turn taught
      // her something durable. Never blocks or fails the chat itself.
      // Extraction reads the final answer (no tool-call bridge text).
      if (!stopped) memory.scheduleRemember(lastUserText(messages), finalText);
      return { stopped, text: finalText };
    }).catch((err) => {
      log.error('[chat:send] failed:', err);
      throw err;
    });
  });

  ipcMain.on('chat:stop', () => ai.abortActive());

  // Borderless window controls.
  ipcMain.on('win:min', () => win?.minimize());
  ipcMain.on('win:close', () => win?.close());

  setupMenu();
  await createWindow();
  try {
    const initial = await settings.getSettings();
    if (initial?.tts?.provider === 'piper') {
      tts.startPiperServer({
        piperCommand: initial.tts.piperCommand,
        piperModel: initial.tts.piperModel,
        piperDataDir: initial.tts.piperDataDir,
        piperUseGpu: !!initial.tts.piperUseGpu,
      }).catch((err) => { log.warn('[tts piper]', 'server failed to start:', err?.message || err); });
    }
  } catch (err) {
    log.warn('[tts piper]', 'could not read settings:', err?.message || err);
  }
  setupTray();
  setupSummonHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  ai.abortActive();
  try { affect.flush(); } catch { /* affinity save best-effort */ }
  try { tts.stopPiperServer(); } catch { /* ignore */ }
  try { stt.stopSttServer(); } catch { /* ignore */ }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  log.info('app quitting (isQuitting=' + isQuitting + ')');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Main-process diagnostics to the log file: the packaged app has no console,
// so without this a crash is entirely silent for a user reporting an issue.
process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));
