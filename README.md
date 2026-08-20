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

The set waits for that press on purpose. Starting itself on load was tried and reverted: Chrome
refuses to autoplay with sound before a gesture, so it had to come up muted and hand the player
back to the real mute setting on the first interaction — and powering on at load meant racing
the YouTube iframe into existence on every visit, which needed readiness guards threaded through
`setChannel()` and `tune()`. It stayed glitchy in Chrome. If you pick this up again, fix the
ordering (wait for the player before tuning) rather than guarding around the race.

Controls: power `P` · channel `↑`/`↓` or digits · volume `←`/`→` · mute `M` · guide `G` ·
cinema `C` · video library `V`. Everything is also clickable on the TV front panel and the
remote — though the remote only appears when it fits beside the set; wherever it would have to
sit underneath it stows itself, since the front panel carries every control it has. With a tape
in, `↑`/`↓` become forward/rewind and `G` becomes play/pause.

## Cinema mode

The **CINEMA** button (front panel, remote, or `C`) is the set's picture-size control — the
equivalent of the WIDE / P.SIZE button real sets grew in the late 90s. It gives the picture as
much room as possible *without* dropping the illusion: the cabinet frame, LED display and key
hints all stay on screen, and only the plastic gives way.

The remote steps aside here too — standing beside the tube it costs ~150px of width, which the
picture takes instead. Its CINEMA button goes with it, so you leave via the front panel, `C`, or
`Esc`; the panel button is always there.

`Esc` (or F11) leaves. The LED flashes `16:9` / `4:3` as you toggle, the CINEMA button itself
stays lit amber while engaged, and the setting is remembered across visits.

### Why it wins so much space

Three things compound, and the first matters more than trimming any bezel:

- **The tube reshapes from 4:3 to 16:9.** A 4:3 CRT letterboxes every YouTube video, so a
  quarter of the tube height was permanently black bars. Going widescreen reclaims all of it.
- **The cabinet chrome shrinks** — thinner bezel and cabinet padding, compact front panel, no
  feet, tighter room padding — and the 880px desktop width cap is lifted.
- **The remote's column is reclaimed** — `--side-reserve` drops from 150px to 16px once it is
  hidden.

Measured at a 1280×720 viewport: the actual video area goes from ~217,000 px² to ~676,000 px²,
**3.1× the picture**. On a landscape phone the gain is larger still.

How much that last point adds depends on which of the three constraints binds. On an exactly
16:9 viewport the height runs out first, so reclaiming the remote's column buys no extra size
(the tube simply cannot get taller) — it is a tidier layout, not a bigger one. On taller or
narrower windows the width binds and it is worth a further 1.2–1.3× in area.

### How it works

The whole set hangs off a single declaration in [style.css](style.css):

```css
width: min(
  var(--tv-w-cap),
  calc(100vw - var(--side-reserve)),
  calc((100dvh - var(--chrome-v)) * var(--tube-ratio))
);
```

Three competing constraints — a hard cap, the width left over beside the remote (when it is
shown), and the height left over above the front panel — and the smallest wins. Every number in it is a custom
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

## VHS mode

The cabinet is a TV/VCR combi: its front panel is a **deck front**, with a tape slot taking the
width the controls don't and carrying the TELSTAR brand on its lip — which is where the badge
went, and how the slot gets to near cassette scale. The controls sit beside it as a 2×3 block,
each column a pair (CH, VOL, GUIDE/CINEMA).

Press the slot and the **rental shelf** rises in the room below the set — sleeves standing
face-out, grouped by genre. Pick one and it plays.

Loading and ejecting each take about four seconds, on purpose. The deck throws up its blue
field — `PLAY ▶` going in, `EJECT` coming out — and holds it for exactly as long as the
mechanism underneath runs.

The pause and the noise are most of what makes it feel like a machine rather than a button.

The sound is a real recording of a deck, trimmed to just the mechanism and played whole. Both
files are named in `TAPE_SOUNDS` at the top of the deck-sound section in [app.js](app.js):

```js
const TAPE_SOUNDS = {
  insert: { url: 'sound/trimmed_vhs_in.mp3' },
  eject: { url: 'sound/trimmed_vhs_out.mp3' },
};
```

Each entry also accepts an optional `offset` and `duration` in seconds — Web Audio plays a
sub-range natively, so a cut can be adjusted there without re-encoding the file.

