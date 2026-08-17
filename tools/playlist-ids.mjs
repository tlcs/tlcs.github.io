#!/usr/bin/env node
// Prints every video id in a YouTube playlist as a comma-separated list.
//
// Uses the YouTube Data API v3 when YT_API_KEY is set (most reliable), and
// otherwise scrapes the public playlist page, following continuations so
// playlists longer than 100 items still come back complete.
//
// Usage:
//   node tools/playlist-ids.mjs 'https://www.youtube.com/watch?v=x&list=PL...'
//   node tools/playlist-ids.mjs PL...            -> "a", "b", "c"
//   node tools/playlist-ids.mjs PL... --json     -> ["a","b","c"]
//   node tools/playlist-ids.mjs PL... --plain    -> a,b,c

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function main() {
  const args = process.argv.slice(2);
  const format = args.find((a) => a.startsWith('--'))?.slice(2) ?? 'quoted';
  const input = args.find((a) => !a.startsWith('--'));
  if (!input) fail('Usage: node tools/playlist-ids.mjs <playlist-url-or-id> [--json|--plain]');

  const playlistId = parsePlaylistId(input);
  const apiKey = process.env.YT_API_KEY;
  const ids = apiKey ? await idsFromApi(playlistId, apiKey) : await idsFromPage(playlistId);

  if (ids.length === 0) fail(`No videos found for playlist ${playlistId}`);

  if (format === 'json') console.log(JSON.stringify(ids));
  else if (format === 'plain') console.log(ids.join(','));
  else console.log(ids.map((id) => `"${id}"`).join(', '));

  console.error(`${ids.length} videos (${apiKey ? 'Data API' : 'page scrape'})`);
}

function parsePlaylistId(input) {
  if (/^[\w-]+$/.test(input)) return input;
  let url;
  try {
    url = new URL(input);
  } catch {
    fail(`Not a URL or playlist id: ${input}`);
  }
  const list = url.searchParams.get('list');
  if (!list) fail(`No "list" parameter in URL: ${input}`);
  return list;
}

// --- Data API path -----------------------------------------------------------

async function idsFromApi(playlistId, apiKey) {
  const ids = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
      pageToken,
      key: apiKey,
    });
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    if (!resp.ok) fail(`YouTube API failed (${resp.status}): ${(await resp.text()).slice(0, 400)}`);
    const data = await resp.json();
    for (const item of data.items || []) ids.push(item.contentDetails.videoId);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return ids;
}

// --- Page scrape path --------------------------------------------------------

async function idsFromPage(playlistId) {
  const html = await getText(`https://www.youtube.com/playlist?list=${playlistId}`);
  const initialData = extractJson(html, 'var ytInitialData = ');
  if (!initialData) fail('Could not find ytInitialData on the playlist page.');

  const innertubeKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
  const clientVersion = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? '2.20240101.00.00';

  const ids = [];
  const seen = new Set();
  let node = initialData;

  while (node) {
    for (const id of collectVideoIds(node)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const token = collectContinuationToken(node);
    if (!token || !innertubeKey) break;
    node = await browseContinuation(token, innertubeKey, clientVersion);
  }
  return ids;
}

async function browseContinuation(token, innertubeKey, clientVersion) {
  const resp = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${innertubeKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } },
      continuation: token,
    }),
  });
  if (!resp.ok) fail(`Continuation request failed (${resp.status})`);
  return resp.json();
}

// Walks the response tree collecting playlist entries in document order.
// YouTube serves either the older playlistVideoRenderer or the newer
// lockupViewModel shape depending on which layout the request lands on.
function collectVideoIds(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectVideoIds(item, out);
  } else if (node && typeof node === 'object') {
    if (node.playlistVideoRenderer?.videoId) out.push(node.playlistVideoRenderer.videoId);
    const lockup = node.lockupViewModel;
    if (lockup?.contentId && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      out.push(lockup.contentId);
    }
    for (const value of Object.values(node)) collectVideoIds(value, out);
  }
  return out;
}

function collectContinuationToken(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = collectContinuationToken(item);
      if (found) return found;
    }
  } else if (node && typeof node === 'object') {
    const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
    for (const value of Object.values(node)) {
      const found = collectContinuationToken(value);
      if (found) return found;
    }
  }
  return null;
}

async function getText(url) {
  const resp = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en' } });
  if (!resp.ok) fail(`Fetch failed (${resp.status}): ${url}`);
  return resp.text();
}

// Pulls the JSON object that follows `marker`, tracking brace depth so nested
// objects and braces inside strings don't end it early.
function extractJson(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  let i = html.indexOf('{', start);
  if (i === -1) return null;

  const from = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(from, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main();
