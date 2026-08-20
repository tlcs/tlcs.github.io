import {
  currentProgramme,
  dailyTimetable,
  nextBoundaryMs,
  resolveLineupFile,
  utcMidnight,
} from './schedule.js';
import { TVPlayer, PlayerState } from './player.js';

const DRIFT_TOLERANCE_S = 6;
const DRIFT_CHECK_MS = 15000;
// Longest thing we'll treat as an ad. Nothing scheduled is this short, so a
// player duration at or under this on a longer programme means an ad is on.
const MAX_AD_S = 180;
const TAPE_SKIP_S = 30;      // one press of REW / FF
const TAPE_TICK_MS = 1000;   // counter tick, and how often a tape saves its place
const TAPE_REWIND_NAG = 0.5; // stopped past halfway => the sleeve asks to be rewound
const STATIC_MIN_MS = 333;
const LED_FLASH_MS = 2000;
const DIGIT_ENTRY_MS = 1500;

// ---- State -----------------------------------------------------------------

const state = {
  powered: false,
  channels: [],
  chIndex: 0,
  volume: clampVolume(Number(localStorage.getItem('retrotv.volume') ?? 60)),
  muted: false,
  lineupFile: null,
  lineupDay: null,
  guideOpen: false,
  channelsOpen: false,
  cinema: false,
  tapes: [],          // the VHS catalogue
  shelfOpen: false,
  tapeId: null,       // non-null => a tape is in, broadcast is suspended
  tapePlaying: false,
  digitBuffer: '',
};

let boundaryTimer = null;
let driftTimer = null;
let ledTimer = null;
let digitTimer = null;
let staticShownAt = 0;
let audioCtx = null;
let adOnScreen = false;
let ledFlashUntil = 0;
let tapeTimer = null;
let osdTimer = null;

// ---- Elements --------------------------------------------------------------

const el = {
  tv: document.getElementById('tv'),
  led: document.getElementById('led'),
  staticCanvas: document.getElementById('static-canvas'),
  guide: document.getElementById('guide'),
  channels: document.getElementById('channels'),
  shelf: document.getElementById('shelf'),
  osd: document.getElementById('vcr-osd'),
  slot: document.getElementById('vhs-slot'),
  remote: document.querySelector('.remote'),
  screenOff: document.getElementById('screen-off'),
  powerLight: document.getElementById('power-light'),
};

const cinemaBtns = document.querySelectorAll('[data-action="cinema"]');

const player = new TVPlayer('yt-player', {
  onStateChange: handlePlayerState,
  onError: handlePlayerError,
});

// ---- Lineup loading --------------------------------------------------------

