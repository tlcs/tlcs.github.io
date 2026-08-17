// Pure schedule math for the RetroTV broadcast model.
// Every function takes `nowMs` explicitly so all visitors (and tests) compute
// the same result from the same clock. No DOM, no fetch, no state.

const DAY_MS = 24 * 60 * 60 * 1000;

export function utcMidnight(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Videos with a missing/zero duration would stall the loop math; ignore them.
function airableVideos(channel) {
  return (channel.videos || []).filter((v) => v && v.id && v.duration > 0);
}

export function cycleDuration(channel) {
  return airableVideos(channel).reduce((sum, v) => sum + v.duration, 0);
}

// The channel plays its playlist from 00:00 UTC, looping until the next UTC
// midnight (the video airing at midnight is cut off — the day restarts).
export function currentProgramme(channel, nowMs) {
  const videos = airableVideos(channel);
  const cycle = cycleDuration(channel);
  if (cycle <= 0) return null;
  let pos = Math.floor((nowMs - utcMidnight(nowMs)) / 1000) % cycle;
  for (let i = 0; i < videos.length; i++) {
    if (pos < videos[i].duration) {
      return { video: videos[i], offsetSeconds: pos, index: i };
    }
    pos -= videos[i].duration;
  }
  return null;
}

// When the current programme ends: end of the video, or UTC midnight if the
// day boundary cuts it short. Null when the channel has nothing airable.
export function nextBoundaryMs(channel, nowMs) {
  const prog = currentProgramme(channel, nowMs);
  if (!prog) return null;
  const endMs = nowMs + (prog.video.duration - prog.offsetSeconds) * 1000;
  return Math.min(endMs, utcMidnight(nowMs) + DAY_MS);
}

// Full derived timetable for the current UTC day: [{ startMs, video }].
export function dailyTimetable(channel, nowMs) {
  const videos = airableVideos(channel);
  if (cycleDuration(channel) <= 0) return [];
  const dayStart = utcMidnight(nowMs);
  const dayEnd = dayStart + DAY_MS;
  const entries = [];
  let t = dayStart;
  while (t < dayEnd) {
    for (const video of videos) {
      if (t >= dayEnd) break;
      entries.push({ startMs: t, video });
      t += video.duration * 1000;
    }
  }
  return entries;
}

// ---- Lineup resolution -----------------------------------------------------
// channels.json is the base lineup. channels-DD-MM-YYYY.json takes effect at
// 00:00 UTC of its date; the latest effective date <= now wins.

const LINEUP_RE = /^channels-(\d{2})-(\d{2})-(\d{4})\.json$/;

// "channels-15-08-2026.json" -> ms of that UTC midnight, or null if invalid.
export function parseLineupDate(filename) {
  const m = LINEUP_RE.exec(filename);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  const valid =
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day;
  return valid ? ms : null;
}

export function resolveLineupFile(filenames, nowMs) {
  let best = null;
  for (const name of filenames || []) {
    const effectiveMs = parseLineupDate(name);
    if (effectiveMs === null) {
      console.warn(`Ignoring lineup file with bad date format: ${name}`);
      continue;
    }
    if (effectiveMs <= nowMs && (!best || effectiveMs > best.effectiveMs)) {
      best = { name, effectiveMs };
    }
  }
  return best ? best.name : 'channels.json';
}
