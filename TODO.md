

# From Claude

The two test flakes recorded here are fixed. Both were the same thing wearing
different hats: six bots with live triggers wander the whole park, and any
measurement that takes more than a second of simulated time can have one walk
into it.

- ui-test — the lens-drip check waited five simulated seconds for blobs to fade,
  during which a bot could tag the player again and put fresh ones on. The bots
  go to the far corner first now.
- arena-test — the undercroft walk is the one probe that has to follow a line
  rather than fall straight down, and five bots spawn within twenty metres of
  the arch. Same fix.

Also fixed while in there: crosshair-test's "a shot lined up on a bot" check cast
from four metres above the bot and reported the terrace ceiling whenever the bot
wandered into the undercroft. It casts from a metre over the head now.

What is left is in `CLAUDE/NEXT_2.md`. The one item that needs a human rather
than a machine is the ammo economy — see its P0.

# Iteration 3 — the phone

The game plays on a phone now: two thumbs, landscape only, fullscreen on the
first tap. Plan in `CLAUDE/PLAN_3.md`, follow-ups in `CLAUDE/NEXT_3.md`,
tests in `npm run test:touch` (`?touch=1` forces the touch build in a desktop
browser, which is how to try it without a phone).

The item that needs a human here is the *feel*: stick radius, look speed and
button placement are all in the `touch` block of `src/core/Config.ts`, and none
of them has been held in a hand yet. iOS in particular has never run this — it
refuses both fullscreen and orientation lock, so it falls back to the rotate
card, and that path is reasoned about rather than observed.

# Iteration 4 — the playtest fixes

All six items in `CLAUDE/FEEDBACK_3.md` are done: a trigger for each hand, aim
back as a toggle, crouch, wave and scores gone, and the selection wash killed.
For iOS, where Safari has no fullscreen at all, the start card now offers to add
the game to the home screen — one tap where the browser allows it, and the Share
steps spelled out where it does not.

Jump went with the other buttons and then came back: without it, anything
between an autostep and a jump — a bench, a low wall, the fountain lip — is a
wall on a phone. It now sits above the right trigger. An auto-hop was tried in
its place first; `CLAUDE/NEXT_4.md` records why the button won.

Plan in `CLAUDE/PLAN_4.md`, consequences in `CLAUDE/NEXT_4.md`.

# Iteration 5 — the colours, the economy, and something to paint on

All six items in `CLAUDE/prompt_5.md` are done. Plan in `CLAUDE/PLAN_5.md`,
consequences in `CLAUDE/NEXT_5.md`. `npm test` is eleven suites, 197 checks.

Two colour bugs, in the two separate paint pipelines:

- **Pink paint on a green shirt came out blue.** The rig shader composited paint
  at `<map_fragment>`, which runs *before* three's `diffuseColor *= vColor`, so
  every splat on a body was multiplied by the clothing under it. Magenta on mint
  gives a dark blue-violet. Paint is written after the vertex colour now.
- **Overlapping paint z-fought.** One merged buffer, one polygon offset:
  coplanar decals over the same triangle land at the same depth to the bit, and
  the tie was broken by precision. The material writes no depth now, so draw
  order decides and the newest splat wins.

Both are covered by tests that were checked against the reintroduced bug, not
just against the fix — see `NEXT_5.md`, which records what the first three
attempts at the colour test measured instead.

**The ammo economy is finally tuned**, closing the oldest open item in this repo
(`NEXT_2.md` P0, open since iteration 1 and flagged throughout as needing a
person rather than a machine): 200 rounds each, crates of 100, and three crates
out at once with a 35s respawn instead of one per round.

**The park has a paint screen** — an 11m canvas on the plaza's east rim. It
keeps its paint in texture space rather than as world decals, which is the
technique `PaintSystem` rejects for the map and the right one for one flat
board. The results card shows the painting and offers it for sharing.

# Iteration 6 — the board moves, and the bots paint on it

All seven items in `CLAUDE/prompt_6.md` are done. Plan in `CLAUDE/PLAN_6.md`,
consequences in `CLAUDE/NEXT_6.md`. `npm test` is twelve suites, 219 checks.

**The painting wall has moved to Sheep Meadow's west rim**, 72m from the spawn
with the west woods behind it, on the flattest ground in the park outside the
paving — the site was picked by sampling `heightAt` across the board's real
footprint at a dozen candidates rather than by eye. It **takes paint on both
sides** now; the front is the round's canvas and is wiped at every whistle, the
back faces the woods and keeps whatever anybody has ever put on it.

**The bots draw on it.** A bot with paint to spare and nobody in sight walks up,
claims half the board and paints a sun, a cat, a house or its own initial, one
paintball at a time, in the order a person would draw it. It needed an aim two
orders of magnitude tighter than its fighting cone and an elevation solve that
flies the real flight model — the drag-free approximation the fighting aim uses
is wrong by a consistent few centimetres, which bends every drawing downward.
`tools/mural-test.mjs` measures the difference: a bot covers 98% of its marks,
the same marks fired with a fighting aim cover 38%.

**Sharing works.** The end-of-round picture is now a photograph of the park with
the mural standing in it, taken at the whistle through the game's own render
pipeline, and the X link goes to the game rather than to this repository. It was
also a button that started a download and opened a popup in one gesture, which
browsers throttle silently — it is a real link now.

**Crates can be found.** A shaft of light stands over every one, the HUD points
at the nearest, and a fresh one announces where it landed by name — the park's
hiding places have all had written names since the crate existed and nothing had
ever said one out loud.

**On the lag:** adaptive resolution, a shadow map on a cadence, the mural's
canvas uploaded at 20Hz rather than on every hit, and the per-frame Rapier
allocations gone. The real-GPU harness cannot run on the machine this was built
on, so `NEXT_6.md` is explicit about which of that is measured and which is
reasoned — and about the biggest remaining cost, which is deliberately untouched
until somebody can measure it.