async function loadLineup() {
  let files = [];
  try {
    const r = await fetch('channels-index.json', { cache: 'no-store' });
    if (r.ok) files = await r.json();
  } catch {
    /* no index — base lineup only */
  }
  const now = Date.now();
  const fname = resolveLineupFile(files, now);
  const resp = await fetch(fname, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Failed to load ${fname}`);
  const data = await resp.json();
  state.channels = (data.channels || []).filter((c) => c && Array.isArray(c.videos));
  state.lineupFile = fname;
  state.lineupDay = utcMidnight(now);
}

function currentChannel() {
  return state.channels[state.chIndex] ?? null;
}

// ---- LED display -----------------------------------------------------------

function ledPersistent() {
  if (!state.powered) return '';
  if (state.tapeId) return tapeCounter(); // a deck shows the counter, not a channel
  return String(currentChannel()?.number ?? '--');
}

function showLed(text, flashMs) {
  clearTimeout(ledTimer);
  el.led.textContent = text;
  ledFlashUntil = flashMs ? performance.now() + flashMs : 0;
  if (flashMs) {
    ledTimer = setTimeout(() => {
      ledFlashUntil = 0;
      el.led.textContent = ledPersistent();
    }, flashMs);
  }
}

// The tape counter ticks every second and must not stomp on a flash in progress,
// so it writes the display directly rather than going through showLed().
function refreshLed() {
  if (performance.now() >= ledFlashUntil) el.led.textContent = ledPersistent();
}

// ---- Static noise (canvas + WebAudio hiss) ---------------------------------

const staticFx = {
  raf: null,
  show() {
    if (this.raf) return;
    el.staticCanvas.classList.add('visible');
    staticShownAt = performance.now();
    const ctx = el.staticCanvas.getContext('2d');
    const { width: w, height: h } = el.staticCanvas;
    const frame = () => {
      const img = ctx.createImageData(w, h);
      const buf = new Uint32Array(img.data.buffer);
      for (let i = 0; i < buf.length; i++) {
        const v = (Math.random() * 256) | 0;
        buf[i] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
      ctx.putImageData(img, 0, 0);
      this.raf = requestAnimationFrame(frame);
    };
    frame();
  },
  hide() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    el.staticCanvas.classList.remove('visible');
  },
  isVisible() {
    return this.raf !== null;
  },
};

// White noise of a given length — the aerial hiss between channels.
function noiseSource(durationS) {
  const sampleCount = Math.ceil(audioCtx.sampleRate * durationS);
  const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  return src;
}

function playHiss(durationMs) {
  if (!audioCtx || state.muted || state.volume === 0) return;
  const src = noiseSource(durationMs / 1000);
  const gain = audioCtx.createGain();
  const level = 0.12 * (state.volume / 100);
  gain.gain.setValueAtTime(level, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + durationMs / 1000);
  src.connect(gain).connect(audioCtx.destination);
  src.start();
}

// ---- Deck mechanism sound ---------------------------------------------------
// Real recordings of a deck, played straight. The files are already trimmed to
// just the mechanism, so each plays whole. `offset` and `duration` are still
// honoured if either is set, which is the cheap way to re-cut without touching
// the audio; left out, a file plays end to end and the blue field takes its
// length from the recording.

const TAPE_SOUNDS = {
  insert: { url: 'sound/trimmed_vhs_in.mp3' },
  eject: { url: 'sound/trimmed_vhs_out.mp3' },
};

// How long to hold the blue field when there is no recording to play, so a
// missing file degrades to a silent deck rather than an instant cut.
const TAPE_SILENT_S = 2;

const tapeBuffers = { insert: null, eject: null };
let tapeSoundsLoading = null;

// Decoding needs the AudioContext, which only exists once the set is switched
// on — so this is kicked off from powerOn() and the buffers are warm long
// before anyone gets as far as picking a tape.
function loadTapeSounds() {
  if (!audioCtx || tapeSoundsLoading) return tapeSoundsLoading;
  tapeSoundsLoading = Promise.all(
    Object.entries(TAPE_SOUNDS).map(async ([key, spec]) => {
      try {
        const resp = await fetch(spec.url);
        if (!resp.ok) throw new Error(`${resp.status}`);
        tapeBuffers[key] = await audioCtx.decodeAudioData(await resp.arrayBuffer());
      } catch (e) {
        console.warn(`Deck sound ${spec.url} unavailable — the deck will run silent.`, e);
      }
    })
  );
  return tapeSoundsLoading;
}

// Returns how long the mechanism takes, so the blue field holds for exactly that
// long — including when there is no sound to play, where it still pauses rather
// than snapping straight to the picture.
function playTapeMechanism({ eject = false } = {}) {
  const key = eject ? 'eject' : 'insert';
  const spec = TAPE_SOUNDS[key];
  const buffer = tapeBuffers[key];
  if (!buffer) return TAPE_SILENT_S;

  // clamp to what the file actually holds, so a shorter recording than expected
  // shortens the blue field to match instead of leaving it hanging on silence
  const offset = Math.min(spec.offset ?? 0, buffer.duration);
  const available = Math.max(0, buffer.duration - offset);
  const duration = spec.duration ? Math.min(spec.duration, available) : available;
  if (duration <= 0) return TAPE_SILENT_S;
  if (state.muted || state.volume === 0) return duration;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const gain = audioCtx.createGain();
  gain.gain.value = state.volume / 100;
  src.connect(gain).connect(audioCtx.destination);
  src.start(audioCtx.currentTime, offset, duration);
  return duration;
}

// Hide static once playback has actually started, holding it a minimum time
// so the transition reads as a real channel change.
function hideStaticWhenPlaying() {
  if (!staticFx.isVisible()) return;
  const elapsed = performance.now() - staticShownAt;
  setTimeout(() => staticFx.hide(), Math.max(0, STATIC_MIN_MS - elapsed));
}

// ---- Tuning & broadcast enforcement ----------------------------------------

function tuneToLive() {
  clearTimeout(boundaryTimer);
  const ch = currentChannel();
  const now = Date.now();
  const prog = ch ? currentProgramme(ch, now) : null;
  if (!prog) {
    player.stop();
    staticFx.show();
    showLed('--');
    return;
  }
  player.tune(prog.video.id, prog.offsetSeconds);
  const boundary = nextBoundaryMs(ch, now);
  boundaryTimer = setTimeout(onBoundary, boundary - now + 300);
}

async function onBoundary() {
  if (!state.powered) return;
  if (state.tapeId) return; // don't retune the tube out from under a tape
  // Crossing UTC midnight may activate a different dated lineup.
  if (utcMidnight(Date.now()) !== state.lineupDay) {
    const keepNumber = currentChannel()?.number;
    try {
      await loadLineup();
    } catch (e) {
      console.warn('Lineup reload failed, keeping current one', e);
      state.lineupDay = utcMidnight(Date.now());
    }
    const idx = state.channels.findIndex((c) => c.number === keepNumber);
    state.chIndex = idx >= 0 ? idx : 0;
    showLed(ledPersistent());
  }
  tuneToLive();
  if (state.guideOpen) renderGuide();
}

// The IFrame API exposes no "ad is showing" event, so infer it: during an ad
// break every getter describes the ad, and getDuration() reports its length.
// Nothing we schedule is under MAX_AD_S, so a short duration on a long
// programme means an ad owns the video surface. Deliberately independent of the
// *exact* lineup duration — those are only approximate until the fetch script
// regenerates them, and a stale value must not be mistaken for an ad forever.
function adPlaying(prog) {
  // Under this length an ad and a programme are indistinguishable; don't guess.
  if (prog.video.duration <= MAX_AD_S) return false;
  const d = player.getDuration();
  const isAd = d > 0 && d <= MAX_AD_S;
  if (isAd !== adOnScreen) {
    adOnScreen = isAd;
    console.debug(
      `[retrotv] ad ${isAd ? 'started' : 'ended'} (player duration ${d.toFixed(1)}s vs ` +
        `programme ${prog.video.duration}s) — schedule enforcement ${isAd ? 'paused' : 'resumed'}`
    );
  }
  return isAd;
}

function resyncIfDrifted() {
  if (!state.powered) return;
  if (state.tapeId) return; // a tape is in — the broadcast clock doesn't apply
  const ch = currentChannel();
  if (!ch) return;
  const prog = currentProgramme(ch, Date.now());
  if (!prog) return;
  // An ad is on: its clock isn't the programme's, so the drift below would be
  // nonsense and every correction wrong. Seeking or reloading now is also what
  // stops the ad rendering — audible but invisible. Leave the player alone; the
  // first tick after the break catches up to live.
  if (adPlaying(prog)) return;
  if (prog.video.id !== player.currentVideoId) {
    tuneToLive();
    return;
  }
  if (player.getState() === PlayerState.PLAYING) {
    const drift = Math.abs(player.getCurrentTime() - prog.offsetSeconds);
    if (drift > DRIFT_TOLERANCE_S) player.seekTo(prog.offsetSeconds);
  }
}

function handlePlayerState(playerState) {
  if (!state.powered) return;
  if (playerState === PlayerState.PLAYING) {
    hideStaticWhenPlaying();
    if (state.tapeId) {
      state.tapePlaying = true;
      hideVcrOsd(); // the film has the tube now — lift the blue field
      refreshLed();
      return; // no catch-up: a tape plays at its own pace
    }
    resyncIfDrifted(); // catch-up after a pause: jump to the live position
  } else if (playerState === PlayerState.PAUSED && state.tapeId) {
    state.tapePlaying = false;
    saveTapePosition(state.tapeId, player.getCurrentTime());
  } else if (playerState === PlayerState.ENDED) {
    if (state.tapeId) {
      ejectTape({ rewound: true }); // ran to the end, so it's back at the start
      return;
    }
    // Claimed duration was a little long — hold static until the boundary
    // timer retunes (or retune now if the schedule already moved on).
    const ch = currentChannel();
    const prog = ch && currentProgramme(ch, Date.now());
    // An ad ending is not the programme ending: painting static here would
    // cover the picture with noise mid-break.
    if (prog && adPlaying(prog)) return;
    if (prog && prog.video.id !== player.currentVideoId) tuneToLive();
    else staticFx.show();
  }
}

function handlePlayerError(code) {
  console.warn('YouTube player error', code);
  // 101/150 = embedding disallowed, which is also what an age-restricted video
  // reports. A tape that can't play would strand the set on static, so spit it
  // back out and return to broadcast rather than sit there.
  if (state.tapeId) {
    console.warn(`Tape ${state.tapeId} refused to play (code ${code}) — ejecting.`);
    showLed('ERR', LED_FLASH_MS);
    ejectTape({ rewound: true });
    return;
  }
  // Deleted / embed-blocked video: no signal until the next programme starts.
  staticFx.show();
  showLed('--', LED_FLASH_MS);
}

// ---- Channel & volume controls ---------------------------------------------

function setChannel(index, { withStatic = true } = {}) {
  if (!state.powered || state.channels.length === 0) return;
  if (state.tapeId) return; // the aerial is disconnected while a tape is in
  const n = state.channels.length;
  state.chIndex = ((index % n) + n) % n;
  localStorage.setItem('retrotv.channel', String(currentChannel().number));
  if (withStatic) {
    staticFx.show();
    playHiss(300);
  }
  showLed(ledPersistent());
  tuneToLive();
  if (state.guideOpen) renderGuide();
  if (state.channelsOpen) renderChannels(); // move the green bar with the channel
}

function channelStep(delta) {
  setChannel(state.chIndex + delta);
}

function pushDigit(d) {
  if (!state.powered) return;
  clearTimeout(digitTimer);
  state.digitBuffer += d;
  showLed(state.digitBuffer + '_');
  const commit = () => {
    const num = Number(state.digitBuffer);
    state.digitBuffer = '';
    const idx = state.channels.findIndex((c) => c.number === num);
    if (idx >= 0) setChannel(idx);
    else showLed(ledPersistent());
  };
  if (state.digitBuffer.length >= 2) commit();
  else digitTimer = setTimeout(commit, DIGIT_ENTRY_MS);
}

function clampVolume(v) {
  return Math.min(100, Math.max(0, Math.round(v / 5) * 5 || 0));
}

function volumeStep(delta) {
  if (!state.powered) return;
  state.volume = clampVolume(state.volume + delta * 5);
  state.muted = false;
  player.setMuted(false);
  player.setVolume(state.volume);
  localStorage.setItem('retrotv.volume', String(state.volume));
  showLed(`U${String(Math.round(state.volume / 5)).padStart(2, ' ')}`, LED_FLASH_MS);
}

function toggleMute() {
  if (!state.powered) return;
  state.muted = !state.muted;
  player.setMuted(state.muted);
  showLed(state.muted ? 'MUTE' : `U${String(Math.round(state.volume / 5)).padStart(2, ' ')}`, LED_FLASH_MS);
}

// ---- Guide (teletext-style timetable) --------------------------------------

const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat([], { weekday: 'short', day: '2-digit', month: 'short' });

function renderGuide() {
  const ch = currentChannel();
  if (!ch) return;
  const now = Date.now();
  const entries = dailyTimetable(ch, now);
  const rows = entries.map((entry, i) => {
    const endMs = entries[i + 1]?.startMs ?? utcMidnight(now) + 86400000;
    const current = entry.startMs <= now && now < endMs;
    return `<div class="guide-row${current ? ' current' : ''}">
      <span class="guide-time">${timeFmt.format(entry.startMs)}</span>
      <span class="guide-title">${escapeHtml(entry.video.title || entry.video.id)}</span>
    </div>`;
  });
  el.guide.innerHTML = `
    <div class="guide-header">
      <span>P${100 + (ch.number ?? 0)}</span>
      <span>${escapeHtml(ch.name || 'CHANNEL ' + ch.number)}</span>
      <span>${dateFmt.format(now)}</span>
    </div>
    <div class="guide-body">${rows.join('')}</div>
    <div class="guide-footer">ALL TIMES LOCAL &nbsp;&middot;&nbsp; GUIDE TO CLOSE</div>`;
  el.guide.querySelector('.guide-row.current')?.scrollIntoView({ block: 'center' });
}

// ---- Channel list (same teletext panel, reached from the LED display) -------

function renderChannels() {
  const cur = currentChannel();
  const rows = state.channels.map((ch) => {
    const current = ch === cur;
    return `<div class="guide-row${current ? ' current' : ''}">
      <span class="guide-time">${String(ch.number ?? 0).padStart(2, '0')}</span>
      <span class="guide-title">${escapeHtml(ch.name || 'CHANNEL ' + ch.number)}</span>
    </div>`;
  });
  el.channels.innerHTML = `
    <div class="guide-header">
      <span>CHANNELS</span>
      <span>${state.channels.length} TOTAL</span>
    </div>
    <div class="guide-body">${rows.join('')}</div>
    <div class="guide-footer">DISPLAY TO CLOSE</div>`;
  el.channels.querySelector('.guide-row.current')?.scrollIntoView({ block: 'center' });
}

// The two overlays share the panel and the z-layer, so only one is ever open.

function setGuideOpen(open) {
  state.guideOpen = open;
  el.guide.classList.toggle('open', open);
  if (open) renderGuide();
}

function setChannelsOpen(open) {
  state.channelsOpen = open;
  el.channels.classList.toggle('open', open);
  if (open) renderChannels();
}

function toggleGuide() {
  if (!state.powered) return;
  const next = !state.guideOpen;
  if (next && state.channelsOpen) setChannelsOpen(false);
  setGuideOpen(next);
}

function toggleChannels() {
  if (!state.powered) return;
  const next = !state.channelsOpen;
  if (next && state.guideOpen) setGuideOpen(false);
  setChannelsOpen(next);
}

// ---- VHS: the tape deck -----------------------------------------------------
// A tape suspends the broadcast entirely. The schedule keeps running in the
// world's clock, but this set has stopped watching it until the tape comes out.

async function loadCatalogue() {
  const resp = await fetch('vhs.json', { cache: 'no-store' });
  if (!resp.ok) throw new Error('Failed to load vhs.json');
  const data = await resp.json();
  state.tapes = (data.tapes || []).filter((t) => t && t.id);
}

function tapeById(id) {
  return state.tapes.find((t) => t.id === id) ?? null;
}

// Tapes hold their position the way real ones did — nothing rewinds on eject.
function tapePosition(id) {
  return Number(localStorage.getItem(`retrotv.tape.${id}`)) || 0;
}

function saveTapePosition(id, seconds) {
  localStorage.setItem(`retrotv.tape.${id}`, String(Math.max(0, Math.floor(seconds))));
}

// Four characters, like every other thing this display shows.
function tapeCounter() {
  const s = Math.max(0, Math.floor(player.getCurrentTime()));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function renderShelf() {
  if (state.tapes.length === 0) {
    el.shelf.innerHTML = '<p class="shelf-empty">NO TAPES IN THE CATALOGUE</p>';
    return;
  }
  const genres = [...new Set(state.tapes.map((t) => t.genre || 'Inne'))];
  el.shelf.innerHTML = genres
    .map((genre) => {
      const sleeves = state.tapes
        .filter((t) => (t.genre || 'Inne') === genre)
        .map(sleeveHtml)
        .join('');
      return `<div class="shelf-genre">${escapeHtml(genre)}</div>
        <div class="shelf-row">${sleeves}</div>`;
    })
    .join('');
}

function sleeveHtml(tape) {
  const pos = tapePosition(tape.id);
  const unrewound = tape.duration > 0 && pos > tape.duration * TAPE_REWIND_NAG;
  const art = tape.cover || `https://i.ytimg.com/vi/${tape.id}/hqdefault.jpg`;
  const mins = Math.round((tape.duration || 0) / 60);
  return `<button type="button" class="sleeve${tape.id === state.tapeId ? ' loaded' : ''}"
      data-tape="${escapeHtml(tape.id)}" title="${escapeHtml(tape.title || tape.id)}">
    <span class="sleeve-art"><img src="${escapeHtml(art)}" alt="" loading="lazy"></span>
    <span class="sleeve-label">
      <span class="sleeve-meta">${escapeHtml(tape.genre || 'Inne')} &middot; ${mins} MIN</span>
      <span class="sleeve-title">${escapeHtml(tape.title || tape.id)}</span>
      ${unrewound ? '<span class="sleeve-rewind">BE KIND, REWIND</span>' : ''}
    </span>
  </button>`;
}

// The shelf is furniture standing under the set, so it lines up with the
// cabinet. Left to the room's centring it would centre under the TV-and-remote
// pair instead, hanging out to the left of the TV by half the remote's width.
// The offset depends on whether the remote is beside the set, wrapped below it
// or hidden, so it's measured rather than guessed.
function alignShelfToCabinet() {
  if (el.shelf.hidden) return;
  const tv = el.tv.getBoundingClientRect();
  el.shelf.style.width = `${Math.round(tv.width)}px`;
  el.shelf.style.transform = 'none';
  const dx = Math.round(tv.left - el.shelf.getBoundingClientRect().left);
  el.shelf.style.transform = dx ? `translateX(${dx}px)` : 'none';
}

function setShelfOpen(open) {
  state.shelfOpen = open;
  el.shelf.hidden = !open;
  if (!open) return;
  renderShelf();
  alignShelfToCabinet();
  // the shelf sits under the set, which can put it below the fold — look down at
  // it, the way you would in the shop
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.shelf.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' });
}

// The slot is the whole interface: press it for the library, press it again to
// eject whatever is in it.
function slotPressed() {
  if (!state.powered) return;
  if (state.tapeId) {
    ejectTape();
    return;
  }
  if (state.shelfOpen) {
    setShelfOpen(false);
    return;
  }
  const show = () => setShelfOpen(true);
  if (state.tapes.length === 0) loadCatalogue().then(show).catch((e) => {
    console.warn('Catalogue load failed', e);
    show();
  });
  else show();
}

// The blue field a deck put up while its mechanism worked. It is also the
// reason inserting and ejecting take a beat instead of cutting instantly —
// that pause is most of what makes it feel like a machine rather than a button.
function showVcrOsd(text) {
  el.osd.textContent = text;
  el.osd.classList.add('open');
}

function hideVcrOsd() {
  clearTimeout(osdTimer);
  osdTimer = null;
  el.osd.classList.remove('open');
}

function insertTape(id) {
  const tape = tapeById(id);
  if (!tape || !state.powered || osdTimer) return; // ignore clicks mid-transition
  // hand the tube to the deck: the broadcast clock stops applying
  clearTimeout(boundaryTimer);
  clearInterval(driftTimer);
  driftTimer = null;
  state.tapeId = id;
  state.tapePlaying = true;
  setShelfOpen(false);
  if (state.guideOpen) setGuideOpen(false);
  if (state.channelsOpen) setChannelsOpen(false);
  el.slot.classList.add('loaded');
  applyDeckState();
  showLed('PLAY', LED_FLASH_MS);

  staticFx.hide();
  showVcrOsd('PLAY ▶');
  // the blue field holds for exactly as long as the mechanism runs
  const loadMs = playTapeMechanism() * 1000;
  osdTimer = setTimeout(() => {
    osdTimer = null;
    if (state.tapeId !== id) return; // ejected or powered off while loading
    staticFx.show(); // covers the buffering gap once the blue field lifts
    player.tune(id, tapePosition(id));
    startTapeTimer();
  }, loadMs);
}

function ejectTape({ rewound = false } = {}) {
  if (!state.tapeId) return;
  saveTapePosition(state.tapeId, rewound ? 0 : player.getCurrentTime());
  state.tapeId = null;
  state.tapePlaying = false;
  stopTapeTimer();
  el.slot.classList.remove('loaded');
  applyDeckState();
  if (state.shelfOpen) renderShelf(); // drop the "loaded" ring, add any rewind nag
  showLed('EJECT', LED_FLASH_MS);

  player.stop();
  staticFx.hide();
  showVcrOsd('EJECT');
  const ejectMs = playTapeMechanism({ eject: true }) * 1000;
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => {
    osdTimer = null;
    if (!state.powered || state.tapeId) return; // powered off, or another tape went in
    hideVcrOsd();
    staticFx.show();
    // back to live television, caught up to wherever the schedule has got to
    tuneToLive();
    driftTimer = setInterval(resyncIfDrifted, DRIFT_CHECK_MS);
  }, ejectMs);
}

