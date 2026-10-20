# Next, after iteration 9 (friends, Maize.Live, and a version number)

All three items in `prompt_9.md` are done, following `PLAN_9.md`. Nothing is
committed.

## What was done

### 1. Multiplayer, ported from the reference

The p3p2 work in `~/Repos/mine/public/p3p2_test_repos/dp-paintball`, branch
`p3p2` (`7593b74..9b8f141`), was applied to this repo's `src/` and
`vite.config.ts` as one patch. It applied without conflicts, because that branch
starts at `1ca3451`, the parent of `prompt 9`.

- **New files:** `src/net/` (four files) and `src/build.d.ts`.
- **Changed files:** 21 game files, through hooks that do nothing without a room.

How it plays is as `PLAN_9.md` §1.1 describes:
- friends take the bots' places;
- the host's page runs the bots and the crates;
- the page that fires a ball decides whether it hit;
- tags and paint go through the room's log;
- FRIENDS on the pause card opens p3p2's panel.

What changed from the reference:

- **The client comes from npm** (`@p3p2/client@^0.1.1`). There is no `vendor/`
  tarball. The published 0.1.1 and the reference's tarball have the same API.
  The only difference in the code is a dropped migration of old `playerone:`
  storage keys.
- **p3p2's `game.version` is the commit**, not a per-build timestamp, and it is
  the same constant the corner label uses (§3). **One correction to the plan:**
  the plan said "the full hash", but p3p2 rejects a version over 32 characters
  (`game.version: 1 to 32 characters`). A 40-character hash threw while
  `main.ts` was loading, and the park never booted; the test course still
  booted because it has no p3p2. It is now the first 12 characters.
- **A link to p3p2.me**, in a note under FRIENDS on the pause card: *"Friends
  join through a p3p2 server of your own · p3p2.me"*. p3p2's panel asks for a
  room URL and says nothing about where one comes from. The README has a line
  too. FRIENDS and the note are one element, shown and hidden together.

### 2. "More games on Maize.Live"

- **Placement:** on the loading card under the fork badge, and on the pause
  card next to the fork badge, in a row that wraps on narrow screens.
- **Behaviour:** links to `https://maize.live` in a new tab. On the pause card,
  pressing it doesn't resume the round, like the repo link.
- **Style:** `.maize-link` lives in `index.html`'s inline styles, shared the
  same way `.fork-badge` is, so it costs no request. It is cream and ink, the
  quieter of the two links.

### 3. The version in the corner

- **Where it comes from:** `vite.config.ts` reads the commit from
  `GITHUB_SHA` (set by the Pages workflow), then `git rev-parse HEAD`, then
  `dev`.
- **How it gets on the page:** a small `transformIndexHtml` hook writes
  `v.<first four characters>` into `index.html`. So it paints with the loading
  card, and it is still there if the module fails to load.
- **Desktop:** bottom right.
- **Phone:** in the 20px gutter under the right trigger, 8px from the right and
  4px from the bottom, clear of every button.
- **Layering:** it takes no clicks. It sits at z-index 11 at the page's top
  level, above the loading card. `#app` is `position: fixed`, so the game is one
  stacking layer and nothing can sit between its layers from outside. The label
  therefore shows over the pause and results cards too, where the plan had it
  below them. It is 10–11px, translucent, and nothing it covers is clickable.

### The phone's pause card, made to fit again

The screenshots showed a problem. With FRIENDS (from the reference) and the
links row added, the pause card on an 844×390 landscape phone ran **58px past
the screen**, so FRIENDS' note and both links were below the fold. Before this
iteration it fit with about 16px to spare.

For touch only (`.is-touch`):
- the card is up to 800px wide instead of 560, which puts the key legend on one
  row at 844 wide;
- the "Central Park Paintball" eyebrow is hidden;
- FRIENDS sits beside its note rather than above it;
- the gaps and the badge are a little smaller.

It now ends at 343 of 390px. Smaller landscape phones still scroll a little:
- 740×360: 19px over, against about 14px before this iteration;
- 667×375: 4px over.

The desktop card is unchanged.

## Tests

| suite | before | now | |
| --- | --- | --- | --- |
| the 12 existing suites | 250 | 250 | all pass on the port, unchanged |
| `ui-test` | 23 | 37 | +14, below |
| `touch-test` | 25 | 27 | the label clears every touch button; the pause card fits without scrolling |
| `net-test` (new) | — | 8 | multiplayer against a real p3p2 server |

`npm test` now runs 13 suites, 274 checks. **All 274 pass**, in one run of the
whole chain on the final build, on an idle machine (909s; `mural-test` is
about 7 minutes of that).

**`ui-test`, new checks:**
- An ordinary visit opens no socket and asks no other origin for anything.
- Of p3p2's files, only its entry loads until a room is opened.
- Alone, the park is the player and six bots.
- The loader and the pause card both link to Maize.Live, and neither link
  resumes the round.
- FRIENDS and the p3p2.me note are on the park's pause card.
- The version label:
  - matches `v.xxxx`;
  - sits bottom right;
  - covers nothing on the HUD;
  - takes no clicks.
- The test course has no room.

If the build is older than HEAD, the label check still passes, but its detail
says the build came from another commit and should be rebuilt.

