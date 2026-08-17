import test from 'node:test';
import assert from 'node:assert/strict';
import {
  utcMidnight,
  cycleDuration,
  currentProgramme,
  nextBoundaryMs,
  dailyTimetable,
  parseLineupDate,
  resolveLineupFile,
} from './schedule.js';

// 100s + 200s + 300s = 600s cycle
const channel = {
  number: 1,
  name: 'TEST',
  videos: [
    { id: 'a', title: 'A', duration: 100 },
    { id: 'b', title: 'B', duration: 200 },
    { id: 'c', title: 'C', duration: 300 },
  ],
};

const DAY0 = Date.UTC(2026, 7, 10); // 10 Aug 2026 00:00 UTC

test('utcMidnight floors to the UTC day', () => {
  assert.equal(utcMidnight(DAY0 + 5 * 3600_000 + 123), DAY0);
  assert.equal(utcMidnight(DAY0), DAY0);
});

test('currentProgramme walks the loop deterministically', () => {
  assert.equal(cycleDuration(channel), 600);
  let p = currentProgramme(channel, DAY0); // second 0 -> A@0
  assert.deepEqual([p.video.id, p.offsetSeconds, p.index], ['a', 0, 0]);
  p = currentProgramme(channel, DAY0 + 150_000); // second 150 -> B@50
  assert.deepEqual([p.video.id, p.offsetSeconds], ['b', 50]);
  p = currentProgramme(channel, DAY0 + 599_000); // second 599 -> C@299
  assert.deepEqual([p.video.id, p.offsetSeconds], ['c', 299]);
  p = currentProgramme(channel, DAY0 + 600_000); // loop restarts
  assert.deepEqual([p.video.id, p.offsetSeconds], ['a', 0]);
});

test('everyone at the same instant sees the same programme', () => {
  const t = DAY0 + 12 * 3600_000 + 345_678;
  assert.deepEqual(currentProgramme(channel, t), currentProgramme(channel, t));
});

test('zero/missing durations are ignored, empty channel yields null', () => {
  const withJunk = { videos: [{ id: 'x', duration: 0 }, ...channel.videos, { id: 'y' }] };
  assert.equal(cycleDuration(withJunk), 600);
  assert.equal(currentProgramme({ videos: [] }, DAY0), null);
  assert.equal(nextBoundaryMs({ videos: [] }, DAY0), null);
});

test('nextBoundaryMs is the programme end, capped at UTC midnight', () => {
  assert.equal(nextBoundaryMs(channel, DAY0 + 150_000), DAY0 + 300_000); // B ends at 300s
  // 30s before midnight, current video would run past it -> capped
  const nearMidnight = DAY0 + 86_400_000 - 30_000;
  assert.equal(nextBoundaryMs(channel, nearMidnight), DAY0 + 86_400_000);
});

test('dailyTimetable covers the day and restarts at midnight', () => {
  const entries = dailyTimetable(channel, DAY0 + 5000);
  assert.equal(entries[0].startMs, DAY0);
  assert.equal(entries[0].video.id, 'a');
  assert.equal(entries[1].startMs, DAY0 + 100_000);
  assert.equal(entries[3].startMs, DAY0 + 600_000); // second loop
  assert.equal(entries[3].video.id, 'a');
  assert.equal(entries.length, Math.ceil(86400 / 600) * 3);
  const last = entries[entries.length - 1];
  assert.ok(last.startMs < DAY0 + 86_400_000);
});

test('parseLineupDate validates format and calendar dates', () => {
  assert.equal(parseLineupDate('channels-15-08-2026.json'), Date.UTC(2026, 7, 15));
  assert.equal(parseLineupDate('channels-31-02-2026.json'), null); // no Feb 31
  assert.equal(parseLineupDate('channels-2026-08-15.json'), null); // wrong order
  assert.equal(parseLineupDate('channels.json'), null);
});

test('resolveLineupFile picks the latest dated file <= now', () => {
  const files = ['channels-12-08-2026.json', 'channels-01-09-2026.json', 'bogus.json'];
  // Before any dated file takes effect -> base
  assert.equal(resolveLineupFile(files, Date.UTC(2026, 7, 11, 23)), 'channels.json');
  // Exactly at effective midnight -> dated file
  assert.equal(resolveLineupFile(files, Date.UTC(2026, 7, 12)), 'channels-12-08-2026.json');
  // Later date wins once reached
  assert.equal(resolveLineupFile(files, Date.UTC(2026, 8, 2)), 'channels-01-09-2026.json');
  // No index at all -> base
  assert.equal(resolveLineupFile([], Date.now()), 'channels.json');
  assert.equal(resolveLineupFile(undefined, Date.now()), 'channels.json');
});
