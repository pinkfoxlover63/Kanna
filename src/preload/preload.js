'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kanna', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  removeMemory: (key) => ipcRenderer.invoke('memory:remove', key),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  // Mood debug panel (Settings -> Mood): live snapshot + reset buttons.
  getMood: () => ipcRenderer.invoke('affect:get'),
  resetMood: () => ipcRenderer.invoke('affect:reset'),
  resetAffinity: () => ipcRenderer.invoke('affect:resetAffinity'),
  sendChat: (messages) => ipcRenderer.invoke('chat:send', messages),
  stopChat: () => ipcRenderer.send('chat:stop'),

  // Shake flow: renderer passes its chat tail so the model reacts inside
  // the conversation instead of inventing a disjointed scene.
  shakeAsk: (shakes, hist) => ipcRenderer.invoke('kanna:shakeAsk', shakes, hist),
  unfreeze: () => ipcRenderer.send('kanna:unfreeze'),
  onShakeLock: (listener) => {
    ipcRenderer.on('kanna:shakeLock', (_e, info) => listener(info));
  },
  onFreezeOff: (listener) => {
    ipcRenderer.on('kanna:freezeOff', (_e, info) => listener(info));
  },

  // Welcome-back greeting when the user returns after a while (main picks
  // line + mood by absence length; no model involved).
  back: (awayMs) => ipcRenderer.invoke('kanna:back', awayMs),
  onChunk: (listener) => {
    ipcRenderer.on('chat:chunk', (_e, text) => listener(text));
  },
  onMeta: (listener) => {
    ipcRenderer.on('chat:meta', (_e, meta) => listener(meta));
  },
  // Toolbox (agent mode): fired when a real tool runs.
  onTool: (listener) => {
    ipcRenderer.on('chat:tool', (_e, info) => listener(info));
  },
  // Speech-sequenced chain: each woven pass arrives whole (chat:passDone);
  // the renderer speaks it and calls chainResume() when done (or at once
  // for silent passes) so main runs the next tool.
  onPassDone: (listener) => {
    ipcRenderer.on('chat:passDone', (_e, info) => listener(info));
  },
  chainResume: () => ipcRenderer.send('kanna:chainResume'),
  // Toolbox `background`: she picked a new wallpaper scene for the stage.
  onBackground: (listener) => {
    ipcRenderer.on('kanna:background', (_e, info) => listener(info));
  },
  // Main-pushed canned reactions (shake dizzy/angry lines).
  onShake: (listener) => {
    ipcRenderer.on('kanna:shake', (_e, g) => listener(g));
  },
  minimize: () => ipcRenderer.send('win:min'),
  close: () => ipcRenderer.send('win:close'),

  // TTS: ask the main process to synthesize audio (keys stay in main process).
  ttsSpeak: (payload) => ipcRenderer.invoke('tts:speak', payload),
  ttsCancel: () => ipcRenderer.send('tts:cancel'),

  // STT: microphone transcription through the local Vosk server.
  sttStart: () => ipcRenderer.invoke('stt:start'),
  sttAudio: (pcmBuffer) => ipcRenderer.invoke('stt:audio', pcmBuffer),
  sttFinish: () => ipcRenderer.invoke('stt:finish'),
  sttCancel: () => ipcRenderer.send('stt:cancel'),
});
