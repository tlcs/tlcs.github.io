#!/usr/bin/env node
// Builds a lineup JSON (video ids, titles, exact durations) from a hand-edited
// config file, using the YouTube Data API v3. Also maintains channels-index.json,
// the manifest of dated lineup files that the site reads at runtime.
//
// Usage:
//   YT_API_KEY=xxx node tools/fetch-channels.mjs                      -> channels.json
//   YT_API_KEY=xxx node tools/fetch-channels.mjs channels-15-08-2026.config.json
//   node tools/fetch-channels.mjs --reindex                           -> index only

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://www.googleapis.com/youtube/v3';
const LINEUP_RE = /^channels-\d{2}-\d{2}-\d{4}\.json$/;

async function main() {
  const arg = process.argv[2];

  if (arg === '--reindex') {
    await writeIndex();
    return;
  }

  const configName = arg ? basename(arg) : 'channels.config.json';
  if (!configName.endsWith('.config.json')) {
    fail(`Config file must end in .config.json, got: ${configName}`);
  }
  const outputName = configName.replace(/\.config\.json$/, '.json');

  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) fail('Set YT_API_KEY (free key from https://console.cloud.google.com, YouTube Data API v3).');

  const raw = JSON.parse(await readFile(join(ROOT, configName), 'utf8'));
  const channelConfigs = Array.isArray(raw) ? raw : raw.channels;
  if (!Array.isArray(channelConfigs)) fail(`${configName}: expected an array or { "channels": [...] }`);

  const channels = [];
  for (const cfg of channelConfigs) {
    const ids = cfg.playlistId ? await playlistVideoIds(cfg.playlistId, apiKey) : cfg.videoIds || [];
    const videos = await videoDetails(ids, apiKey, `${cfg.name ?? cfg.number}`);
    if (videos.length === 0) console.warn(`WARNING: channel ${cfg.number} (${cfg.name}) has no airable videos`);
    channels.push({ number: cfg.number, name: cfg.name, videos });
  }

  const out = { generatedAt: new Date().toISOString(), channels };
  await writeFile(join(ROOT, outputName), JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${outputName} (${channels.length} channels)`);
  await writeIndex();
}

async function playlistVideoIds(playlistId, apiKey) {
  const ids = [];
  let pageToken = '';
  do {
    const data = await apiGet('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
      pageToken,
      key: apiKey,
    });
    for (const item of data.items || []) ids.push(item.contentDetails.videoId);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return ids;
}

async function videoDetails(ids, apiKey, channelLabel) {
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet('videos', {
      part: 'contentDetails,status,snippet',
      id: batch.join(','),
      key: apiKey,
    });
    const found = new Map((data.items || []).map((item) => [item.id, item]));
    for (const id of batch) {
      const item = found.get(id);
      if (!item) {
        console.warn(`  skip ${id} (${channelLabel}): not found / private / deleted`);
        continue;
      }
      if (item.status?.embeddable === false) {
        console.warn(`  skip ${id} (${channelLabel}): embedding disabled`);
        continue;
      }
      const duration = parseIsoDuration(item.contentDetails?.duration);
      if (!duration) {
        console.warn(`  skip ${id} (${channelLabel}): no duration (live stream or premiere?)`);
        continue;
      }
      videos.push({ id, title: item.snippet?.title ?? id, duration });
    }
  }
  return videos;
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

async function writeIndex() {
  const files = (await readdir(ROOT)).filter((f) => LINEUP_RE.test(f)).sort();
  await writeFile(join(ROOT, 'channels-index.json'), JSON.stringify(files, null, 2) + '\n');
  console.log(`Wrote channels-index.json (${files.length} dated lineup files)`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main();