function tapePlayPause() {
  if (!state.tapeId) return;
  state.tapePlaying = !state.tapePlaying;
  if (state.tapePlaying) player.play();
  else player.pause();
  showLed(state.tapePlaying ? 'PLAY' : 'STIL', LED_FLASH_MS);
}

function tapeSkip(direction) {
  if (!state.tapeId) return;
  const to = Math.max(0, player.getCurrentTime() + direction * TAPE_SKIP_S);
  player.seekTo(to);
  saveTapePosition(state.tapeId, to);
  showLed(direction < 0 ? 'REW' : 'FF', LED_FLASH_MS);
}

function startTapeTimer() {
  stopTapeTimer();
  tapeTimer = setInterval(() => {
    if (!state.tapeId) return;
    saveTapePosition(state.tapeId, player.getCurrentTime());
    refreshLed();
  }, TAPE_TICK_MS);
}

function stopTapeTimer() {
  clearInterval(tapeTimer);
  tapeTimer = null;
}

// Everything on the cabinet that has to know whether the tube is showing the
// aerial or the deck: the transport labels, the slot's action, and the amber
// state that puts the VHS legend and the counter on the deck's colour.
function applyDeckState() {
  const tape = !!state.tapeId;
  el.tv.classList.toggle('tape-in', tape);
  document.querySelectorAll('[data-label-tv]').forEach((b) => {
    b.textContent = tape ? b.dataset.labelTape : b.dataset.labelTv;
  });
  el.slot.title = tape ? 'Eject tape' : 'Video library';
  el.slot.setAttribute('aria-label', tape ? 'Eject tape' : 'Video library');
}

