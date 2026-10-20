# Plan 9 — friends in the park, a way to more games, and a version number

`CLAUDE/prompt_9.md` asks for three things:

1. Multiplayer through `@p3p2/client`, with the checkout at
   `~/Repos/mine/public/p3p2_test_repos/dp-paintball` as a reference, and a link to p3p2.me.
2. A "more games on Maize.Live" link on the loading page and the pause screen.
3. The version, `v.<first 4 characters of the deployed commit>`, in an unused corner.

Item 1 is mostly built already. The reference checkout is a fork of this repo. Its branch `p3p2`
starts at `1ca3451`, which is the parent of this repo's HEAD; the only commit since is
`prompt 9`, and it adds nothing but the prompt. On top of that base the branch adds
multiplayer in six commits (`7593b74..9b8f141`: 32 files, +2,308 / −125). Its source changes
apply to `main` without conflicts (`git apply --check` passes). So this plan **ports** that
work rather than redoing it, and spends its effort on what the port changes, on testing it here,
and on items 2 and 3.

---

## 1. Multiplayer

### 1.1 What the reference built (kept as it is)

Friends take the bots' places. Played alone, the game does exactly what it does now. In a room:

| What | Who owns it |
| --- | --- |
| Your own body, camera, marker, ammo | Your page. Sent to the others as presence, 20 times a second |
| The bots in empty places, and the crates | The host's page. It reports the bots 10 times a second, and the other pages draw them 160ms behind |
| A shot | Sent to everybody and flown on every page, advanced by how old it is when it arrives |
| Whether a ball hit | The page of whoever fired it. For a bot's ball, the page of the friend it reaches |
| Tags, scores, paint on bodies, on the park and on the board | Ops in the room's log, applied in one order on every page. A late joiner gets them from the log |
| Round start, clock, whistle | Ops written by the host. After the whistle, a click from anybody starts the next round |
| Who sits where | A room value written by the host |

The decisions from `ai/p3p2_plan.md` §3 in the reference carry over:
- Seven places at most. An eighth friend only watches.
- The shooter's page judges hits.
- The park's paint stays from round to round, as it does alone.
- In a room, pausing doesn't stop the park.
- The score belongs to the place.

The p3p2 panel has no 👥 button. **FRIENDS** is on the pause card, because every corner of a
phone is taken and on a computer the pointer is only free on the pause card.

The code:
- **New:** `src/net/` (`Net.ts`, `wire.ts`, `records.ts`, `NameTags.ts`, about 1,400 lines)
  and `src/build.d.ts`.
- **Changed:** 22 game files, mostly small hooks that do nothing without a room:
  - bots can be moved from outside;
  - a figure can change colour and be absent;
  - a tag can be worked out on one page and applied on all of them;
  - the round and the crates can be owned by the host;
  - paint can be told which shape to draw.
- **Test handle:** `window.__paintball.net`, with a `fingerprint()` the tests compare across
  pages.

Evidence that it works, from the reference's `ai/p3p2_next.md`:
- 15 browser tests passed in p3p2's harness at the time. They covered two to seven players,
  late joiners, host hand-off, reloads, crates, a 150ms lossy link, Chrome + Firefox + WebKit,
  a phone, and a small log.
- This repo's 12 suites passed on that branch, apart from the crate flakes that `NEXT_8.md`
  already describes on `main`.

### 1.2 What changes in the port

1. **The client comes from npm, not from a vendored tarball.** The reference depends on
   `file:vendor/p3p2-client.tar.gz`. Instead: `npm install @p3p2/client` (0.1.1 is the latest)
   and no `vendor/` folder. I checked the published 0.1.1 against the tarball:
   - The type declarations are identical apart from one comment.
   - The JS differs only by a removed migration of old `playerone:` localStorage keys. This
     game never shipped with the old name, so that doesn't matter.

   `vite.config.ts` gets `optimizeDeps: { exclude: ['@p3p2/client'] }`, which the package
   README asks for. Without it, the dev server bundles the whole library into the first load.
2. **The version comes from the commit, not the clock.** The reference sets p3p2's
   `game.version` from `Date.now()` per build, to keep players on different builds in different
   rooms. The commit does the same job, and item 3 needs it anyway. One constant serves both
   (§3).
3. **A link to p3p2.me.** p3p2.me is p3p2's site: what it is, and how player one sets up the
   small relay server that the room URL comes from. The panel itself doesn't link to it (I
   checked the 0.1.1 bundle). A player who opens FRIENDS without a server has no way to find
   out what to paste. So:
   - The pause card gets a one-line note under FRIENDS: *"Friends join through a p3p2 server
     of your own · p3p2.me"*. It shows only when FRIENDS does, so not on the test course.
   - The README gets a credit line next to the Maize.Live one.
4. **Multiplayer tests live in this repo** (§1.4). The reference's 15 tests can't be run as
   they are. They were archived to `~/Repos/mine/private/p3p2-private/e2e/tests/games/` when
   p3p2 split, and public p3p2's harness has moved on: `gameUrl`, `GL_ARGS`, `PATIENCE`,
   `SERVER` and `GAME_VIEWPORT` are gone, and every test now starts its own server.
