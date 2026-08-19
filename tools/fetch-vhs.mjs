#!/usr/bin/env node
// Builds the VHS catalogue (vhs.json) from vhs.config.json using the YouTube
// Data API v3. Unlike the broadcast lineup, tapes are picked by hand and play
// on demand — but they still have to be embeddable, so this refuses to ship a
// tape the tube cannot actually play, and says which one and why.
//
// Usage:
//   YT_API_KEY=xxx node tools/fetch-vhs.mjs
//   YT_API_KEY=$(cat .keys) node tools/fetch-vhs.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://www.googleapis.com/youtube/v3';

async function main() {
  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) fail('Set YT_API_KEY (free key from https://console.cloud.google.com, YouTube Data API v3).');

  const raw = JSON.parse(await readFile(join(ROOT, 'vhs.config.json'), 'utf8'));
  const configs = Array.isArray(raw) ? raw : raw.tapes;
  if (!Array.isArray(configs)) fail('vhs.config.json: expected an array or { "tapes": [...] }');

  const tapes = [];
  const rejected = [];
  const warnings = [];

  for (let i = 0; i < configs.length; i += 50) {
    const batch = configs.slice(i, i + 50);
    const data = await apiGet('videos', {
      part: 'contentDetails,status,snippet',
      id: batch.map((c) => c.id).join(','),
      key: apiKey,
    });
    const found = new Map((data.items || []).map((item) => [item.id, item]));

    for (const cfg of batch) {
      const item = found.get(cfg.id);
      const reject = (why) => rejected.push({ id: cfg.id, why });

      if (!item) { reject('not found / private / deleted'); continue; }
      if (item.status?.embeddable === false) { reject('embedding disabled by the uploader'); continue; }
      // Age-restricted videos refuse to play in ANY embed — YouTube insists on a
      // signed-in age check on its own site. The API still reports embeddable:true,
      // so this has to be checked separately or the tape ships and never starts.
      if (item.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') {
        reject('age-restricted — will not play in an embed');
        continue;
      }
      const blocked = item.contentDetails?.regionRestriction?.blocked;
      if (blocked?.length) warnings.push({ id: cfg.id, why: `blocked in ${blocked.length} region(s)` });
      const duration = parseIsoDuration(item.contentDetails?.duration);
      if (!duration) { reject('no duration (live stream or premiere?)'); continue; }

      tapes.push({
        id: cfg.id,
        title: cfg.title ?? item.snippet?.title ?? cfg.id,
        genre: cfg.genre ?? 'Inne',
        duration,
        // Sleeve art: the video's own thumbnail unless a cover is supplied.
        ...(cfg.cover ? { cover: cfg.cover } : {}),
      });
    }
  }

  const out = { generatedAt: new Date().toISOString(), tapes };
  await writeFile(join(ROOT, 'vhs.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote vhs.json (${tapes.length} tape${tapes.length === 1 ? '' : 's'})`);

  if (rejected.length) {
    console.warn(`\n${rejected.length} tape(s) left out — the tube can't play these:`);
    for (const r of rejected) console.warn(`  ${r.id}  ${r.why}`);
    console.warn('\nThese never start in an embedded player, so they are dropped rather than');
    console.warn('shipped as a sleeve that plays nothing. Find another upload of the same film.');
  }

  if (warnings.length) {
    console.warn('\nShipped, but worth knowing:');
    for (const w of warnings) console.warn(`  ${w.id}  ${w.why}`);
  }
}

function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return 0;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x || 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

async function apiGet(endpoint, params) {
  const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    fail(`YouTube API ${endpoint} failed (${resp.status}): ${body.slice(0, 400)}`);
  }
  return resp.json();
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main();