// Shared by the panel buttons and the keyboard: what a control means depends on
// whether a tape is in.
function channelUpOrFwd() { state.tapeId ? tapeSkip(1) : channelStep(1); }
function channelDownOrRew() { state.tapeId ? tapeSkip(-1) : channelStep(-1); }
function guideOrPlayPause() { state.tapeId ? tapePlayPause() : toggleGuide(); }

// ---- Cinema mode (picture size + native fullscreen) -------------------------

function applyCinema() {
  document.body.classList.toggle('cinema', state.cinema);
  cinemaBtns.forEach((b) => {
    b.setAttribute('aria-pressed', String(state.cinema));
    b.classList.toggle('active', state.cinema);
  });
}

async function setCinema(on) {
  if (state.cinema === on) return;
  state.cinema = on;
  applyCinema();
  applyRemoteVisibility(); // leaving cinema restores the remote — re-check it fits
  localStorage.setItem('retrotv.cinema', on ? '1' : '0');
  // OSD readout, the way a real set's picture-size button announced the mode
  if (state.powered) showLed(on ? '16:9' : '4:3', LED_FLASH_MS);
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* browser refused (iOS Safari has no element fullscreen) — layout still applies */
  }
}

function toggleCinema() {
  setCinema(!state.cinema);
}

// Esc / F11 leave fullscreen without a keydown we can see — follow the browser.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.cinema) setCinema(false);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- Power -----------------------------------------------------------------