5. **The reference's notes stay in the reference.** Its plan and next notes are in `ai/`, a
   folder this repo doesn't have. I won't copy them. This plan restates the decisions that
   matter, and `NEXT_9.md` will record what was ported and from which commit.

Everything else ports as it is. That includes the FRIENDS button's markup and styling, the
"The park goes on without you." subtitle on the pause card in a room, and the name tags.

### 1.3 Steps

1. Apply the reference's diff `1ca3451..p3p2` for `src/`, `vite.config.ts` and `src/style.css`.
   Leave out `package.json`, `package-lock.json`, `vendor/` and `ai/`.
2. `npm install @p3p2/client@^0.1.1`.
3. Replace `__BUILD__ = Date.now()` with the commit constant from §3.
4. Add the p3p2.me note to `PauseOverlay` (and its CSS), next to the ported FRIENDS button.
5. `npm run build`. Compare the first-load size with main's (§1.5), then run `npm test`.
6. Write `tools/net-test.mjs` (§1.4) and run it.
7. Try it by hand in two browsers against a local p3p2 server (Chrome + Firefox, as p3p2's
   `docs/testing.md` describes). Do one round on a phone over LAN if one is to hand.

### 1.4 Testing multiplayer here

`tools/net-test.mjs` uses `playwright-core` and is built like the other suites. It starts a p3p2
server, logs in to the portal, creates a room for the preview server's address, and drives
separate browser contexts (separate profiles, because two tabs of one browser are one player
to p3p2). Where the server comes from:
- `P3P2_DIR=<p3p2 checkout>`: `node server/src/main.ts`, with `P3P2_PORT`,
  `P3P2_OWNER_PASSWORD`, `P3P2_DATA_DIR=:memory:` and `P3P2_PUBLIC_URL`, as p3p2's own
  `e2e/tools/server.ts` starts it.
- Otherwise, Docker `p3p2/p3p2:0.1.1` if `docker` is on the path.
- Otherwise it **skips with a message**, so `npm test` stays green on a machine without
  either.

It ports the first nine of the archived fifteen, comparing `net.fingerprint()` across pages:

1. Alone: the game is unchanged, FRIENDS is on the pause card, and the page opens no WebSocket
   and requests nothing cross-origin.
2. Host and guest: the guest takes bot 1's place and colours on both pages, and both pages show
   the same bots, clock, scores and paint.
3. A guest's ball that reaches the host counts on both pages, and so does the paint it leaves.
4. A late joiner gets the park's paint and the scores from the log.
5. The bots go for a guest, and the guest's page judges their balls. They don't while the
   guest's tab is in the background. A frozen host hands the bots on within 5s.
6. The round ends for everybody, a guest's click starts the next one, the park's paint stays,
   and the board's front is wiped.
7. The host closes the page: the next player runs the bots and the round goes on.
8. Reload of a guest, and of the host: back in the same place with the same park.
9. A crate goes to whoever reaches it first, and is gone for everybody.

The six left out need machinery that only p3p2's harness has: the lag proxy, Firefox and WebKit
engines, the server's traffic counters, a log-size override, and seven contexts. Those are
`a slow connection that drops`, `three engines`, `a phone`, `traffic`, `a small log` and
`seven players`. They passed on the reference against the same client API. If you want them
here too, that's a follow-up (see Decisions).

The new solo checks (item 1 in the list above) go into `ui-test` rather than `net-test`, so they
run even when no server is available.

### 1.5 Cost to the load budget

