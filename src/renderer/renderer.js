'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const sprite = $('#sprite');
  const turnEl = $('#turn');
  const priorEl = $('#turn-prior');
  const mainEl = $('#turn-main');
  const tapEl = $('#turn-tap');
  const composerEl = $('#composer');
  const inputEl = $('#input');
  const sendBtn = $('#send');
  const statusEl = $('#status');
  const toastEl = $('#toast');
  const stageEl = $('.stage');

  const EMOTES = ['angry', 'bored', 'dizzy', 'happy', 'neutral', 'sad', 'shy', 'strained', 'surprise', 'teasing'];

  // The shipped art names the "bored" family's files "boring-*"; the
  // protocol label stays "bored". Map at the file layer only.
  const EMOTE_FILE = { bored: 'boring' };

  // Phase 4 assets: most moods speak through three intensity variants
  // (-speak-i1/i2/i3, matching the model's intensity bands); neutral and
  // dizzy have a single shared variant file (-speak-all) instead.
  const SPEAK_ALL = new Set(['neutral', 'dizzy']);

  // Crisp icons for the send/stop button (innerHTML, since textContent swaps would clash).
  const SEND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

  // Naive mood detection so Kanna reacts to the vibe of her own replies.
  const MOOD_RULES = [
    { emotion: 'happy',    re: /\b(haha|lol|lmao|yay|awesome|great|nice|love|happy|wonderful|congrats)\b|😂|🤣|😊|😄/i },
    { emotion: 'sad',      re: /\b(sorry|sad|unfortunately|lonely|tired|miss you)\b|😢|😭/i },
    { emotion: 'angry',    re: /\b(angry|mad|furious|hate|annoyed)\b|😠|😤/i },
    { emotion: 'surprise', re: /\b(wow|whoa|surprised|shocking|unbelievable)\b|😲|😱/i },
    { emotion: 'shy',      re: /\b(blush|shy|embarrassed|flattered)\b|😳/i },
    { emotion: 'teasing',  re: /\b(just kidding|jk|teasing|hehe)\b|:p|😏|😜/i },
    { emotion: 'bored',    re: /\b(meh|bored|whatever|dull|unimpressed)\b/i },
  ];

  // Loose mood words models come up with → the 10 available emotes; anything
  // unknown stays neutral.
  const MOOD_ALIASES = {
    joy: 'happy', joyful: 'happy', excited: 'happy', cheerful: 'happy', glad: 'happy',
    love: 'happy', loving: 'happy', proud: 'happy', smile: 'happy', giggling: 'happy',
    cry: 'sad', crying: 'sad', lonely: 'sad', gloomy: 'sad', worried: 'sad', hurt: 'sad',
    mad: 'angry', annoyed: 'angry', furious: 'angry', grumpy: 'angry', frustrated: 'angry',
    blush: 'shy', blushing: 'shy', embarrassed: 'shy', bashful: 'shy', flustered: 'shy',
    shocked: 'surprise', shock: 'surprise', amazed: 'surprise', astonished: 'surprise',
    confused: 'dizzy', exhausted: 'strained', tired: 'strained', pain: 'strained',
    teasing: 'teasing', tease: 'teasing', playful: 'teasing', smirking: 'teasing',
    smug: 'teasing', mischievous: 'teasing', cheeky: 'teasing', sly: 'teasing',
    bored: 'bored', meh: 'bored', unimpressed: 'bored', listless: 'bored',
    yawn: 'bored', yawning: 'bored', drowsy: 'bored', sleepy: 'bored',
  };

  let settings = null;
  let history = [];           // { role: 'user' | 'assistant', content }
  let busy = false;
  let phase = 'idle';         // 'idle' | 'thinking' | 'speaking'
  let speechPhaseActive = false; // typing is paced to a full-reply TTS duration
  let targetCps = 5;         // chars/sec used while speaking
  let text = '';              // accumulated reply text / her latest reply
  let lastUserMsg = '';       // your latest message (feeds the small top line)
  let composerOpen = true;    // composer row visible at the bottom of the box
  let moodTimer = null;
  let toastTimer = null;
  let pinned = true;          // auto-scroll while the reader is at the bottom

  // Streaming smoothing: network chunks land in `pending` and get typed out
  // a few characters per frame in `pace()`. The slice size scales with the
  // backlog, so slow replies stay natural and fast bursts catch up quickly
  // without text ever appearing all-at-once.
  let received = '';          // full text as delivered by the network
  let pending = '';           // text queued for display
  let drainTimer = null;      // requestAnimationFrame handle of the pacing loop
  let finishing = false;      // network done — drain the queue, then finalize

  // Per-reply directions from the model ('chat:meta'): which face to wear
  // and how fast to read the text. Defaults keep the keyword fallback alive
  // for models that ignore the JSON reply protocol.
  let liveMood = 'neutral';
  let liveSpeed = 1;
  // Phase 3 protocol: model-reported emotional strength. 0..1; 0.5 = calm
  // mid band until the model's "intensity" key (or the affect fallback) says
  // otherwise. Drives the face scale, not the words.
  let liveIntensity = 0.5;
  let liveHold = null;       // model said whether this mood should stick
  let holdFace = false;      // true while a held mood is on her face

  // Speech-sequenced agent chain: main dispatches each woven pass whole
  // (chat:passDone) — the renderer shows and speaks it one by one, then
  // unblocks main's next tool. resolve skips the stock typing flow when
  // passes were handled this way.
  let chainPassesHandled = 0;   // passDone events handled this turn
  let chainPrevText = '';       // pass currently on the big spot
  let chainResumeTimer = null;

  // TTS (built-in speechSynthesis for now; provider selectable in settings).
  let tts = { provider: 'builtin', voice: '', rate: 1, pitch: 1, muted: false };
  let shouldSpeak = false;   // set per turn; finalize() speaks only if true
  let textFrac = 0;          // fractional char accumulator for sub-1 cps typing

  // Warm the image cache so emote swaps never flicker.
  for (const emotion of EMOTES) {
    const file = EMOTE_FILE[emotion] || emotion;
    for (const speak of SPEAK_ALL.has(emotion) ? ['', '-speak-all'] : ['', '-speak-i1', '-speak-i2', '-speak-i3']) {
      new Image().src = `../../assets/emotes/${file}${speak}.png`;
    }
  }

  // --- emote --------------------------------------------------------------

  // Which speaking file the current intensity band calls for. Neutral and
  // dizzy have no bands — their single "all" variant always applies.
  function speakVariant(emotion) {
    if (SPEAK_ALL.has(emotion)) return '-speak-all';
    const band = liveIntensity < 0.34 ? 'i1' : liveIntensity < 0.71 ? 'i2' : 'i3';
    return `-speak-${band}`;
  }

  function setEmote(emotion, speaking) {
    // The sleepy "still" lives outside the emote pairs — a single PNG for
    // when she's been left alone. Not a mood: any interaction wakes her.
    if (emotion === 'sleep') {
      const src = '../../assets/still/sleep.png';
      if (sprite.getAttribute('src') !== src) sprite.src = src;
      sprite.classList.remove('speaking');
      sleeping = true;
      return;
    }
    if (sleeping) sleeping = false;
    const file = EMOTE_FILE[emotion] || emotion;
    // Face scale bands (i-low/mid/high) still add a size read on top; the
    // -speak-iN art now carries the actual expression intensity.
    const src = `../../assets/emotes/${file}${speaking ? speakVariant(emotion) : ''}.png`;
    if (sprite.getAttribute('src') !== src) sprite.src = src;
    sprite.classList.toggle('speaking', !!speaking);
    armSleep();
  }

  // Phase 3: model's intensity scales the face itself (3 bands), so a
  // whisper of surprise and an overwhelming surge read differently even
  // with the same emote set. Bands stay until the next turn resets them.
  function setFaceIntensity() {
    const band = liveIntensity < 0.34 ? 'i-low' : liveIntensity < 0.71 ? 'i-mid' : 'i-high';
    sprite.classList.remove('i-low', 'i-mid', 'i-high');
    if (liveIntensity !== 0.5) sprite.classList.add(band);
  }

  // Left alone long enough (and nothing held/underway), she dozes off on
  // the still image. Pointer/key activity or a new turn wakes her — and
  // waking after a real absence (≥5 min) gets the user a welcome-back
  // line whose mood scales with the silence.
  const SLEEP_AFTER_MS = 180000;
  const BACK_AFTER_MS = 5 * 60 * 1000;
  let sleepTimer = null;
  let sleeping = false;
  let lastInputAt = Date.now();

  function armSleep() {
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (phase === 'idle' && !busy && !holdFace) setEmote('sleep', false);
    }, SLEEP_AFTER_MS);
  }
  function wake() {
    const now = Date.now();
    const away = now - lastInputAt;
    lastInputAt = now;
    if (sleeping) setEmote('neutral', false);
    else armSleep();
    if (away >= BACK_AFTER_MS) sayWelcomeBack(away);
  }
  for (const ev of ['pointerdown', 'keydown']) {
    window.addEventListener(ev, wake, { passive: true });
  }
  window.addEventListener('focus', wake);

  // She speaks up on her own. Shared canned-speech path (no model): sets
  // the mood face, synthesizes TTS, paces typing to it like a normal reply,
  // then hands back to the mood flash. Used for welcome-back lines and for
  // shake reactions pushed by main.
  async function playCanned(g) {
    if (!g?.text || busy) {
      console.log('[canned]', 'skip', (!g?.text ? 'no-line' : 'busy'), g?.mood || '');
      return;
    }
    const mood = MOOD_ALIASES[g.mood] || (EMOTES.includes(g.mood) ? g.mood : 'neutral');
    // Composer is open (fresh session / user typing view): the stage shows
    // their message, so react as toast + face only instead of a takeover.
    if (composerOpen) {
      console.log('[canned]', 'composer open → toast+face', mood);
      moodFlash(mood, false);
      toast(g.text);
      return;
    }
    if (phase !== 'idle') {
      console.log('[canned]', 'skip phase', phase, mood);
      return;
    }

    liveMood = mood;
    liveSpeed = Math.min(1.8, Math.max(0.7, Number(g.speed) || 1));
    liveHold = null;
    text = '';
    received = '';

    setEmote(liveMood, false);
    busy = true;

    // Voice first (same as send(): synthesize, then pace typing to it).
    let durMs = 0;
    const spoken = textForSpeech(g.text);
    if (!tts?.muted) {
      try {
        const r = await speakChunk(spoken);
        durMs = r?.durationMs || 0;
      } catch { /* silent line typing still works */ }
    }
    if (durMs > 0) {
      targetCps = spoken.length / (durMs / 1000);
      speechPhaseActive = true;
    } else {
      speechPhaseActive = false;
      targetCps = TYPE_CPS * liveSpeed;
    }

    pending = g.text;
    phase = 'speaking';
    finishing = true;
    if (!drainTimer) drainTimer = requestAnimationFrame(pace);
  }

  // Welcome-back variant: ask main for the tier-matched line first.
  async function sayWelcomeBack(awayMs) {
    let g = null;
    try { g = await window.kanna.back(Math.round(awayMs)); } catch { return; }
    await playCanned(g);
  }

  // Main pushes shake reactions (dizzy after 1–3 rattles, angry past 3).
  window.kanna.onShake?.((g) => { playCanned(g); });

  // Shake flow: main froze the window and pushed the lock. She answers
  // with a real model reply (streaming through the normal channels), the
  // stage runs like a normal turn, and once text + voice finish the
  // position unlocks (with a toast either way).
  window.kanna.onShakeLock?.(({ shakes }) => {
    toast(`Whoa— you shook me ${shakes}×! Position locked until I settle…`);
    runShakeAI(shakes);
  });
  window.kanna.onFreezeOff?.(() => {
    toast('Kanna settled — position unfrozen.');
  });

  // Fallback pool if the model can't be reached while frozen (no key,
  // network hiccup): still gives her a spoken-style line.
  const SHAKE_FALLBACK = {
    dizzy: [
      'ow ow ow— the world won\'t stop spinning… s-stop shaking me…',
      'kyaa…! Everything\'s all wobbly… whose idea was that, huh?!',
      'wh— the desk went left, then right, then left again… dizzy…',
    ],
    angry: [
      'HEY! Stop shaking me. Right now. That actually hurts!',
      'I said STOP! Rattling me around like that — rrrude! One more and I\'m done!',
    ],
  };
  let shakeFallbackIdx = { dizzy: -1, angry: -1 };

  // Shake turns are real conversation moments: the event goes into history
