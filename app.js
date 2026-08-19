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
  digitBuffer: '',
};

let boundaryTimer = null;
let driftTimer = null;
let ledTimer = null;
let digitTimer = null;
let staticShownAt = 0;
let audioCtx = null;
let adOnScreen = false;

// ---- Elements --------------------------------------------------------------

const el = {
  tv: document.getElementById('tv'),
  led: document.getElementById('led'),
  staticCanvas: document.getElementById('static-canvas'),
  guide: document.getElementById('guide'),
  channels: document.getElementById('channels'),
  screenOff: document.getElementById('screen-off'),
  powerLight: document.getElementById('power-light'),
  cinemaLight: document.getElementById('cinema-light'),
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
  return state.powered ? String(currentChannel()?.number ?? '--') : '';
}

function showLed(text, flashMs) {
  clearTimeout(ledTimer);
  el.led.textContent = text;
  if (flashMs) {
    ledTimer = setTimeout(() => {
      el.led.textContent = ledPersistent();
    }, flashMs);
  }
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

function playHiss(durationMs) {
  if (!audioCtx || state.muted || state.volume === 0) return;
  const sampleCount = Math.ceil((audioCtx.sampleRate * durationMs) / 1000);
  const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const gain = audioCtx.createGain();
  const level = 0.12 * (state.volume / 100);
  gain.gain.setValueAtTime(level, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + durationMs / 1000);
  src.connect(gain).connect(audioCtx.destination);
  src.start();
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
    resyncIfDrifted(); // catch-up after a pause: jump to the live position
  } else if (playerState === PlayerState.ENDED) {
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
  // Deleted / embed-blocked video: no signal until the next programme starts.
  staticFx.show();
  showLed('--', LED_FLASH_MS);
}

// ---- Channel & volume controls ---------------------------------------------

function setChannel(index, { withStatic = true } = {}) {
  if (!state.powered || state.channels.length === 0) return;
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

// ---- Cinema mode (picture size + native fullscreen) -------------------------

function applyCinema() {
  document.body.classList.toggle('cinema', state.cinema);
  el.cinemaLight.classList.toggle('on', state.cinema);
  cinemaBtns.forEach((b) => {
    b.setAttribute('aria-pressed', String(state.cinema));
    b.classList.toggle('active', state.cinema);
  });
}

async function setCinema(on) {
  if (state.cinema === on) return;
  state.cinema = on;
  applyCinema();
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
        case 'ch-up': channelStep(1); break;
        case 'ch-down': channelStep(-1); break;
        case 'vol-up': volumeStep(1); break;
        case 'vol-down': volumeStep(-1); break;
        case 'mute': toggleMute(); break;
        case 'guide': toggleGuide(); break;
        case 'channels': toggleChannels(); break;
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
    if (k === 'ArrowUp') channelStep(1);
    else if (k === 'ArrowDown') channelStep(-1);
    else if (k === 'ArrowRight' || k === '+') volumeStep(1);
    else if (k === 'ArrowLeft' || k === '-') volumeStep(-1);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'g' || k === 'G') toggleGuide();
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

bindButtons();
bindKeyboard();

// Restore the picture size only — requestFullscreen needs a user gesture, so a
// page load can never re-enter fullscreen on its own.
state.cinema = localStorage.getItem('retrotv.cinema') === '1';
applyCinema();

loadLineup().catch((e) => console.warn('Lineup prefetch failed', e));

// Debug/verification handle (harmless to ship; nothing secret in here).
window.retrotv = {
  state,
  player,
  currentProgramme,
  currentChannel,
  toggleCinema,
  isAdPlaying: () => adOnScreen,
};
