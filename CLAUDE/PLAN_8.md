# Plan 8 — watching a whole round, and what it says about the game

`CLAUDE/prompt_8.md` has three items. The first two are already built:
`tools/autopilot.js` plays a round and `tools/record-match.mjs` films it, both
committed as "game recording tools", and `captures/match/` already holds a
finished take. So this plan is mostly about item 3. The recording is the
evidence it works from, and the autopilot becomes the tool for checking whether
any change actually improves the game.

Everything below that claims something about play comes from **one** recorded
round: seed 20260917, 300 seconds, six bots and the autopilot playing the
player. The numbers are from `captures/match/match.json` and the pictures are
frames from that take. Where one round is not enough to settle a question, the
plan says so.

---

## 1. The script that plays the game — built; make it a playtester too

`tools/autopilot.js` is injected into the page and drives the player through
the real touch inputs (`setTouchMove`, `setTouchAction`). That means movement,
recoil, spread and ballistics all behave exactly as they do for a person. It
hunts, leads its shots, fires in bursts, breaks off to restock, avoids the lake
shore and gets itself unstuck. In the recorded round it had no rescue
teleports, the camera never went underwater, and the page logged no errors.

It is built to make **a good video**, not to measure the game, and it gives
itself three advantages that make it a poor measuring stick:

- **It knows where every bot is.** When hunting it heads for `nearestBot()`
  through walls, so it never has to search. A real player does.
- **It follows a fixed schedule**: the Mall at 40s, Sheep Meadow, the painting
  wall, Bow Bridge at 150s, the wall again at 235s. That is good for showing
  the park and bad for judging pacing.
- **It sets look direction directly** and aims with perfect knowledge of lead
  and drop. Even so, it hit with only about 9% of its shots (below).

### Work

- Add a `--policy` switch. `film` keeps today's behaviour. `play` removes the
  schedule and the wallhack: the player can only target bots it has a line of
  sight to within a view cone, and it only learns roughly where a bot is when
  that bot shoots at it (a paintball arriving within ~2m, or a hit). Otherwise
  it wanders between named places the way a new player would. That is the
  policy for measuring difficulty and pacing.
- Record per-round metrics in `match.json`, all in simulated time:
  seconds to first contact; share of the round spent in a fight, travelling,
  restocking and idle; shots fired and tags (and so accuracy) for everyone;
  hits taken per minute; the longest stretch with nobody in sight; stuck
  events; frames where the camera was inside geometry (see §3.2); the number of
  drawings started and finished on the mural; and time each bot spent in each
  state.
- Add `npm run playtest -- --seeds N`: several `--dry --policy play` rounds in
  sequence, printing a single table. Every claim in §3 should come from this
  table rather than from one round.
- Add a `record:match` npm script for the existing recorder.

Hold the autopilot to the same honesty rule the rest of `tools/` already
follows: `play` is only allowed to read what a player could read off the
screen, plus the one exception of hearing where it was shot from.

## 2. One whole round on video — done; small follow-ups

`captures/match/central-park-paintball-full-round.mp4` is 317.5s long:
3.5s of title card, 9000 match frames (300.0s at 30fps, stepped by the
simulation clock, so there are no dropped or doubled frames), and 14s of the
results card. It is one continuous take with no cuts. The sound is the game's
own synth, rendered offline against the simulation clock, so it lines up with
the picture sample for sample.

Remaining work:

- **Size.** At 16Mbps the file is 633MB. Keep that as the master, and add a
  `--share` encode (1080p, CRF 23, about 5–6Mbps, around 220MB) that you can
  actually send to someone.
- **Re-record at the end of this iteration** with the same seed and
  `--policy film`, so the before and after can be compared frame for frame. The
  current take becomes the "before".
- The two visual bugs in §3.2 are in the current take (at 1:30 and 0:30 on the
  clock). Whatever frames the camera check flags should be read by eye before
  the new take is accepted.

