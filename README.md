# RetroTV

A static website that turns curated YouTube playlists into an old-school broadcast TV
experience: a ~1994 CRT set in a dark room, channel changes with static, an LED channel
display, and — most importantly — a **fixed broadcast schedule**. Every visitor on Earth
sees the same programme at the same moment; you can't skip, rewind, or browse. If you
pause and come back, the TV catches up to the live position, just like real TV.

No backend, no build step, no frameworks. Deployable as-is to GitHub Pages.

## How the schedule works

- Each channel is an ordered playlist. It starts playing at **00:00 UTC** and loops until
  the next UTC midnight (the video airing at midnight gets cut — the day restarts).
- "What's on right now" is a pure function of the wall clock and the committed lineup
  data, so every browser independently computes the same result. A 15-second drift check
  re-seeks if playback falls behind (ads, buffering, pauses).
- The **GUIDE** button shows the derived timetable for today, in the visitor's local
  timezone.

## Running locally

Any static server works (the lineup JSON is fetched, so `file://` won't):

```bash
python3 -m http.server 8420
```

Then open http://localhost:8420. Press the power button (or `P`).

Controls: power `P` · channel `↑`/`↓` or digits · volume `←`/`→` · mute `M` · guide `G` ·
cinema `C`. Everything is also clickable on the TV front panel and the remote.

## Cinema mode

The **CINEMA** button (front panel, remote, or `C`) is the set's picture-size control — the
equivalent of the WIDE / P.SIZE button real sets grew in the late 90s. It gives the picture as
much room as possible *without* dropping the illusion: the cabinet frame, LED display, remote
and key hints all stay on screen, and only the plastic gives way.

`Esc` (or F11) leaves. The LED flashes `16:9` / `4:3` as you toggle, an amber lamp stays lit
while engaged, and the setting is remembered across visits.

### Why it wins so much space

Two things compound, and the first matters more than trimming any bezel:

- **The tube reshapes from 4:3 to 16:9.** A 4:3 CRT letterboxes every YouTube video, so a
  quarter of the tube height was permanently black bars. Going widescreen reclaims all of it.
- **The cabinet chrome shrinks** — thinner bezel and cabinet padding, compact front panel, no
  feet, tighter room padding — and the 880px desktop width cap is lifted.

Measured at a 1280×720 viewport: the actual video area goes from 217,152 px² to 675,675 px²,
**3.1× the picture**. On a landscape phone the gain is larger still.

### How it works

The whole set hangs off a single declaration in [style.css](style.css):

```css
width: min(
  var(--tv-w-cap),
  calc(100vw - var(--side-reserve)),
  calc((100dvh - var(--chrome-v)) * var(--tube-ratio))
);
```

Three competing constraints — a hard cap, the width left over beside the remote, and the
height left over above the front panel — and the smallest wins. Every number in it is a custom
property declared on `:root`, so **cinema mode is just a `body.cinema` block that redefines
those properties** (`--tube-ratio` 1.333 → 1.778, `--chrome-v` 200px → 84px, and so on). There
is no second layout and no duplicated formula.

Everything downstream is derived, which is why nothing else needed touching:

- `.screen` uses `aspect-ratio: var(--tube-ratio)`, so the tube reshapes itself.
- The YouTube iframe is `position: absolute; inset: 0` inside `.screen`, so it reflows with the
  cabinet. **There is no resize handler in the codebase and none is needed** — `player.js` is
  completely unaware cinema mode exists.
- `--chrome-v` is the one value that must match reality (the vertical space everything *except*
  the screen consumes). It was measured against the live page rather than guessed: exact fit is
  ~68px, and 84px is used to keep a safety margin on wide viewports.

On the JS side ([app.js](app.js)) `setCinema()` toggles a `cinema` class on `<body>`, mirrors it
into `state.cinema`, updates both buttons' `aria-pressed`, persists to `localStorage`, and calls
`requestFullscreen()` / `exitFullscreen()`. Fullscreen is best-effort: the call is wrapped in
`try/catch`, so where the browser refuses it (iOS Safari has no element fullscreen) the layout
change still applies. A `fullscreenchange` listener drops the layout back when you leave
fullscreen via `Esc` or F11, since the browser consumes those keys itself.

On load the picture size is restored but fullscreen is not — browsers only grant it in response
to a real click or keypress, never on page load.

## Curating channels

1. Edit [channels.config.json](channels.config.json) — per channel either a YouTube
   `"playlistId"` (a playlist you curate on your channel) or an explicit `"videoIds"` list.
2. Get a free YouTube Data API v3 key (Google Cloud console → enable *YouTube Data API
   v3* → create API key).
3. Regenerate the lineup (fetches titles + exact durations, drops non-embeddable videos):

```bash
YT_API_KEY=your-key-here node tools/fetch-channels.mjs
```

4. Commit the updated `channels.json` and deploy.

## The API key

The key is read from the `YT_API_KEY` environment variable by
[tools/fetch-channels.mjs](tools/fetch-channels.mjs) at authoring time only. Nothing in the
shipped site (`index.html`, `app.js`, `player.js`, `schedule.js`) ever reads it — the browser
only fetches the generated `channels.json`. So the key is not *needed* at runtime.

That is a statement about what the code does, **not** a guarantee that the key stays private.
This repo has no build step and no secret handling: anything sitting in the working tree gets
published the moment you push, because deploying is literally "push the repo" (see below).

Current state, so it isn't a surprise:

- `.keys` in the repo root contains a real API key in plaintext.
- [`.gitignore`](.gitignore) excludes `.keys`, so it will not be committed. This only helps
  going forward — it does nothing about a key that was already pushed somewhere.
- This README previously carried the same key inline in the example command above; it has
  been replaced with a placeholder.

Before you run `git init` / push anywhere public:

1. **Revoke the key that is in `.keys`** (Google Cloud console → Credentials → delete it) and
   issue a new one. Treat it as compromised — it has been sitting in plaintext in the working
   tree and in this README. This is the step that actually matters; ignoring the file does not
   un-expose a key.
2. Keep the key out of shell history and out of committed files — export it in your shell, or
   source it from the ignored `.keys` file:

```bash
YT_API_KEY=$(cat .keys) node tools/fetch-channels.mjs
```

3. Restrict the key in the Google Cloud console to the YouTube Data API v3 so a leak has the
   smallest possible blast radius.

## Fetching all video ids from playlist

```bash
node tools/playlist-ids.mjs 'https://www.youtube.com/playlist?list=PLxgxoREVANxMwH5wPiUYABGI4x7IB0H8L'
```
or
```bash
YT_API_KEY=$(cat .keys) node tools/playlist-ids.mjs 'https://www.youtube.com/playlist?list=PLxgxoREVANxMwH5wPiUYABGI4x7IB0H8L'
```

## Scheduled lineup changes (dated lineups)

`channels.json` is the base lineup. A file named `channels-DD-MM-YYYY.json` takes effect
at **00:00 UTC** of that date; among dated files, the latest date ≤ today wins. The base
file applies until the earliest dated file kicks in.

To prepare one, create `channels-DD-MM-YYYY.config.json` and run:

```bash
YT_API_KEY=your-key node tools/fetch-channels.mjs channels-25-12-2026.config.json
```

Static hosts can't list directories, so the site discovers dated files through
`channels-index.json`. The script rewrites it on every run; if you add or remove lineup
files by hand, refresh it with:

```bash
node tools/fetch-channels.mjs --reindex
```

## Tests

```bash
node --test
```

Covers the schedule math (day-anchored loop, midnight truncation, timetable derivation)
and the dated-lineup resolution rules.

## Deploying to GitHub Pages

Push the repo, then Settings → Pages → deploy from branch. All URLs are relative, so it
works from a project subpath. To change programming, re-run the fetch script and push.

Because deploying is "push the whole repo", everything not covered by
[`.gitignore`](.gitignore) becomes public — read [The API key](#the-api-key) first and make
sure the old key is revoked.

## Known limitations

- YouTube may insert ads for some viewers; the drift check re-syncs right after, so
  visitors stay within a few seconds to a minute of each other.
- The YouTube watermark and some hover UI can't be removed via the official IFrame API,
  and this project deliberately doesn't hack around it.
- Clicking the picture pauses it (the API allows that); on resume the TV jumps forward
  to the live position, so pausing never lets you fall behind.
- A playlist longer than 24 h never airs its tail (the day restarts at UTC midnight).
- The demo `channels.json` ships with *approximate* durations — regenerate it with the
  fetch script before relying on sync.
- Cinema mode's fullscreen half is best-effort: iOS Safari has no element fullscreen, so
  there the tube still goes widescreen but the browser chrome stays put.