Measured with gzip -9: main's entry chunk built today is 227.4 KB, and the reference's build of
the same base plus multiplayer is 236.2 KB. On top of that comes p3p2's entry chunk, 2.3 KB,
fetched in parallel. That's **about +11 KB gzipped on first load**, roughly 1% of what the page
already fetches (Rapier's wasm alone is ~570 KB). The panel, room client and QR code (~16 KB)
load only when a room is opened. An ordinary visit contacts no server. I'll measure this again
after the port. If it comes in well above the estimate, the fallback is to load `Net` with a
dynamic `import()` when a room starts: its hooks are plain fields on the systems it attaches to,
so they can be installed late.

### 1.6 Gaps carried over (from the reference's "Not done")

- An eighth friend watches, and doesn't see whoever is in the first place.
- A friend's taunt (T) isn't shown to the others.
- When your ball hits a friend on your screen, it stops there on every page. If on their screen
  it flew past, the wall behind stays clean.
- A guest sees the bots' drawings on the board arrive as paint, at the host's frame rate.
- Opening a room wipes the park's earlier paint, because the room's paint is the log's.
- The pause card's numbers are your own.

None of these block the feature. They're listed so they aren't mistaken for regressions.

---

## 2. "More games on Maize.Live"

A link labelled **More games on Maize.Live**, to `https://maize.live`, opening in a new tab
(`target="_blank" rel="noopener noreferrer"`), in two places:

- **The loading card** (`#loader` in `index.html`), under the "Fork me on GitHub" badge. The
  loader is the page's first paint and is styled inline, so the style goes in `index.html`'s
  `<style>` block next to `.fork-badge`. It's shared with the pause card the same way the badge
  already is. It costs no request.
- **The pause card** (`PauseOverlay`), beside the fork badge, in a row that wraps on narrow
  screens. The card resumes on any pointerdown except on an `<a>` (`onPointerDown` already
  checks `closest('a')`), so tapping the link opens it without resuming.

It's styled as the quieter of the two links: cream with an ink border, like the FRIENDS button,
rather than the badge's yellow and wobble. The card already has a primary action (Back to it)
and a loud secondary one (Fork me), and a third loud one would compete with both.

The loader is only up for the 1–3s of loading, so on a fast connection the link is gone quickly.
That's what was asked for. The touch "tap to start" card that follows on phones would be the
next place to add it if you want it to stay up longer. It isn't in this plan.

---

## 3. The version in a corner

**Where the version comes from.** `vite.config.ts` works out the commit once per build:
`process.env.GITHUB_SHA`, which the Pages workflow always sets, then `git rev-parse HEAD`
locally, then `'dev'` if neither is available. From that:

- `define: { __BUILD__: JSON.stringify(commit) }` feeds p3p2's `game.version`. It's the full
  hash, because four hex characters could collide between two deployed builds and put players
  who can't understand each other in one room. `src/build.d.ts` from the reference declares it.
- A small `transformIndexHtml` hook in the same config writes `v.${commit.slice(0, 4)}` into the
  page, for example `v.1ca3`. It goes in the HTML rather than being created by `main.ts` so that
  it paints with the loader and is still there if the module fails to load, which is exactly
  when someone reporting a bug needs it.

A local build from a dirty tree shows HEAD's hash. Only a deployed build is guaranteed to match
its code exactly, and the prompt asks for the deployed commit. Docs-only commits also change
the version, so players who loaded the page before and after such a deploy are kept in separate
rooms. That's the same behaviour as the reference's per-build timestamp.

**Which corner.**
- **On a computer: bottom right.** Bottom left has the counters, the clock and the hint are top
  and bottom centre, and top left is the `?perf` HUD. Nothing sits bottom right. (The p3p2 panel
  opens from the top right.)
- **On a phone, every corner is taken.** Bottom right has the right trigger, aim and jump. The
  label goes in the 20px gutter under the right trigger, at
  `right: calc(8px + env(safe-area-inset-right))` and
  `bottom: calc(4px + env(safe-area-inset-bottom))`. At 10px tall it clears the button's
  bottom edge and shadow.

The label is 10–11px, ink at low opacity, `pointer-events: none` and `user-select: none`. It
sits above the loader and the HUD and below the touch controls and the pause and results cards.
It shows through the loader and during play, and doesn't fight the cards.

**Recordings.** `record-match` and `capture` will now film the label in the corner. That's
probably welcome, because a video then names the build it shows. If not, those tools can hide
it with one injected CSS rule.

---

## Tests

`ui-test`:
- The version label reads `v.` plus four hex characters, equal to `git rev-parse HEAD`'s first
  four on a local build.
- It sits in the bottom-right quarter of the screen and overlaps no HUD element.
- The loader and the pause card each have a link to `https://maize.live` with
  `target="_blank"`.
- A pointerdown on the pause card's link doesn't resume.
- FRIENDS and the p3p2.me note show on the park's pause card and not on the test course's.
- An ordinary visit opens no WebSocket and requests nothing cross-origin.

`touch-test`:
- On the touch build, the label's rect intersects no touch button's rect, in landscape at the
  smallest viewport the suite already uses.

`net-test` (new, skips without a server): the nine cases in §1.4. Wired into `npm test` last,
after `mural-test`.

The whole of `npm test` is run on an idle machine, without a recording running alongside, as
`NEXT_8.md` advises.

---

## Order of work

1. §3 first. It's small, and the port needs its constant.
2. The port (§1.3, steps 1–5), with `npm test` green before going further.
3. §2 and the p3p2.me note. They touch the same two cards, so they're done together.
4. `net-test.mjs`, then the by-hand run in two browsers.
5. `NEXT_9.md`.

---

## Decisions for you

These are the defaults I'll go with unless you say otherwise:

1. **A server for `net-test`**: a p3p2 checkout via `P3P2_DIR`, else Docker, else skip. Say if
   you'd rather it always required one and failed instead of skipping.
2. **The six tests left out** (lag, engines, phone, traffic, small log, seven players): left for
   later. Porting them means bringing over the lag proxy and the multi-engine setup from p3p2's
   harness, which would roughly double the size of `net-test`.
3. **The reference's game rules in a room** (§1.1): carried over unchanged.
4. **The label stays out of the pause card**, which the prompt didn't ask for. It shows faintly
   through the card's backdrop anyway.

## Not in this plan

- Anything from `GAMEPLAY_8.md`. Those are rule changes. The multiplayer port deliberately
  doesn't change how the game plays, alone or in a room.
- A hosted p3p2 server. p3p2's model is that player one brings their own, and the link to
  p3p2.me is how a player finds out how.