## 3. Is it fun?

### The short answer

It is **not too hard** and **not very buggy**, but it isn't really "too easy"
either. The truer description is that **nothing is at stake**. Being hit has no
effect beyond a counter going up, so there is nothing to be good or bad at from
one second to the next. Most of what follows is that problem seen from
different angles.

### 3.1 What the round shows

**A hit changes nothing.** The player was tagged 34 times, about once every
nine seconds, and it made no difference: `Character.takeHit` counts the hit,
plays a flinch and gives a 1s grace window, and that is all. No one is ever
out, sent back to spawn, slowed down or losing anything. The final scoreboard
was `34/34 48/36 46/43 41/25 11/8 15/46 33/36` (tags given / tags taken, player
first). The player came fourth of seven, with an autopilot that knows where
everyone is. Nobody's strategy mattered, because nothing a player does changes
what happens to them.

**Fights don't end, they time out.** In the log, 10 of the player's 18
engagements finished with `done with bot-x after 16s`. That is the autopilot's
own `FIGHT_SECONDS` limit, because nothing else in the game ends a fight. Most
of the rest (6) ended with `lost bot-x` (the target walked behind a tree). None
ended because someone won. The bots behave the same way: `engage` and
`reposition` alternate on `engageDuration` timers of 2.2–4.5s for as long as
the target stays in sight.

**Aim barely matters.** The player fired about 371 paintballs (200 at the
start, plus three crates of 100, with 129 left) and tagged 34 times: roughly 9%,
while leading moving targets perfectly. Bot aim cones are 4.5°–12°. At the
usual 10–30m range, a tag comes from volume of fire more than from skill, so a
fight is a spray rather than a duel.

**The park is large compared with the number of people in it.** The play area
is 184m across and holds seven characters. Even with the wallhack, the player
had no target in about 40% of the ten-second samples. Some of that is the
sightseeing schedule, so this needs `--policy play` numbers before it becomes a
claim. But a real player, without knowing where the bots are, will spend longer
looking for someone than the autopilot did.

**The painting side quest barely shows.** At the whistle the board has two
drawings on it: a finished green one and part of a yellow one. The yellow
painter (bot-d, "Dev") was in the `muralist` state at every sample from 0s to
100s and again from 220s to 290s. It tagged nobody for the first 170 seconds
and finished with 11/8. `mural.timeoutSeconds` is 45, so either it keeps
re-entering the state or it spends most of that time walking rather than
painting. Plan 7 fixed the gate, and this looks like a new failure after it.
It is a bug to diagnose, not a tuning question.

**The results card doesn't feel like an ending.** Its three awards
(sharpshooter, cleanest, most painted) go to whoever has the extreme count. The
player's own row is fourth of seven with nothing to mark it. That doesn't cause
the lack of stakes, it just reflects it.

### 3.2 Bugs seen in the take

- **The camera ends up inside the terrace.** At 1:30 and at 0:30 the player is
  around (-7, 21–25) and the top half of the frame is a flat tan plane, with a
  tilted strip of park visible under it. Since the camera has no roll, the
  tilt means the player is standing on a slope and seeing the underside of
  something; the terrace deck or its stair is the likely culprit. The spring
  arm's sphere cast (`camera.collisionRadius`) either isn't hitting that
  collider or that geometry has no collider. Reproduce it by teleporting to
  those positions with the recorded yaw and pitch, then find out which of the
  two it is.
- **A painter stuck in `muralist`** (see above). Log every change of state and
  the reason for it for bot-d under this seed, and find what keeps it there.
- **`stuck at (-7, 39)`** at 51.7s, on the way to the Mall sign. It happened
  once and was harmless, but a stuck player at a spot the navgrid calls
  walkable means a collider and the grid disagree. Check whether it happens
  again across seeds before chasing it.