async function powerOn() {
  if (state.powered) return;
  state.powered = true;
  el.tv.classList.add('on');
  el.screenOff.classList.remove('covering');
  el.powerLight.classList.add('on');
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume();
  loadTapeSounds(); // decode the deck recordings while the set warms up
  staticFx.show();
  playHiss(700);
  try {
    if (state.channels.length === 0) await loadLineup();
    await player.ensure();
  } catch (e) {
    console.error(e);
    showLed('ERR');
    return;
  }
  player.setVolume(state.volume);
  player.setMuted(state.muted);
  const savedNumber = Number(localStorage.getItem('retrotv.channel'));
  const idx = state.channels.findIndex((c) => c.number === savedNumber);
  setChannel(idx >= 0 ? idx : 0, { withStatic: false });
  driftTimer = setInterval(resyncIfDrifted, DRIFT_CHECK_MS);
}

function powerOff() {
  if (!state.powered) return;
  state.powered = false;
  clearInterval(driftTimer);
  clearTimeout(boundaryTimer);
  clearTimeout(digitTimer);
  state.digitBuffer = '';
  state.guideOpen = false;
  state.channelsOpen = false;
  adOnScreen = false;
  el.guide.classList.remove('open');
  el.channels.classList.remove('open');
  // the deck powers down with the set, keeping its place on the tape
  if (state.tapeId) saveTapePosition(state.tapeId, player.getCurrentTime());
  state.tapeId = null;
  state.tapePlaying = false;
  stopTapeTimer();
  hideVcrOsd();
  el.slot.classList.remove('loaded');
  applyDeckState();
  setShelfOpen(false);
  staticFx.hide();
  player.stop();
  el.tv.classList.remove('on');
  el.screenOff.classList.add('covering');
  el.powerLight.classList.remove('on');
  showLed('');
}