// as a bracketed user-side note (never displayed), her line as an
// assistant message — the model can keep referencing the incident later.
function pushShakeToHistory(n, text) {
  history.push({
    role: 'user',
    content: `*you grabbed Kanna's window and shook her ${n} time${n === 1 ? '' : 's'} back and forth*`,
  });
  history.push({ role: 'assistant', content: text });
}

async function runShakeAI(shakes) {
    const n = Math.max(1, Math.min(24, Number(shakes) || 1));
    // Mid-reply (model or a canned line running): don't stomp the stage.
    if (busy) {
      toast('Too dizzy to talk over my own reply — settling first…');
      window.kanna.unfreeze();
      return;
    }

    const wasComposerOpen = composerOpen;
    if (wasComposerOpen) {
      // Stage takeover: the reply needs the big spot.
      composerOpen = false;
      composerEl.classList.remove('open');
      turnEl.classList.remove('composing');
    }

    cancelSpeech();
    shouldSpeak = false;
    speechPhaseActive = false;
    textFrac = 0;
    targetCps = 5;
    text = '';
    received = '';
    pending = '';
    finishing = false;
    liveMood = 'neutral';
    liveSpeed = 1;
    liveHold = null;
    liveIntensity = 0.5;
    setFaceIntensity();

    busy = true;
    phase = 'thinking';
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop (shaken!)';
    setThinking();

    mainEl.classList.remove('error');
    mainEl.classList.add('typing');
    mainEl.replaceChildren(makeDots());
    scrollToBottom(true);

    let failed = false;
    try {
      const result = await window.kanna.shakeAsk(n, history.slice(-24));
      if (result?.stopped) { shouldSpeak = false; }
      // Keep the 'typing' class: pace() removes it on the first typed slice
      // and swaps to the speaking art there. Removing it early would leave
      // the face parked on the static pre-speech pose.
      let full = String(result?.text || '').substring(0, 600);
      if (result?.stopped && full && !/[.…]$/.test(full)) full += ' …';
      if (!full.trim()) {
        failed = true; // model answered empty — fall through to canned pool
      } else {
        // Word-for-word the send() tail: synthesize voice first, then pace
        // typing to the speech duration so they finish together.
        let durMs = 0;
        const spoken = textForSpeech(full);
        if (!tts?.muted) {
          try {
            const r = await speakChunk(spoken);
            durMs = r?.durationMs || 0;
          } catch { /* typing without voice still works */ }
        }
        if (durMs > 0) {
          targetCps = spoken.length / (durMs / 1000);
          speechPhaseActive = true;
        } else {
          speechPhaseActive = false;
          targetCps = TYPE_CPS * liveSpeed;
        }
        pushShakeToHistory(n, full);
        pending = full;
        phase = 'speaking';
        finishing = true;
        if (!drainTimer) drainTimer = requestAnimationFrame(pace);
      }
    } catch (err) {
      console.log('[shake]', 'model reply failed:', err?.message || err);
      failed = true;
      mainEl.classList.remove('typing');
    }

    if (failed) {
      // No model: closed-canned pool keeps her reactive, then unfreeze.
      const mood = n > 3 ? 'angry' : 'dizzy';
      const pool = SHAKE_FALLBACK[mood];
      let idx = Math.floor(Math.random() * pool.length);
      if (pool.length > 1 && idx === shakeFallbackIdx[mood]) idx = (idx + 1) % pool.length;
      shakeFallbackIdx[mood] = idx;
      busy = false;
      phase = 'idle';
      mainEl.classList.remove('typing');
      moodFlash(mood, true);
      toast(pool[idx]);
      pushShakeToHistory(n, pool[idx]);
      window.kanna.unfreeze();
      if (wasComposerOpen) openCompose();
      return;
    }

    // Text + voice done (finalize flips busy/phase at the end of pacing).
    await waitStageIdle(90_000);
    // Small breather so cloud audio tails don't get cut by the snap-back.
    setTimeout(() => window.kanna.unfreeze(), 400);
    if (wasComposerOpen) openCompose();
  }

  async function waitStageIdle(limitMs) {
    const start = Date.now();
    while ((busy || phase !== 'idle') && Date.now() - start < limitMs) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  // While the model is thinking there are no words yet — stay idle; the
  // speaking variant kicks in only once real tokens start arriving.
  function setThinking() {
    clearTimeout(moodTimer);
    // A held mood carries into the next turn — she's still on that emotion
    // while thinking, until the new reply says otherwise.
    if (!holdFace) setEmote('neutral', false);
  }

  function moodFlash(emotion, hold) {
    holdFace = !!hold;
    setEmote(emotion, false);
    clearTimeout(moodTimer);
    if (hold) return; // stays until the next turn moves her
    moodTimer = setTimeout(() => setEmote('neutral', false), 6000);
  }

  function pickEmotion(reply) {
    for (const rule of MOOD_RULES) {
      if (rule.re.test(reply)) return rule.emotion;
    }
    return 'neutral';
  }

  // --- markdown in bubbles ---------------------------------------------------
  // Replies render as lightweight markdown: **bold**, *italic*, `inline code`.
  // Fenced code blocks are deliberately NOT written into the bubble — the
  // model is treated as writing them into a (future) editor, so the bubble
  // shows a chip with a live line count instead (see TODO.md). Model output is
  // never parsed as HTML: everything goes in as text nodes.

  function renderMarkdownInto(el, md) {
    el.replaceChildren(buildMarkdown(md));
  }

  // Splits text into prose and fenced-block parts. A fence that is still
  // streaming (no closing ```) is surfaced with closed:false so the chip can
  // show a "writing…" state.
  function splitCode(md) {
    const parts = [];
    const re = /```([^\n`]*)\n?([\s\S]*?)(?:(```)|$)/g;
    let last = 0, m;
    while ((m = re.exec(md))) {
      if (m.index > last) parts.push({ fenced: false, text: md.slice(last, m.index) });
      if ((m[2] || '').trim()) {
        parts.push({ fenced: true, lang: m[1].trim(), code: m[2], closed: !!m[3] });
      }
      last = re.lastIndex;
    }
    if (last < md.length) parts.push({ fenced: false, text: md.slice(last) });
    return parts;
  }

  function buildMarkdown(md) {
    const frag = document.createDocumentFragment();
    for (const part of splitCode(md)) {
      if (part.fenced) frag.append(buildCodeChip(part));
      else frag.append(buildInline(part.text));
    }
    return frag;
  }

  function buildCodeChip(part) {
    const lines = part.code.replace(/\n+$/, '').split('\n').length;
    const chip = document.createElement('span');
    chip.className = 'code-chip';
    chip.textContent = part.closed
      ? `⌘ ${part.lang ? part.lang + ' · ' : ''}${lines} lines — written to editor`
      : `⌘ ${part.lang ? part.lang + ' · ' : ''}${lines} lines — writing…`;
    chip.title = 'Code stays out of the chat — she keeps it for your editor (coming soon, see TODO.md)';
    return chip;
  }

  // Inline pass: swaps **bold**, *italic* and `code` for elements; everything
  // else (including newlines and lists) stays plain text and relies on the
  // bubble's pre-wrap.
  function buildInline(text) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const tok = m[0];
      if (tok.startsWith('**')) {
        const b = document.createElement('strong');
        b.textContent = tok.slice(2, -2);
        frag.append(b);
      } else if (tok.endsWith('`')) {
        const c = document.createElement('code');
        c.textContent = tok.slice(1, -1);
        frag.append(c);
      } else {
        const e = document.createElement('em');
        e.textContent = tok.slice(1, -1);
        frag.append(e);
      }
      last = m.index + tok.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // --- TTS (built-in speechSynthesis + cloud providers) ----------------------

  let audioEl = null;       // HTMLAudioElement for cloud-provider TTS

  function cancelSpeech() {
    try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch { /* ignore */ }
    if (audioEl) {
      audioEl.pause();
      audioEl.src = '';
      audioEl.remove();
      audioEl = null;
    }
  }

  function updateMuteButton() {
    const btn = document.getElementById('btn-mute');
    if (!btn) return;
    const muted = !!tts?.muted;
    btn.innerHTML = `<i class="fa-solid ${muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i>`;
    btn.title = muted ? 'Unmute TTS' : 'Mute TTS';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  // Speak via built-in speechSynthesis. Returns a promise that resolves when
  // the utterance ends (or immediately if unavailable/muted).
  function speakBuiltin(text) {
    return new Promise((resolve) => {
      if (!text || tts?.muted) { resolve(); return; }
      if (!tts || tts.provider !== 'builtin') { resolve(); return; }
      if (typeof speechSynthesis === 'undefined') { resolve(); return; }
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const chosen = voices.find((v) => v.name === tts.voice);
      if (chosen) u.voice = chosen;
      const rate = Number(tts.rate);
      const pitch = Number(tts.pitch);
      u.rate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
      u.pitch = Number.isFinite(pitch) ? Math.min(2, Math.max(0.5, pitch)) : 1;
      const moodPitch = { happy: 1.1, sad: 0.85, angry: 0.95, surprise: 1.05, shy: 0.9, strained: 0.9 };
      if (moodPitch[liveMood]) u.pitch = Math.min(2, Math.max(0.5, u.pitch * moodPitch[liveMood]));
      u.onend = u.onerror = () => resolve();
      try { speechSynthesis.speak(u); } catch { resolve(); }
    });
  }

  // Speak via a third-party provider (ElevenLabs, OpenAI TTS, Azure, Google).
  // Returns { audioEl, durationMs } so the renderer can pace typing to match.
  async function speakCloud(text) {
    if (!text || tts?.muted) return null;
    if (!tts || tts.provider === 'builtin') return null;
    if (typeof window.kanna.ttsSpeak !== 'function') return null;

    const keys = {
      openaiKey: tts.openaiKey || '',
      elevenlabsKey: tts.elevenlabsKey || '',
      azureKey: tts.azureKey || '',
      azureRegion: tts.azureRegion || '',
      googleKey: tts.googleKey || '',
      piperCommand: tts.piperCommand || 'py',
      piperModel: tts.piperModel || '',
      piperDataDir: tts.piperDataDir || '',
      piperUseGpu: !!tts.piperUseGpu,
    };
    let result;
    try {
      result = await window.kanna.ttsSpeak({
        text,
        provider: tts.provider,
        voice: tts.voice || '',
        rate: Number(tts.rate) || 1,
        pitch: Number(tts.pitch) || 1,
        keys,
      });
    } catch (err) {
      console.warn('[tts cloud]', err?.message || err);
      return null;
    }
    if (!result?.audioDataUrl) return null;

    audioEl = new Audio(result.audioDataUrl);
    audioEl.play().catch(() => { /* autoplay may be blocked; ignore */ });
    return { audioEl, durationMs: result.durationMs || 0 };
  }

  // Speak via the configured TTS provider. For builtin this starts speaking
  // immediately; for cloud providers it synthesizes audio first.
  // Returns { durationMs } for pacing the typewriter.
  async function speakChunk(text) {
    if (!text || tts?.muted) return { durationMs: 0 };
    cancelSpeech(); // never overlap utterances

    if (tts.provider === 'builtin') {
      await speakBuiltin(text);
      // Estimate builtin duration for pacing.
      return { durationMs: estimateDurationMs(text, Number(tts.rate) || 1) };
    }

    const cloud = await speakCloud(text);
    if (cloud) return { durationMs: cloud.durationMs || 0 };

    // Host TTS failed to produce audio (e.g. Piper returned an invalid
    // WAV) fall to the browser's built-in voice instead of staying quiet.
    console.warn('[tts] cloud failed; using builtin fallback');
    await speakBuiltin(text);
    return { durationMs: estimateDurationMs(text, Number(tts.rate) || 1) };
  }

  function textForSpeech(md) {
    let s = String(md || '').replace(/```[\s\S]*?```/g, ' code block. ');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/\*([^*]+)\*/g, '$1');
    s = s.replace(/`([^`]+)`/g, '$1');
    return s.trim();
  }

  function estimateDurationMs(text, rate) {
    // ~13 chars/sec at normal pace, scaled by rate. Floor so short replies
    // still get a minimum typing window.
    return Math.max(600, Math.ceil((text.length / Math.max(1, 13 * rate)) * 1000));
  }

  function isConfigured(s) {
    if (!s) return false;
    if (s.provider === 'custom') return !!s.custom?.model && !!s.custom?.baseUrl;
    return !!s[s.provider]?.apiKey;
  }

  async function refreshSettings() {
    settings = await window.kanna.getSettings();
    const ok = isConfigured(settings);
    statusEl.classList.toggle('ok', ok);
    statusEl.classList.toggle('warn', !ok);
    statusEl.title = ok
      ? `Ready — provider: ${settings.provider}`
      : 'Not configured — add an API key in Settings';

    tts = (settings && settings.tts) ? settings.tts : tts;
    updateMuteButton();

    updateWelcome(mainEl); // guarded inside: only lands while the box is fresh
  }
  // First message flavor: fresh install → intro/setup nudge; memory → personal
  // welcome back (by name when she knows it); plain config → generic welcome.
  // The token guard keeps overlapping refreshes from stomping each other.
  let welcomeToken = 0;
  async function updateWelcome(el) {
    if (history.length || text) return; // the box belongs to the conversation now
    const token = ++welcomeToken;

    if (!isConfigured(settings)) {
      el.textContent = 'Hi! I\'m Kanna 🦊 — a fox who lives on your desktop. Open ⚙ → Brain, add an API key, and I\'m yours.';
      return;
    }

    let entries = [];
    try {
      const data = await window.kanna.getMemory();
      entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      // memory read failed — fall through to the generic welcome
    }

    if (token !== welcomeToken || history.length) return; // a newer refresh / the conversation already took over

    const named = entries.find((e) => e.key === 'user.name' || e.key.endsWith('.name'));
    if (named?.value) {
      el.textContent = `Konkonn, ${named.value} — the desk's been quiet without you 🦊`;
      return;
    }
    if (entries.length) {
      el.textContent = `Welcome back! My little notebook holds ${entries.length} thing${entries.length === 1 ? '' : 's'} about you 🦊`;
      return;
    }
    el.textContent = 'Welcome back 🦊 What are we getting into today?';
  }

  // --- chat ----------------------------------------------------------------

  function makeDots() {
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
    return dots;
  }

  function scrollToBottom(force) {
    if (force || pinned) mainEl.scrollTop = mainEl.scrollHeight;
  }

  mainEl.addEventListener('scroll', () => {
    pinned = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight < 48;
  });

  // The composer lives inside the turn box, and the very bottom of the box is
  // a hit strip: clicking it opens the composer — or interrupts her while
  // she's replying.
  tapEl.addEventListener('click', () => {
    cancelSpeech();
    if (busy) {
      if (phase === 'thinking') {
        shouldSpeak = false;
        window.kanna.stopChat();
        return;
      }
      // speech phase: stop speech and end the reply with "…"
      shouldSpeak = false;
      speechPhaseActive = false;
      if (text.trim()) {
        text = text.trimEnd();
        if (!text.endsWith('…') && !text.endsWith('...')) text += '…';
      } else {
        text = '…';
      }
      renderMarkdownInto(mainEl, text);
      if (history.length && history[history.length - 1]?.role === 'assistant') {
        history[history.length - 1].content = text;
      }
      finishing = false;
      phase = 'idle';
      finalize();
      return;
    }
    if (composerOpen) return;
    openCompose();
    inputEl.focus();
  });

  // Composing view: her last reply pushes into the small top line (what
  // you're answering to) and your last message takes the big spot back.
  function openCompose() {
    cancelSpeech();
    if (text.trim()) {
      renderMarkdownInto(priorEl, text);
      renderMarkdownInto(mainEl, lastUserMsg);
      scrollToBottom();
    }
    composerOpen = true;
    composerEl.classList.add('open');
    turnEl.classList.add('composing');
  }

  // Escape out of composing: restore the reading view — her reply big, your
  // message small on top.
  function closeCompose() {
    composerOpen = false;
    composerEl.classList.remove('open');
    turnEl.classList.remove('composing');
    if (text.trim()) {
      renderMarkdownInto(mainEl, text);
      renderMarkdownInto(priorEl, lastUserMsg);
      scrollToBottom();
    }
  }

  // Fresh session: start with the composer open so the first word needs no
  // tap hunt (once she replies, it closes and the tap strip takes over).
  composerOpen = true;
  composerEl.classList.add('open');
  turnEl.classList.add('composing');

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 96)}px`;
  }

  async function send() {
    const content = inputEl.value.trim();
    if (!content || busy) return;

    if (!isConfigured(settings)) {
      toast('Set up a provider in Settings first');
      window.dispatchEvent(new CustomEvent('kanna:open-settings'));
      return;
    }

    // If speech is still being captured, bail out of it quietly — the user
    // chose to send what they typed, so never inject a late transcript.
    if (sttRecording) {
      window.kanna.sttCancel?.();
      stopStt(false);
    }

    inputEl.value = '';
    autoGrow();

    cancelSpeech();
    shouldSpeak = false;
    phase = 'thinking';
    speechPhaseActive = false;
    targetCps = 5;
    textFrac = 0;

    // Sending always closes the composer — the box becomes the stage for her
    // reply, your words shrink to the small top line.
    composerOpen = false;
    composerEl.classList.remove('open');
    turnEl.classList.remove('composing');

    lastUserMsg = content;
    history.push({ role: 'user', content });
    renderMarkdownInto(priorEl, content);

    // Typing dots at the big spot until the first tokens arrive.
    text = '';
    mainEl.classList.remove('error');
    mainEl.classList.add('typing');
    mainEl.replaceChildren(makeDots());
    scrollToBottom(true);

    busy = true;

    received = '';
    pending = '';
    finishing = false;
    chainPassesHandled = 0;
    chainPrevText = '';
    if (chainResumeTimer) { clearTimeout(chainResumeTimer); chainResumeTimer = null; }
    liveMood = 'neutral';
    liveSpeed = 1;
    liveHold = null;
    liveIntensity = 0.5;
    setFaceIntensity();
    sendBtn.innerHTML = STOP_ICON;
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop';
    setThinking();

    try {
      const result = await window.kanna.sendChat(history.slice(-24));
      if (chainPassesHandled > 0) {
        // Speech-sequenced chain resolved: every pass was already shown and
        // spoken through chat:passDone — skip the stock type/speech flow
        // (the network buffer holds nothing useful at this point), make
        // sure the voice is really off (stop unwinds mid-utterance), and
        // file the passes into history in order.
        if (chainResumeTimer) { clearTimeout(chainResumeTimer); chainResumeTimer = null; }
        text += pending;          // unswept tail of the last spoken pass
        pending = '';
        finishing = false;
        speechPhaseActive = false;
        if (result.stopped) cancelSpeech();
        if (Array.isArray(result.passes) && result.passes.length && result.passes.some((p) => String(p || '').trim())) {
          const notes = Array.isArray(result.notes) ? result.notes : [];
          result.passes.forEach((pass, i) => {
            const note = notes[i];
            if (note) history.push({ role: 'user', content: note });
            if (String(pass || '').trim()) history.push({ role: 'assistant', content: pass });
          });
        } else if (text.trim()) {
          history.push({ role: 'assistant', content: text.trim() });
        }
        phase = 'idle';
        if (text) renderMarkdownInto(mainEl, text); // paint the typed tail now
        finalize();
      } else if (received) {
        // Phase-2 chain: each visible reply becomes its own turn, with the
        // wait notes (user-side bracket lines, never displayed) sitting in
        // the gaps — the same pattern the shake scenes use.
        let pushedChain = false;
        if (Array.isArray(result.passes) && result.passes.length && result.passes.some((p) => String(p || '').trim())) {
          const notes = Array.isArray(result.notes) ? result.notes : [];
          result.passes.forEach((pass, i) => {
            const note = notes[i];
            if (note) history.push({ role: 'user', content: note });
            if (String(pass || '').trim()) history.push({ role: 'assistant', content: pass });
          });
          pushedChain = true;
        }
        if (!pushedChain) history.push({ role: 'assistant', content: received });
        // Reply fully received. Generate the full TTS and pace the typewriter
        // to the speech duration so text and voice finish together. Chain
        // turns: speak every pass (the network buffer only holds the last,
        // earlier ones were promoted mid-turn to the small slot).
        shouldSpeak = !tts?.muted;
        let speechDurationMs = 0;
        if (shouldSpeak) {
          const fullTurn = pushedChain
            ? result.passes.filter(Boolean).join('\n\n')
            : received;
          const spoken = textForSpeech(fullTurn);
          const speakInfo = await speakChunk(spoken);
          speechDurationMs = speakInfo.durationMs || 0;
          // Type at the same speed the voice speaks so they finish together.
          // Tune the base `13` here — lower = slower text (voice scales with
          // the rate slider too, so they stay in sync).
          targetCps = speechDurationMs > 0
            ? spoken.length / (speechDurationMs / 1000)
            : Math.round(13 * (Number(tts.rate) || 1));
          speechPhaseActive = true;
        } else {
          speechPhaseActive = false;
          targetCps = TYPE_CPS;
        }
        phase = 'speaking';
        finishing = true;
        if (!drainTimer) drainTimer = requestAnimationFrame(pace);
      } else if (result.stopped) {
        phase = 'idle';
        mainEl.classList.remove('typing');
        mainEl.textContent = '…';
        finalize();
      } else {
        phase = 'idle';
        mainEl.classList.remove('typing');
        mainEl.replaceChildren(); // no content and not stopped — leave it empty
        finalize();
      }
    } catch (err) {
      pending = '';
      phase = 'idle';
      mainEl.classList.remove('typing');
      mainEl.textContent = `⚠ ${pickErrorMessage(err)}`;
      mainEl.classList.add('error');
      // Something went wrong — she reacts to the glitch, not to whatever
      // mood the half-typed reply happened to carry.
      finalize('dizzy');
    }
  }

  function pickErrorMessage(err) {
    return (err?.message || 'Something went wrong. Try again.').replace(/^Error: /, '');
  }

  // — Typing feel. Tune ONLY these two numbers: —
  const TYPE_CPS = 5;        // characters per second at a comfortable pace
  const CATCHUP_MAX = 20;    // cps cap when a huge backlog arrives (fast models)
  // The effective speed is TYPE_CPS until the backlog grows, then it rises
  // (one backlog char ≈ one cps) so the queue never lags more than ~1–2s.

  let lastFrame = 0;          // timestamp of the previous paced frame

  window.kanna.onChunk((chunk) => {
    if (!busy) return;
    received += chunk;
    pending += chunk;
    // During thinking we just buffer; pacing starts once the reply is done.
    if (phase !== 'thinking' && !drainTimer) drainTimer = requestAnimationFrame(pace);
  });

  // Toolbox (agent mode): she used a real tool mid-turn (Phase 2: time,
  // weather). Toast only — the tool result itself says what happened.
  window.kanna.onTool((info) => {
    if (!info?.name) return;
    toast(`Used her ${info.name} tool…`);
  });

  // Toolbox `background`: she moved to another wallpaper scene — swap the
  // stage art. The flat CSS keeps scene 1 as the default after a restart.
  window.kanna.onBackground?.((info) => {
    const idx = Number(info?.index);
    if (!Number.isFinite(idx) || idx < 1) return;
    stageEl.style.backgroundImage = `url('../../assets/background/${idx}.png')`;
    toast(`Room art changed to scene ${idx}`);
  });

  // Speech-sequenced chain: main hands over each woven pass whole after
  // its stream ends (chain chunks stay suppressed). Show it, speak it,
  // then hand control back — main runs the pass's tool once the voice
  // says her line. Silent passes (or a vanished tool key) display
  // instantly and resume at once, so the chain never stalls on them.
  const chainResumeNow = () => {
    if (chainResumeTimer) { clearTimeout(chainResumeTimer); chainResumeTimer = null; }
    try { window.kanna.chainResume?.(); } catch { /* window gone */ }
  };
  window.kanna.onPassDone((info) => {
    if (!busy) { chainResumeNow(); return; }
    chainPassesHandled++;
    const passText = String(info?.text || '');
    const silent = !!info?.silent;
    // Slide the fully spoken previous pass into the small slot. Its full
    // text lives in chainPrevText — the big-spot typewriter may have been
    // interrupted mid-pass, so text/pending can't be trusted for it.
    const doneText = chainPrevText;
    text = '';
    pending = '';
    textFrac = 0;
    if (chainPassesHandled > 1 && doneText.trim()) renderMarkdownInto(priorEl, doneText.trim());
    chainPrevText = passText;
    if (!passText) { chainResumeNow(); return; }

    // makeDots start of the pass: face swaps live via onMeta mid-pass.
    phase = 'speaking';
    if (mainEl.classList.contains('typing')) {
      mainEl.classList.remove('typing');
      mainEl.replaceChildren();
      setEmote(liveMood, false);
    }
    const speak = !silent && !tts?.muted;
    if (!speak) {
      // TTS muted: voice is off but nothing is hidden — stamp the pass out
      // at normal catch-up pace and keep the chain moving.
      if (silent) {
        // Silent pass: the bubble shows only "…" as a placeholder (the full
        // text still feeds history and the model thread); the chain resumes
        // right away instead of waiting for a voice that never plays.
        // The prior-slot handoff carries the placeholder too, so a silent
        // reply never surfaces in full even after the next pass lands.
        chainPrevText = '…';
        text = '…';
        renderMarkdownInto(mainEl, text);
        scrollToBottom(true);
        chainResumeNow();
        return;
      }
      speechPhaseActive = false;
      targetCps = TYPE_CPS;           // normal readable flow while muted
      text = '';                 // pacer types this pass fresh (text starts
      pending = passText;        // empty or it would be painted twice)
      textFrac = 0;
      if (!drainTimer) drainTimer = requestAnimationFrame(pace);
      // Wait for the typed flow to land before the next tool/turn, so
      // messages don't pile up; mute means no voice, not instant chain skip.
      const est = Math.max(450, Math.ceil((passText.length / TYPE_CPS) * 1000));
      chainResumeTimer = setTimeout(chainResumeNow, est);
      return;
    }
    // Spoken pass. Start the voice and the typewriter together; resume
    // when the utterance ends (builtin resolves at onend) or after the
    // audio duration for cloud providers.
    const spoken = textForSpeech(passText);
    const speechPromise = speakChunk(spoken); // builtin ends at onend; cloud resolves when audio starts
    pending = passText;
    text = '';
    if (tts?.provider === 'builtin') {
      // No real duration from builtin — pace typing to the estimate so
      // text and voice land together around the same second.
      const est = estimateDurationMs(spoken, Number(tts.rate) || 1);
      targetCps = Math.max(0.001, spoken.length / (est / 1000));
    }
    speechPhaseActive = true;
    if (!drainTimer) drainTimer = requestAnimationFrame(pace);
    speechPromise.then((speakInfo) => {
      const durMs = Number(speakInfo?.durationMs) || 0;
      if (tts?.provider === 'builtin') {
        // Utterance ended. In case the typewriter lagged behind the voice,
        // paint the pass whole and sweep it — then the chain resumes.
        speechPhaseActive = false;
        text = passText;
        pending = '';
        renderMarkdownInto(mainEl, text);
        chainResumeNow();
        return;
      }
      if (durMs > 0) {
        // Cloud: audio is playing; typing paces to its real duration.
        targetCps = Math.max(0.001, spoken.length / (durMs / 1000));
        chainResumeTimer = setTimeout(chainResumeNow, durMs + 200);
      } else {
        // No usable duration: resume after a rough estimate so the chain
        // still advances when the audio length is unknown.
        const est = estimateDurationMs(spoken, Number(tts.rate) || 1);
        chainResumeTimer = setTimeout(chainResumeNow, est + 200);
      }
    }).catch(() => chainResumeNow());
  });

  // The model's directions for this reply. Mood is the first key of the JSON
  // reply, so it lands before any words: she sets her face while still
  // thinking, then speaks in that emotion. A mid-reply mood swap goes live.
  window.kanna.onMeta((meta) => {
    if (!busy) return;
    if (meta.mood) {
      liveMood = MOOD_ALIASES[meta.mood] || (EMOTES.includes(meta.mood) ? meta.mood : 'neutral');
      if (mainEl.classList.contains('typing')) setEmote(liveMood, false); // pre-speech face
      else if (text) setEmote(liveMood, true);                            // mid-speech swap
    }
    if (meta.speed) {
      const v = Number(meta.speed);
      if (Number.isFinite(v) && v > 0) liveSpeed = Math.min(2.2, Math.max(0.6, v));
    }
    if (meta.hold !== undefined) liveHold = !!meta.hold;
    // Phase 3 protocol: optional "intensity" 0..1 from the model. Unknown
    // to older replies / plain-text fallbacks — they just leave the mid band.
    if (meta.intensity !== undefined) {
      const n = Number(meta.intensity);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        liveIntensity = n;
        setFaceIntensity();
        // Mid-speech swaps also re-stage the variant art.
        if (mainEl.classList.contains('typing')) setEmote(liveMood, false);
        else if (text) setEmote(liveMood, true);
      }
    }
  });

  function pace(ts) {
    drainTimer = null;
    if (!busy) { lastFrame = 0; return; }

    if (phase === 'thinking') {
      lastFrame = 0;
      return;
    }

    if (pending.length) {
      const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 1 / 60;
      lastFrame = ts;

      let cps;
      if (speechPhaseActive) {
        cps = Math.max(0.001, targetCps);
      } else {
        cps = Math.min(CATCHUP_MAX, Math.max(TYPE_CPS * liveSpeed, pending.length));
      }

      // Accumulate fractional chars so sub-1 cps actually slows typing down.
      textFrac += dt * cps;
      const take = Math.floor(textFrac);
      if (take < 1) {
        drainTimer = requestAnimationFrame(pace);
        return;
      }
      textFrac -= take;

      const slice = pending.slice(0, take);
      pending = pending.slice(take);

      if (mainEl.classList.contains('typing')) {
        mainEl.classList.remove('typing');
        mainEl.replaceChildren();
        setEmote(liveMood, true);
      }
      text += slice;
      renderMarkdownInto(mainEl, text);
      scrollToBottom();
      drainTimer = requestAnimationFrame(pace);
      return;
    }

    lastFrame = 0;
    if (finishing) {
      phase = 'idle';
      finalize();
    }
  }
  function finalize(moodOverride) {
    if (!busy) return;
    busy = false;
    drainTimer = null;
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.classList.remove('stop');
    sendBtn.title = 'Send (Enter)';
    if (moodOverride) moodFlash(moodOverride, false);
    else if (text) moodFlash(liveMood !== 'neutral' ? liveMood : pickEmotion(text), liveHold);
    else setEmote('neutral', false);
    scrollToBottom();
    shouldSpeak = false;
    speechPhaseActive = false;
    phase = 'idle';
  }

  // --- small bits ----------------------------------------------------------

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  // --- STT (push to talk with Vosk) -----------------------------------------
  // Partial results are shown as a toast-ish status; the final transcript is
  // inserted into the composer as if it had been typed.
  let sttRecording = false;
  let sttStream = null;
  let sttContext = null;
  let sttSource = null;
  let sttProcessor = null;
  let sttPartial = '';

  const micBtn = document.getElementById('btn-mic');

  function floatToPcm16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  async function startStt() {
    if (sttRecording) return;
    if (typeof navigator?.mediaDevices?.getUserMedia !== 'function') {
      toast('Microphone API unavailable');
      return;
    }
    if (!window.kanna?.sttStart) {
      toast('STT is not wired in preload');
      return;
    }

    cancelSpeech();
    sttPartial = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      sttStream = stream;
      sttContext = new AudioContext({ sampleRate: 16000 });
      await sttContext.resume();
      sttSource = sttContext.createMediaStreamSource(stream);

      const workletCode = `
        class PcmWorklet extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0] && inputs[0][0];
            if (input && input.length) {
              const out = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]));
                out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
              }
              this.port.postMessage(out.buffer, [out.buffer]);
            }
            return true;
          }
        }
        registerProcessor('pcm-worklet', PcmWorklet);
      `;
      const workletUrl = URL.createObjectURL(new Blob([workletCode], { type: 'application/javascript' }));
      await sttContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const gain = sttContext.createGain();
      gain.gain.value = 0;
      sttProcessor = new AudioWorkletNode(sttContext, 'pcm-worklet');
      sttProcessor.port.onmessage = (event) => {
        if (!sttRecording) return;
        window.kanna.sttAudio(event.data).then((res) => {
          if (res && res.partial && res.partial !== sttPartial) {
            sttPartial = res.partial;
            toast(`Heard: ${sttPartial}`);
          }
        }).catch(() => { /* ignore transient chunks */ });
      };
      sttSource.connect(sttProcessor);
      sttProcessor.connect(gain);
      gain.connect(sttContext.destination);

      const started = await window.kanna.sttStart();
      if (!started || !started.ok) throw new Error('STT server failed to start');

      sttRecording = true;
      micBtn?.classList.add('recording');
      micBtn?.setAttribute('aria-pressed', 'true');
      statusEl.title = 'Listening…';
    } catch (err) {
      await stopStt(false);
      const msg = (err?.message || 'Microphone unavailable').replace(/^Error: /, '');
      toast(msg);
    }
  }

  async function stopStt(insertTranscript = true) {
    if (!sttRecording) {
      // still tear down any half-open resources
      if (sttProcessor) try { sttProcessor.disconnect(); } catch { /* ignore */ }
      if (sttSource) try { sttSource.disconnect(); } catch { /* ignore */ }
      if (sttStream) sttStream.getTracks().forEach((t) => t.stop());
      if (sttContext) try { await sttContext.close(); } catch { /* ignore */ }
      sttProcessor = sttSource = sttStream = sttContext = null;
      return;
    }

    sttRecording = false;
    if (sttProcessor) try { sttProcessor.disconnect(); } catch { /* ignore */ }
    if (sttSource) try { sttSource.disconnect(); } catch { /* ignore */ }
    if (sttStream) sttStream.getTracks().forEach((t) => t.stop());
    if (sttContext) try { await sttContext.close(); } catch { /* ignore */ }
    sttProcessor = sttSource = sttStream = sttContext = null;

    micBtn?.classList.remove('recording');
    micBtn?.setAttribute('aria-pressed', 'false');

    let transcript = '';
    try {
      const result = await window.kanna.sttFinish();
      transcript = (result?.text || '').trim();
    } catch (err) {
      toast((err?.message || 'STT failed').replace(/^Error: /, ''));
    }

    if (insertTranscript && transcript) {
      const current = inputEl.value.trim();
      inputEl.value = current ? `${current} ${transcript}` : transcript;
      autoGrow();
      inputEl.focus();
      toast('Transcribed');
    } else if (insertTranscript && !transcript) {
      // Only the "insert on stop" path reports silence — explicit cancels
      // (Esc, sending instead) stay quiet.
      toast('No speech detected');
    }
  }

  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (sttRecording) stopStt(true);
      else startStt();
    });
  }
  // Esc cancels an in-flight recording without inserting text.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sttRecording) {
      e.preventDefault();
      window.kanna.sttCancel?.();
      stopStt(false);
    }
  });
  window.addEventListener('beforeunload', () => {
    if (sttRecording) window.kanna.sttCancel?.();
  });

  // --- wire up ---------------------------------------------------------------


  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) { window.kanna.stopChat(); return; }
    send();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  inputEl.addEventListener('input', autoGrow);

  // Borderless window buttons.
  $('#win-min').addEventListener('click', () => window.kanna.minimize());
  $('#win-close').addEventListener('click', () => window.kanna.close());

  // Mute TTS toggle (header) — persists via settings.
  const muteBtn = document.getElementById('btn-mute');
  if (muteBtn) {
    muteBtn.addEventListener('click', async () => {
      const next = !(tts?.muted);
      tts = { ...tts, muted: next };
      updateMuteButton();
      try {
        const saved = await window.kanna.saveSettings({ tts: { ...tts, muted: next } });
        if (saved?.tts) tts = saved.tts;
        settings = await window.kanna.getSettings();
        updateMuteButton();
        window.dispatchEvent(new CustomEvent('kanna:settings-changed'));
      } catch { /* ignore */ }
      if (next) cancelSpeech();
    });
  }

  // --- history tab ---------------------------------------------------------------

  const historyDrawer = $('#history-drawer');
  const historyList = $('#history-list');
  const toolLogEl = $('#tool-log');
  const tabChatBtn = $('#tab-history-chat');
  const tabToolsBtn = $('#tab-history-tools');
  let historyTab = 'chat';

  function setHistoryTab(tab) {
    historyTab = tab;
    tabChatBtn.classList.toggle('active', tab === 'chat');
    tabToolsBtn.classList.toggle('active', tab === 'tools');
    historyList.hidden = tab !== 'chat';
    toolLogEl.hidden = tab !== 'tools';
    if (tab === 'tools') renderToolLog();
  }

  function renderChatHistory() {
    historyList.textContent = '';
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'Nothing yet — turns you exchange stack up here (for this session).';
      historyList.append(empty);
      return;
    }
    for (const m of history) {
      const line = document.createElement('div');
      line.className = `history-turn ${m.role}`;

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.role === 'user' ? 'You' : 'Kanna';

      const body = document.createElement('div');
      body.className = 'what';
      renderMarkdownInto(body, m.content || '');

      line.append(who, body);
      historyList.append(line);
    }
    historyList.scrollTop = historyList.scrollHeight;
  }

  function renderToolLog() {
    toolLogEl.textContent = '';
    const fill = async () => {
      let entries = [];
      try { entries = await window.kanna.toolLog(); } catch { /* bridge gone */ }
      toolLogEl.textContent = '';
      if (!Array.isArray(entries) || !entries.length) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent = 'She hasn\'t used any tool yet (last 120 uses persist across restarts).';
        toolLogEl.append(empty);
        return;
      }
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = e.ok ? 'tool-log-row' : 'tool-log-row failed';

        const when = document.createElement('span');
        when.className = 'when';
        const d = new Date(Number(e.ts) || Date.now());
        when.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

        const nameEl = document.createElement('span');
        nameEl.className = 'tool-name';
        nameEl.textContent = String(e.name || '?');

        const outcome = document.createElement('span');
        outcome.className = 'outcome';
        outcome.textContent = e.ok ? 'ok' : 'failed';

        row.append(when, nameEl, outcome);
        toolLogEl.append(row);
      }
    };
    fill();
  }

  function openHistory() {
    setHistoryTab(historyTab);
    renderChatHistory();
    historyDrawer.classList.add('open');
    $('#scrim').classList.remove('hidden');
  }

  function closeHistory() {
    historyDrawer.classList.remove('open');
    // Shared scrim: only dim it out when the settings drawer isn't the one open.
    if (!$('#drawer').classList.contains('open')) $('#scrim').classList.add('hidden');
  }

  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-history-close').addEventListener('click', closeHistory);
  tabChatBtn.addEventListener('click', () => setHistoryTab('chat'));
  tabToolsBtn.addEventListener('click', () => setHistoryTab('tools'));
  $('#scrim').addEventListener('click', () => {
    if (historyDrawer.classList.contains('open')) closeHistory();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (historyDrawer.classList.contains('open')) closeHistory();
      else if (composerOpen) closeCompose();
    }
  });

  window.addEventListener('kanna:settings-changed', refreshSettings);
  window.addEventListener('kanna:toast', (e) => toast(e.detail || ''));

  refreshSettings();
})();