These are the only bugs visible in five minutes of footage. There were no page
errors, no falls through the world, no underwater camera and no rescue
teleports. On the evidence of one round, "too buggy" isn't the problem.

### 3.3 How to make it more fun

In order of how much each one fixes. The first one is what I recommend for
this iteration. The rest are candidates for later, with an estimate of what
each costs.

**1. Make a tag cost something: three tags and you're out.** This is the core
change. Every tag already paints the body, so the body is the health bar and
there's nothing new to explain: the more paint on you, the closer you are to
being out. On the third tag, a character is **out**: arms up, hopper locked,
it walks out of the fight for about 4 seconds, then respawns at a spawn point
out of sight of whoever tagged it, with its body paint cleared and a short
grace window. Scoring becomes **outs**, with tags as the tie-break.

What changes as a result:

- fights have an outcome, so they end with a winner instead of on a timer;
- aiming and cover matter, because a spray gives the other side time to finish
  you;
- the player has a reason to back off, to restock before a fight rather than
  in the middle of one, and to flank;
- the body paint, which is the game's best visual, starts to carry
  information.

Why three tags rather than one, which is real paintball's rule: at the current
aim cones and a player tagged every nine seconds, a one-hit rule would put the
player back at spawn about 34 times a round. Three puts it at roughly 11, before
any retuning. Put the number in `Config` (`match.tagsToOut`) and set it with
the playtest table, not by argument.

Where the work is:

- `Character`: a `tagsSinceSpawn` count, an `out` state and a `clearPaint()`
  call. The rig's splat uniforms already have a reset path for the new round.
- `Bot`: a new `'out'` state that walks away from the shooter and ignores
  targets; `respawn(spawn)` already exists (`Bot.ts:261`).
  `CharactersSystem.respawnAll` already knows how to pick spawns; add a
  per-character version that avoids the shooter's line of sight.
- The player: `PlayerController` locks firing and slows movement while out,
  the HUD shows "tagged out by Ada — back in 3…", and the camera stays where
  it is (no death cam).
- Scoring: `hitsGiven` stays, `outs` is added, and `ResultsPanel` and the HUD
  score strip rank by outs.
- Bots also need to know when to back off: a bot on two tags with its target
  still in sight should `reposition` rather than `engage`. That is one extra
  clause in `decide`, and it makes the bots look like they understand the rule.

**2. A hit should say where it came from.** The HUD has no indicator for the
direction a hit came from. Once tags have a cost, being tagged from a
direction you can't see is frustrating instead of informative. A red arc at the
screen edge pointing toward the shooter, fading over a second, is a small
change in `Hud.ts` and matters most on a phone, where turning around is slow.
Do it together with item 1.

**3. A bounty on the leader.** Whoever leads on outs gets a visible marker
(a paint-bucket hat, or a glow on the name above them) and is worth two. It
gives the scoreboard a storyline, gives the player a target to go after on
purpose, and pulls the bots together, which also helps the empty-park problem.
It's small, and it only makes sense once item 1 exists.

**4. A last-minute rush.** At the one-minute warning, drop a golden crate at
Bethesda Fountain (paint, plus double points for a minute) and announce it by
name, the way crates already are. Everyone converges, so the round ends in a
crowd instead of drifting apart. It's cheap and reuses `LootSystem` and the
existing announcement path.

**5. Turf: paint the named places.** This is the larger idea, and it suits
this game better than any shooter mode does. The park now has ten named
places with signs. Each becomes a zone, and each zone is owned by whichever
colour has the most paint in it. The HUD shows who owns what, and the results
card shows a map of the park in colours. Shooting the ground becomes
worthwhile, the size of the park becomes the point rather than a problem, and
the paint that already persists on the world counts for something. The count
should come from a tally of splat area per zone kept as splats are written, not
from reading back the 4096² atlas, so it costs nothing per frame. This is its
own iteration and needs its own bot behaviour (going to contested zones and
painting the ground). I'm listing it so the decision on item 1 is made knowing
it's there. It doesn't conflict with item 1.