function togglePower() {
  state.powered ? powerOff() : powerOn();
}

// ---- Wiring ----------------------------------------------------------------

function bindButtons() {
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { action, value } = btn.dataset;
      switch (action) {
        case 'power': togglePower(); break;
        case 'ch-up': channelUpOrFwd(); break;
        case 'ch-down': channelDownOrRew(); break;
        case 'vol-up': volumeStep(1); break;
        case 'vol-down': volumeStep(-1); break;
        case 'mute': toggleMute(); break;
        case 'guide': guideOrPlayPause(); break;
        case 'channels': toggleChannels(); break;
        case 'vhs': slotPressed(); break;
        case 'cinema': toggleCinema(); break;
        case 'digit': pushDigit(value); break;
      }
    });
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowUp') channelUpOrFwd();
    else if (k === 'ArrowDown') channelDownOrRew();
    else if (k === 'ArrowRight' || k === '+') volumeStep(1);
    else if (k === 'ArrowLeft' || k === '-') volumeStep(-1);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'g' || k === 'G') guideOrPlayPause();
    else if (k === 'v' || k === 'V') slotPressed();
    else if (k === 'p' || k === 'P') togglePower();
    else if (k === 'c' || k === 'C') toggleCinema();
    else if (k === 'Escape' && state.cinema) setCinema(false);
    else if (/^[0-9]$/.test(k)) pushDigit(k);
    else return;
    e.preventDefault();
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resyncIfDrifted();
});