**`net-test`** has 8 of the archived 15 multiplayer tests. The solo case is in
`ui-test`, so it runs without a server. Server and GPU requirements:
- **Server:** each case starts its own p3p2 server.
  - With `P3P2_DIR=<p3p2 checkout>` set, it runs that checkout's server.
  - Otherwise it uses Docker `p3p2/p3p2:0.1.1` (`P3P2_IMAGE` overrides it).
  - With neither, it prints `SKIP` and exits 0.
- **GPU:** it needs one. It launches Chrome with `tools/perf.mjs`'s Vulkan flags
  and falls back to SwiftShader with a `WARN` line.
- **Single case:** `NET_ONLY=<words>` runs one case.

### Why net-test needs the GPU

The first full run was on SwiftShader, like every other suite, and passed only
2 of 8. Each failure looked like a game bug:
- painted decals disagreed between pages;
- a late joiner was missing most of the paint;
- bots' positions drifted apart.

None of them was a game bug. Measured:
- **SwiftShader:** a page gets 0.4–2.8 frames a second, three pages in one
  browser even less.
- **Default headless flags on the GPU:** still 3 fps.
- **`perf.mjs`'s flags** (Vulkan + GPU rasterisation): three pages at 60fps each
  with vsync on, 88–109fps uncapped.

The other suites step the simulation by hand, so they don't care about frame
rate. A room runs on the wall clock, so slow frames break it:
- The log's paint drains at a minimum of one splat a frame
  (`Net.paintSome`), so a page at one frame a second is a minute behind.
- A guest that had just booted took 45 seconds to show the Join dialog.

On the GPU the same eight cases pass in about 100 seconds. The
`[73,45]`-decals failure became "11 and 11 decals", and the late joiner went
from 25 of 159 to "47 / 47 / 47". A code change made one of the passes
possible: the crate case had assumed three crates are always out at the start,
which is false once a bot has taken one. It now compares the guest's crates
with the host's.

Runs on the GPU, all 8/8:
- three times against the Docker image `p3p2/p3p2:0.1.1`;
- once against the server of the p3p2 checkout at `~/Repos/mine/public/p3p2`
  (`P3P2_DIR`), which is newer than 0.1.1.

### A finding on the side: this machine has a GPU now

`NEXT_6.md` (and every NEXT since) says this machine can't run
`tools/perf.mjs`. It can now. Headless Chrome reaches an **NVIDIA RTX 3060**
through Vulkan, EGL and the default backend. `npm run perf` on this build:

| spot | median | p95 | worst |
| --- | --- | --- | --- |
| plaza-fountain | 14.70ms | 26.60 | 33.40 |
| mall-allee | 13.40 | 24.40 | 30.40 |
| ramble | 13.10 | 28.60 | 42.40 |
| wide-lake | 12.60 | 13.90 | 15.90 |

That is 68fps at the worst median, at 1920×1080, with load-to-playable in
1.9s. A desktop RTX 3060 is far above the spec's target (an iGPU, an entry-level
phone), so this says nothing about the target hardware. It does make this
machine usable for relative frame-time comparisons, which it wasn't before.

## Load budget

Measured with gzip -9 on the build:
- **Entry chunk:** 227.4 KB → 236.7 KB.
- **p3p2's entry:** a new 2.3 KB chunk, preloaded alongside.
- **Total:** **+11.7 KB on first load**, close to the plan's estimate of 11.

p3p2's room client, panel and QR code (about 16 KB) load only when a room is
opened, and `ui-test` now checks that. So no deferral of `Net` was needed.

## Still open

- **The six multiplayer tests not ported:**
  - a slow connection that drops;
  - Chrome + Firefox + WebKit in one park;
  - a phone;
  - traffic;
  - a small log;
  - seven players.

  They need p3p2's lag proxy, other browser engines and the server's counters.
  They passed in the reference against the same client API, and are a follow-up
  if wanted.
- **The reference's "Not done" list** carries over unchanged (`PLAN_9.md`
  §1.6), for example:
  - a friend's taunt isn't shown to the others;
  - opening a room wipes the park's earlier paint;
  - an eighth friend only watches.
- **Nobody has played a room by hand yet.** Every check so far is headless. To
  play one:
  1. Run a p3p2 server (`npm run dev` in `~/Repos/mine/public/p3p2`, port 8080,
     or the Docker image).
  2. Create a room in its portal for the game's address.
  3. In the game: Esc → FRIENDS → paste the room URL.
  4. Open the invite in a second browser.

  What only a person can judge: hits on a friend over a real delay, how the
  bots look drawn 160ms behind on a guest's screen, and how paint arriving from
  the others feels.
- **Friends' 👥 on a phone:** FRIENDS is only on the pause card, as in the
  reference. Not tried on a real phone.
- **Loader on a fast connection:** the loader's Maize.Live link is up only
  while the game loads. If it should stay longer, the phone's "tap to start"
  card is the next place for it.
- **Older items:** iOS generally, `NEXT_2.md` P2 and `NEXT_3.md` P1 are still
  open, as in `NEXT_8.md`.

## Next

Play a room by hand in two browsers, and on a phone. Then choose from
`GAMEPLAY_8.md`. Its outs and spread spawns matter more with friends in the
park, since tags against a person carry more weight than tags against a bot.