`playTapeMechanism()` returns the length it actually played, and the blue field holds for that
long, so swapping in a longer or shorter recording retimes the screen by itself. If a file can't
be fetched or decoded the deck runs silent — the blue field still holds for a beat rather than
cutting straight to the picture, so the mode keeps working without its sound.

A tape is not broadcast, and the set knows the difference:

- **Schedule enforcement stops.** No drift correction, no programme boundaries, no channel
  changes — the aerial is effectively unplugged until the tape comes out.
- **You can pause.** That's the whole point of owning the tape rather than catching the airing.
- **The set shows which source is live.** The `VHS` legend on the slot lip backlights amber, and
  the LED goes amber with it — green digits are a channel, amber digits are a tape counter, so
  the source reads from across the room without reading the number.
- **The LED becomes a tape counter**, `H:MM`, the way every VCR's display did.
- **The buttons become the transport.** `CH −/+` rewind and forward 30s, `GUIDE` is play/pause.
  They relabel themselves to `◀◀ ▶▶ ▶❙❙` while a tape is in, and change back on eject.
- **Press the slot again to eject**, which returns to live TV, caught up to wherever the
  schedule has got to in the meantime.
- **A tape that refuses to play is spat back out.** If the player errors, the LED shows `ERR`
  and the set ejects to broadcast rather than sitting on static.

Tapes **hold their position** like real ones — eject halfway through and it resumes there next
visit, kept in `localStorage` per tape. Stop past the halfway mark and the sleeve says
**BE KIND, REWIND** until you watch it out. Keyboard: `V` for the library.

Cinema mode hides the shelf: that mode exists to give the picture room, and a shelf beside it
defeats the point.

### Curating tapes

Edit [vhs.config.json](vhs.config.json) — one entry per tape, `id` plus a `genre`, with optional
`title` and `cover` overrides. Then:

```bash
YT_API_KEY=$(cat .keys) node tools/fetch-vhs.mjs
```

That writes `vhs.json` with titles and runtimes. Sleeve art is the video's own thumbnail unless
you supply a `cover` URL.

**The script refuses tapes the tube cannot play**, naming each one and why — better an honest
gap in the shelf than a sleeve that plays nothing. Two things disqualify a video, and both are
common on full-length films:

- **Embedding disabled** by the uploader. The player shows "Video unavailable".
- **Age-restricted** (`ytAgeRestricted`). These never play in *any* embed — YouTube insists on a
  signed-in age check on its own site. **The API still reports `embeddable: true` for them**, so
  embeddability alone is not a sufficient test; this is checked separately, and it is the trap
  worth remembering when a tape mysteriously won't start.

Region-blocked videos are shipped but flagged, since they play for some visitors and not others.

Expect a high rejection rate when hunting for films, so run candidates through the script before
building anything around them. It reports on every id in the config, which means rejected ones
can stay in `vhs.config.json` as a record of what was already tried. YouTube ids are always
**11 characters** — a shorter one is a copy error, and shows up as "not found".

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

- YouTube may insert ads for viewers without Premium. While one is on, the player's clock
  describes the *ad*, not the programme — so the app detects the break and suspends schedule
  enforcement for its duration, then catches up to live on the first check afterwards.
  Visitors still stay within a few seconds to a minute of each other. Without that guard the
  drift check "corrects" against the ad's clock and seeks continuously, which leaves the ad
  audible but not visible.
- Ad detection is a heuristic — the IFrame API exposes no ad event, so a player duration of
  three minutes or less on a longer programme is read as an ad. Consequently an unusually long
  ad, or a scheduled video under three minutes, falls back to the unguarded behaviour.
- The YouTube watermark and some hover UI can't be removed via the official IFrame API,
  and this project deliberately doesn't hack around it.
- Clicking the picture pauses it (the API allows that); on resume the TV jumps forward
  to the live position, so pausing never lets you fall behind.
- A playlist longer than 24 h never airs its tail (the day restarts at UTC midnight).
- The demo `channels.json` ships with *approximate* durations — regenerate it with the
  fetch script before relying on sync.
- Cinema mode's fullscreen half is best-effort: iOS Safari has no element fullscreen, so
  there the tube still goes widescreen but the browser chrome stays put.
- Most full-length films on YouTube are either age-restricted or have embedding disabled, so
  the VHS catalogue is limited to what will actually play in an embed. See *Curating tapes*.
- The tape counter reads `H:MM`, not `H:MM:SS` — seven characters don't fit the LED window
  without shrinking the digits below legibility, and four matches every other thing it shows.