// The cabinet resizes with the viewport, so the shelf has to follow it.
// The remote only earns its place standing beside the set. Once the row wraps it
// drops underneath, where it crowds the shot and pushes everything else down —
// so it stows itself instead. Whether it fits depends on the cabinet's height as
// well as the viewport's width, which no media query can express, so it is
// measured: show it, see if it landed below the cabinet, hide it if it did.
function applyRemoteVisibility() {
  el.remote.classList.remove('stowed');
  const tv = el.tv.getBoundingClientRect();
  const remote = el.remote.getBoundingClientRect();
  if (remote.height === 0) return; // already hidden by CSS (narrow, or cinema)
  el.remote.classList.toggle('stowed', remote.top >= tv.bottom - 2);
}

window.addEventListener('resize', () => {
  applyRemoteVisibility();
  if (state.shelfOpen) alignShelfToCabinet();
});

// Sleeves are rendered on demand, so the shelf delegates rather than binding.
el.shelf.addEventListener('click', (e) => {
  const sleeve = e.target.closest('[data-tape]');
  if (sleeve) insertTape(sleeve.dataset.tape);
});

bindButtons();
bindKeyboard();

// Restore the picture size only — requestFullscreen needs a user gesture, so a
// page load can never re-enter fullscreen on its own.
state.cinema = localStorage.getItem('retrotv.cinema') === '1';
applyCinema();
applyRemoteVisibility();

loadLineup().catch((e) => console.warn('Lineup prefetch failed', e));
loadCatalogue().catch((e) => console.warn('VHS catalogue prefetch failed', e));

// Debug/verification handle (harmless to ship; nothing secret in here).
window.retrotv = {
  state,
  player,
  currentProgramme,
  currentChannel,
  toggleCinema,
  isAdPlaying: () => adOnScreen,
};
