'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const drawer = $('#drawer');
  const scrim = $('#scrim');

  const els = {
    provider: $('#provider'),
    hint: $('#provider-hint'),
    keyField: $('#field-key'),
    key: $('#apikey'),
    eye: $('#btn-eye'),
    baseUrlField: $('#field-baseurl'),
    baseUrl: $('#baseurl'),
    model: $('#model'),
    persona: $('#persona'),
    ttsProvider: $('#tts-provider'),
    ttsVoice: $('#tts-voice'),
    ttsRate: $('#tts-rate'),
    ttsRateVal: $('#tts-rate-val'),
    ttsPitch: $('#tts-pitch'),
    ttsPitchVal: $('#tts-pitch-val'),
    ttsMuted: $('#tts-muted'),
    ttsOpenaiKey: $('#tts-openai-key'),
    ttsElevenlabsKey: $('#tts-elevenlabs-key'),
    ttsAzureKey: $('#tts-azure-key'),
    ttsAzureRegion: $('#tts-azure-region'),
    ttsGoogleKey: $('#tts-google-key'),
    ttsPiperCommand: $('#tts-piper-command'),
    ttsPiperModel: $('#tts-piper-model'),
    ttsPiperDatadir: $('#tts-piper-datadir'),
    ttsPiperGpu: $('#tts-piper-gpu'),
    agentEnabled: $('#agent-enabled'),
    agentSilent: $('#agent-silent'),
    toolSwitches: $('#tool-switches'),
  };

  const PROVIDER_META = {
    openai: {
      hint: 'Get a key at platform.openai.com. Models like “gpt-4o-mini”.',
      keyPlaceholder: 'sk-…',
      modelPlaceholder: 'gpt-4o-mini',
    },
    anthropic: {
      hint: 'Get a key at console.anthropic.com. Models like “claude-sonnet-4-5”.',
      keyPlaceholder: 'sk-ant-…',
      modelPlaceholder: 'claude-sonnet-4-5',
    },
    gemini: {
      hint: 'Get a key at aistudio.google.com (has a free tier). Models like “gemini-2.5-flash”.',
      keyPlaceholder: 'AI…',
      modelPlaceholder: 'gemini-2.5-flash',
    },
    custom: {
      hint: 'Any OpenAI-compatible endpoint: OpenRouter (https://openrouter.ai/api/v1), LM Studio (http://localhost:1234/v1), Ollama (http://localhost:11434/v1). API key is optional for local servers.',
      keyPlaceholder: 'optional',
      modelPlaceholder: 'model name, e.g. llama3.2:3b',
    },
    opencode: {
      hint: 'Pay-as-you-go gateway at opencode.ai/console (key from there). Hosts GLM, Kimi, Qwen, Claude, GPT and more — with some free models.',
      keyPlaceholder: 'oc key…',
      modelPlaceholder: 'e.g. glm-5.3-flash-free',
    },
  };

  let draft = null;

  // Phase 4: one checkbox per allowlisted tool (from main's registry, so the
  // drawer and the model never drift apart). Checked = on; the disabled ones
  // land in agent.disabledTools at save.
  async function renderToolSwitches() {
    if (!els.toolSwitches) return;
    let toolDefs = [];
    try { toolDefs = await window.kanna.listTools(); } catch { /* bridge gone */ }
    if (!Array.isArray(toolDefs) || !toolDefs.length) return;
    const off = new Set((draft.agent?.disabledTools || []).map((t) => String(t).toLowerCase()));
    els.toolSwitches.replaceChildren();
    for (const t of toolDefs) {
      const row = document.createElement('label');
      row.className = 'tool-switch-row';

      const nameEl = document.createElement('span');
      nameEl.className = 'tool-name';
      nameEl.textContent = t.name;

      const desc = document.createElement('span');
      desc.className = 'tool-desc';
      desc.textContent = String(t.description || '').split('—')[0].trim();

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.tool = t.name;
      input.checked = !off.has(String(t.name).toLowerCase());

      row.append(nameEl, desc, input);
      els.toolSwitches.append(row);
    }
  }

  function collectDisabledTools() {
    return els.toolSwitches
      ? [...els.toolSwitches.querySelectorAll('input[data-tool]:not(:checked)')].map((el) => el.dataset.tool)
      : (draft.agent?.disabledTools || []);
  }

  function open() {
    window.kanna.getSettings().then((saved) => {
      draft = structuredClone(saved);
      render();
      drawer.classList.add('open');
      scrim.classList.remove('hidden');
      els.key.focus();
      showTab('brain');
      loadMemory();
    }).catch((err) => {
      // Never leave the drawer silently dead — say why it didn't open.
      const msg = (err?.message || 'Settings could not be loaded.').replace(/^Error: /, '');
      window.dispatchEvent(new CustomEvent('kanna:toast', { detail: msg }));
      console.error('[settings open]', err);
    });
  }

  function close() {
    drawer.classList.remove('open');
    scrim.classList.add('hidden');
  }

  function isOpen() {
    return drawer.classList.contains('open');
  }

  // --- "↻ fetch models": fill the datalist from the provider's listing ----

  document.getElementById('btn-models').addEventListener('click', async () => {
    const btn = document.getElementById('btn-models');
    const list = document.getElementById('model-list');
    const icon = btn.querySelector('i');
    const idleIcon = icon ? icon.className : 'fa-solid fa-arrow-rotate-right';

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    try {
      const { models } = await window.kanna.listModels(draft.provider);
      const ids = [...new Set(models)].sort((a, b) => a.localeCompare(b));
      list.replaceChildren(...ids.map((id) => {
        const option = document.createElement('option');
        option.value = id;
        return option;
      }));
      window.dispatchEvent(new CustomEvent('kanna:toast', {
        detail: `${ids.length} models — start typing or pick from the list`,
      }));
    } catch (err) {
      const msg = (err?.message || 'Could not list models.').replace(/^Error: /, '');
      window.dispatchEvent(new CustomEvent('kanna:toast', { detail: msg }));
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="${idleIcon}"></i>`;
    }
  });

  const tabs = drawer.querySelectorAll('.tab');
  const panels = drawer.querySelectorAll('.tab-panel');

  function showTab(name) {
    for (const t of tabs) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of panels) p.classList.toggle('active', p.dataset.panel === name);
  }

  for (const t of tabs) {
    t.addEventListener('click', () => {
      showTab(t.dataset.tab);
      stopMoodPoll();
      if (t.dataset.tab === 'memory') loadMemory(); // fresh facts even while open
      if (t.dataset.tab === 'mood') loadMood();     // live snapshot + poll while open
    });
  }

  // --- memory panel (independent of the Save button) ---------------------------

  async function loadMemory() {
    const list = document.getElementById('memory-list');
    list.textContent = '';

    let entries = [];
    try {
      const data = await window.kanna.getMemory();
      entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    } catch (err) {
      console.error('[memory panel]', err);
    }

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'memory-empty';
      empty.textContent = 'Nothing remembered yet — facts appear here when a chat teaches her something durable.';
      list.append(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'memory-row';

      const key = document.createElement('span');
      key.className = 'memory-key';
      key.textContent = entry.key;

      const value = document.createElement('span');
      value.className = 'memory-val';
      value.textContent = entry.value;

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'memory-x';
      x.title = 'Forget this';
      x.textContent = '×';
      x.addEventListener('click', async () => {
        await window.kanna.removeMemory(entry.key);
        await loadMemory();
      });

      row.append(key, value, x);
      list.append(row);
    }
  }

  document.getElementById('btn-forget').addEventListener('click', async () => {
    if (!confirm('Forget everything Kanna remembers about you?')) return;
    await window.kanna.clearMemory();
    await loadMemory();
    window.dispatchEvent(new CustomEvent('kanna:toast', { detail: 'Memory cleared' }));
  });

  // --- mood panel (Phase 5: affinity + live debug view) -----------------------

  let moodTimer = null;

  function stopMoodPoll() {
    clearInterval(moodTimer);
    moodTimer = null;
  }

  async function loadMood() {
    let s = null;
    try { s = await window.kanna.getMood(); } catch (err) { console.error('[mood panel]', err); return; }
    if (!s) return;

    document.getElementById('mood-family').textContent = s.family || 'neutral';
    document.getElementById('mood-hold').textContent =
      (s.held ? 'held' : '') + (s.intensity != null ? ` · intensity ${s.intensity}` : '');

    const aff = Math.round(Number(s.affinity) || 0);
    const bar = document.getElementById('mood-aff-bar');
    bar.style.width = `${aff}%`;
    document.getElementById('mood-aff-num').textContent = aff;

    document.getElementById('mood-dims').textContent =
      `valence ${s.valence} · arousal ${s.arousal} · social ${s.socialEnergy}`;

    const extras = [];
    if (s.describe && s.describe.includes('annoyed=')) extras.push('grudge up');
    if (s.tone?.kind) extras.push(`tone ${s.tone.kind}×${s.tone.level}`);
    if (s.affinity >= 60) extras.push('warmly attached');
    else if (s.affinity <= 15) extras.push('growing distant');
    document.getElementById('mood-extras').textContent = extras.join(' · ');
  }

  document.getElementById('btn-mood-reset').addEventListener('click', async () => {
    await window.kanna.resetMood();
    await loadMood();
    window.dispatchEvent(new CustomEvent('kanna:toast', { detail: 'Mood reset — affinity kept' }));
  });

  document.getElementById('btn-affinity-reset').addEventListener('click', async () => {
    if (!confirm('Reset the relationship score back to neutral (30)?')) return;
    await window.kanna.resetAffinity();
    await loadMood();
    window.dispatchEvent(new CustomEvent('kanna:toast', { detail: 'Affinity reset' }));
  });

  // Poll while the Mood tab is visible so the numbers breathe.
  const moodTab = document.querySelector('.tab[data-tab="mood"]');
  moodTab.addEventListener('click', () => {
    stopMoodPoll();
    moodTimer = setInterval(loadMood, 1500);
  });

  function render() {
    const p = draft.provider;
    const meta = PROVIDER_META[p];
    const perProvider = draft[p] || (draft[p] = {});

    els.provider.value = p;
    els.hint.textContent = meta.hint;
    els.key.placeholder = meta.keyPlaceholder;
    els.model.placeholder = meta.modelPlaceholder;
    els.key.value = typeof perProvider.apiKey === 'string' ? perProvider.apiKey : '';
    els.model.value = typeof perProvider.model === 'string' ? perProvider.model : '';
    els.baseUrlField.hidden = p !== 'custom';
    if (p === 'custom') els.baseUrl.value = perProvider.baseUrl || '';
    // Model suggestions came from the previously selected provider's listing —
    // they are stale now, so the datalist starts over.
    document.getElementById('model-list').replaceChildren();
    els.persona.value = draft.persona || '';
    els.key.type = 'password';
    els.eye.innerHTML = '<i class="fa-solid fa-eye"></i>';

    // --- toolbox (agent mode) ---
    els.agentEnabled.checked = !!(draft.agent && draft.agent.enabled);
    els.agentSilent.checked = draft.agent?.silentTool !== false; // default on
    renderToolSwitches();

    // --- TTS ---
    const t = draft.tts || (draft.tts = { provider:'builtin', voice:'', rate:1, pitch:1, muted:false, openaiKey:'', elevenlabsKey:'', azureKey:'', azureRegion:'', googleKey:'', piperCommand:'py', piperModel:'', piperDataDir:'', piperUseGpu:false });
    els.ttsProvider.value = t.provider || 'builtin';
    els.ttsRate.value = t.rate ?? 1;
    els.ttsRateVal.textContent = Number(t.rate ?? 1).toFixed(1);
    els.ttsPitch.value = t.pitch ?? 1;
    els.ttsPitchVal.textContent = Number(t.pitch ?? 1).toFixed(1);
    els.ttsMuted.checked = !!t.muted;
    els.ttsOpenaiKey.value = t.openaiKey || '';
    els.ttsElevenlabsKey.value = t.elevenlabsKey || '';
    els.ttsAzureKey.value = t.azureKey || '';
    els.ttsAzureRegion.value = t.azureRegion || '';
    els.ttsGoogleKey.value = t.googleKey || '';
    els.ttsPiperCommand.value = t.piperCommand || 'py';
    els.ttsPiperModel.value = t.piperModel || '';
    els.ttsPiperDatadir.value = t.piperDataDir || '';
    els.ttsPiperGpu.checked = !!t.piperUseGpu;
    syncVoiceField(t);

    const ttsHints = {
      builtin: 'Uses your OS voices (speechSynthesis). Offline, no setup.',
      piper: 'Local offline TTS (Python piper-tts). Needs model downloaded.',
      elevenlabs: 'Needs an ElevenLabs API key. High-quality multilingual voices.',
      openai: 'Uses your OpenAI API key (tts-1 model). Cloud voices.',
      azure: 'Needs an Azure Speech key + region. Microsoft neural voices.',
      google: 'Needs a Google Cloud TTS API key. Neural2 voices.',
    };
    const hintEl = document.getElementById('tts-provider-hint');
    if (hintEl) hintEl.textContent = ttsHints[els.ttsProvider.value] || '';
    document.getElementById('field-tts-openai-key').hidden = els.ttsProvider.value !== 'openai';
    document.getElementById('field-tts-elevenlabs-key').hidden = els.ttsProvider.value !== 'elevenlabs';
    document.getElementById('field-tts-azure-key').hidden = els.ttsProvider.value !== 'azure';
    document.getElementById('field-tts-azure-region').hidden = els.ttsProvider.value !== 'azure';
    document.getElementById('field-tts-google-key').hidden = els.ttsProvider.value !== 'google';
    document.getElementById('field-tts-piper').hidden = els.ttsProvider.value !== 'piper';

  }

  // Voices are per TTS engine — a Piper speaker id means nothing to
  // ElevenLabs, and vice versa. The active provider's voice is mirrored into
  // draft.tts.voice so the chat/TTS path keeps a single string to read.
  const VOICE_META = {
    builtin: { ph: 'OS voice name (optional)' },
    piper: { ph: 'speaker id, e.g. 746' },
    elevenlabs: { ph: 'Voice name or id, e.g. Rachel' },
    openai: { ph: 'alloy / nova / shimmer' },
    azure: { ph: 'en-US-AvaNeural' },
    google: { ph: 'en-US-Neural2-F' },
  };

  function voiceFor(t, provider) {
    const map = t.voiceByProvider || (t.voiceByProvider = {});
    if (typeof map[provider] === 'string') return map[provider];
    // Legacy stores kept one voice for all engines. Seed the map with it when
    // it plausibly belongs to the active provider, so a switch starts clean
    // but the original value isn't lost.
    if (t.voice && !Object.keys(map).length && provider === t.provider) {
      map[provider] = t.voice;
      return t.voice;
    }
    return '';
  }

  function syncVoiceField(t) {
    if (!t) return;
    els.ttsVoice.value = voiceFor(t, t.provider || 'builtin');
    els.ttsVoice.placeholder = (VOICE_META[t.provider] || VOICE_META.builtin).ph;
  }

  async function save(e) {
    e.preventDefault();
    const p = draft.provider;

    draft[p].apiKey = els.key.value.trim();
    draft[p].model = els.model.value.trim();
    if (p === 'custom') draft[p].baseUrl = els.baseUrl.value.trim();
    draft.persona = els.persona.value.trim();
    draft.agent = { enabled: !!els.agentEnabled.checked, silentTool: !!els.agentSilent.checked, disabledTools: collectDisabledTools() };

    const saved = await window.kanna.saveSettings({
      provider: p,
      persona: draft.persona,
      agent: { enabled: !!els.agentEnabled.checked, silentTool: !!els.agentSilent.checked, disabledTools: collectDisabledTools() },
      openai: { apiKey: draft.openai.apiKey, model: draft.openai.model },
      anthropic: { apiKey: draft.anthropic.apiKey, model: draft.anthropic.model },
      gemini: { apiKey: draft.gemini.apiKey, model: draft.gemini.model },
      custom: { apiKey: draft.custom.apiKey, model: draft.custom.model, baseUrl: draft.custom.baseUrl },
      opencode: { apiKey: draft.opencode.apiKey, model: draft.opencode.model },
      tts: {
        provider: draft.tts?.provider || 'builtin',
        voice: draft.tts?.voice || '',
        voiceByProvider: draft.tts?.voiceByProvider || {},
        rate: draft.tts?.rate ?? 1,
        pitch: draft.tts?.pitch ?? 1,
        muted: !!draft.tts?.muted,
        openaiKey: draft.tts?.openaiKey || '',
        elevenlabsKey: draft.tts?.elevenlabsKey || '',
        azureKey: draft.tts?.azureKey || '',
        azureRegion: draft.tts?.azureRegion || '',
        googleKey: draft.tts?.googleKey || '',
        piperCommand: draft.tts?.piperCommand || 'py',
        piperModel: draft.tts?.piperModel || '',
        piperDataDir: draft.tts?.piperDataDir || '',
        piperUseGpu: !!draft.tts?.piperUseGpu,
      },
    });

    draft = structuredClone(saved);
    close();
    window.dispatchEvent(new CustomEvent('kanna:settings-changed'));
    window.dispatchEvent(new CustomEvent('kanna:toast', { detail: 'Saved ✓' }));
  }

  $('#settings-form').addEventListener('submit', save);
  $('#btn-settings').addEventListener('click', open);
  window.addEventListener('kanna:open-settings', open);
  $('#btn-close').addEventListener('click', close);
  scrim.addEventListener('click', close);

  els.provider.addEventListener('change', () => {
    draft.provider = els.provider.value;
    render();
  });

  els.key.addEventListener('input', () => {
    draft[draft.provider].apiKey = els.key.value;
  });

  els.model.addEventListener('input', () => {
    draft[draft.provider].model = els.model.value;
  });

  els.baseUrl.addEventListener('input', () => {
    draft.custom.baseUrl = els.baseUrl.value;
  });

  // --- TTS inputs -------------------------------------------------------------
  els.ttsProvider.addEventListener('change', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.provider = els.ttsProvider.value;
    // Voice follows the engine: remember what you typed, swap what you use.
    syncVoiceField(draft.tts);
    draft.tts.voice = els.ttsVoice.value;
    document.getElementById('field-tts-openai-key').hidden = els.ttsProvider.value !== 'openai';
    document.getElementById('field-tts-elevenlabs-key').hidden = els.ttsProvider.value !== 'elevenlabs';
    document.getElementById('field-tts-azure-key').hidden = els.ttsProvider.value !== 'azure';
    document.getElementById('field-tts-azure-region').hidden = els.ttsProvider.value !== 'azure';
    document.getElementById('field-tts-google-key').hidden = els.ttsProvider.value !== 'google';
    const ttsHints = {
      builtin: 'Uses your OS voices (speechSynthesis). Offline, no setup.',
      piper: 'Local offline TTS (Python piper-tts). Needs model downloaded.',
      elevenlabs: 'Needs an ElevenLabs API key. High-quality multilingual voices.',
      openai: 'Uses your OpenAI API key (tts-1 model). Cloud voices.',
      azure: 'Needs an Azure Speech key + region. Microsoft neural voices.',
      google: 'Needs a Google Cloud TTS API key. Neural2 voices.',
    };
    const he = document.getElementById('tts-provider-hint');
    if (he) he.textContent = ttsHints[els.ttsProvider.value] || '';
  });

  els.ttsVoice.addEventListener('input', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.voice = els.ttsVoice.value;
    if (!draft.tts.voiceByProvider) draft.tts.voiceByProvider = {};
    draft.tts.voiceByProvider[draft.tts.provider || 'builtin'] = els.ttsVoice.value;
  });

  els.ttsRate.addEventListener('input', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.rate = Number(els.ttsRate.value);
    els.ttsRateVal.textContent = Number(els.ttsRate.value).toFixed(1);
  });

  els.ttsPitch.addEventListener('input', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.pitch = Number(els.ttsPitch.value);
    els.ttsPitchVal.textContent = Number(els.ttsPitch.value).toFixed(1);
  });

  els.ttsMuted.addEventListener('change', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.muted = els.ttsMuted.checked;
  });

  const ttsKeyMap = [
    [els.ttsOpenaiKey, 'openaiKey'],
    [els.ttsElevenlabsKey, 'elevenlabsKey'],
    [els.ttsAzureKey, 'azureKey'],
    [els.ttsAzureRegion, 'azureRegion'],
    [els.ttsGoogleKey, 'googleKey'],
  ];

  // Piper fields
  for (const [el, field] of [
    [els.ttsPiperCommand, 'piperCommand'],
    [els.ttsPiperModel, 'piperModel'],
    [els.ttsPiperDatadir, 'piperDataDir'],
  ]) {
    el.addEventListener('input', () => {
      if (!draft.tts) draft.tts = {};
      draft.tts[field] = el.value;
    });
  }
  els.ttsPiperGpu.addEventListener('change', () => {
    if (!draft.tts) draft.tts = {};
    draft.tts.piperUseGpu = els.ttsPiperGpu.checked;
  });
  for (const [el, field] of ttsKeyMap) {
    el.addEventListener('input', () => {
      if (!draft.tts) draft.tts = {};
      draft.tts[field] = el.value;
    });
  }

  els.persona.addEventListener('input', () => {
    draft.persona = els.persona.value;
  });

  // --- Piper smoke test ------------------------------------------------------
  const btnTestPiper = document.getElementById('btn-test-piper');
  const piperStatus = document.getElementById('piper-test-status');
  if (btnTestPiper) {
    btnTestPiper.addEventListener('click', async () => {
      btnTestPiper.disabled = true;
      if (piperStatus) piperStatus.textContent = 'Testing…';
      try {
        const result = await window.kanna.ttsSpeak({
          text: 'Piper check.',
          provider: 'piper',
          voice: els.ttsVoice.value || '',
          rate: Number(els.ttsRate.value) || 1,
          pitch: Number(els.ttsPitch.value) || 1,
          keys: {
            piperCommand: els.ttsPiperCommand.value || 'py',
            piperModel: els.ttsPiperModel.value || '',
            piperDataDir: els.ttsPiperDatadir.value || '',
            piperUseGpu: els.ttsPiperGpu.checked,
          },
        });
        if (piperStatus) piperStatus.textContent = result?.audioDataUrl
          ? 'Piper works ✓'
          : 'No audio returned';
      } catch (err) {
        const msg = (err?.message || 'Piper failed').replace(/^Error: /, '');
        if (piperStatus) piperStatus.textContent = msg.slice(0, 90);
      } finally {
        btnTestPiper.disabled = false;
      }
    });
  }

  els.eye.addEventListener('click', () => {
    const hidden = els.key.type === 'password';
    els.key.type = hidden ? 'text' : 'password';
    // Hidden key: eye (click to reveal). Visible key: slashed eye (click to hide).
    els.eye.innerHTML = hidden ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });
})();