**Not recommended yet:** a tighter camera or a smaller player character on
screen. In the footage the player's own character takes up about a fifth of
the frame and bots are 40–80px tall, which may make them feel small and far
away. But that is a judgement about feel, and it needs to be tried with a mouse
in hand. The same goes for bot cover and verticality (`NEXT_2.md` P2), which is
still the biggest improvement available to the bots but is not the thing
holding the game back right now.

### 3.4 Decision needed before implementing

Item 1 changes the game's rules, and its first number (three tags) is a
starting point, not a result. Please confirm:

- **three tags and you're out**, as above; or
- **one tag and you're out**, which is truer to paintball and much harsher; or
- **no outs**, keeping tags as the only score, and doing items 2–4 on their
  own. That is the cheaper option, and in my view it treats the symptoms.

Everything in §1, §2 and §3.2 is worth doing whichever you choose.

---

## Order of work

1. **Playtest harness** (§1): `--policy play`, the metrics and
   `npm run playtest`. Run a five-seed baseline on the current build and save
   it as `captures/playtest/baseline.json`. Every later step is measured
   against it.
2. **Bugs** (§3.2): the terrace camera, the stuck painter, and the (-7, 39)
   stall if it happens again. Each gets a regression check before it is fixed:
   a camera-inside-geometry assertion in `arena-test`, and a natural-round
   mural check in `mural-test` that the plan-7 test should already have caught.
3. **Outs** (§3.3 item 1) together with the hit-direction arc (item 2), behind
   `match.tagsToOut`. Tune `tagsToOut`, the time spent out and the bot
   back-off threshold against the playtest table. Aim for the player being out
   roughly every 30–45s under `--policy play`, and for most fights ending in an
   out rather than being lost or abandoned.
4. **Bounty and last-minute rush** (items 3 and 4), if item 1 lands cleanly.
5. **Re-record** the full round (§2) with the same seed, and encode both the
   master and the share cut.

## Tests

- `match-test`: a character is out on exactly the `tagsToOut`-th tag; tags
  during the grace window and while out don't count; an out character can't
  fire; respawn clears body paint and the tag count; the respawn point is not
  in the shooter's line of sight; outs are credited to the shooter; nothing
  counts after the whistle (the existing rule, extended to outs).
- `bot-test`: a bot on `tagsToOut - 1` tags repositions instead of engaging; an
  out bot ignores targets and comes back in after the out time.
- `ui-test`: the hit-direction arc points toward the shooter within some
  tolerance, for shots from the front, the side and behind; the results card
  ranks by outs.
- `arena-test`: the camera is never inside a collider across a sweep of
  positions and yaws around the terrace, including the positions recorded in
  the take.
- The playtest table is *not* part of `npm test`. It takes minutes and its
  numbers vary with the seed. It is what the tuning is judged against, and its
  output goes into `NEXT_8.md`.

## Budget

Nothing here adds assets or changes loading, so the 2–3s load target is not
affected. Outs add one state per character and one sight check per respawn,
which is nothing per frame. The hit arc is one DOM element. Turf (item 5, not
in this iteration) is the only proposal with a real runtime cost, and that is
why it counts splats as they land rather than reading the atlas back.

## What cannot be settled here

- **Fun itself.** The playtest table can say whether fights end, how often the
  player is out, and how long they spend looking for someone. It cannot say
  whether any of that feels good. `tagsToOut`, the out time and the size of the
  hit arc all need someone playing with a mouse, and then on a phone.
- **One seed.** Every number in §3.1 comes from one round, played by an
  autopilot that cheats. Their direction is not in doubt: when nothing is at
  stake, that is visible in the code, not only in the data. But the specific
  numbers (9% accuracy, 40% of samples with no target, 16s fights) will change
  once `--policy play` numbers exist, and those should replace these in
  `NEXT_8.md`.
