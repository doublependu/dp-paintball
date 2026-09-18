# Gameplay — final suggestions after iteration 8

You asked for this at the end of the iteration so you can choose what goes into
the next one. Nothing in it is implemented. Everything in iteration 8 was
tooling and bug fixes (see `NEXT_8.md`). This file is only the proposals.

It replaces §3.3 of `PLAN_8.md`, and one of its recommendations has changed.
The plan's numbers came from one round played by the `film` autopilot, which
knows where every bot is and follows a sightseeing schedule. The numbers below
come from `npm run playtest`: five seeds under the `play` policy, which can
only engage what it can see and learns where bots are only by hearing them.
They were taken on the fixed build, so the bugs below don't distort them.

## What a round actually looks like

Means over seeds 1–5, `captures/playtest/fixed.json`:

| | |
| --- | --- |
| first contact | **1.6s** after the whistle, every seed |
| share of the round spent fighting | **78%** |
| longest stretch without a fight | **20s** |
| player tagged | **53 times a round**, one every 5.7 seconds |
| player's accuracy / the bots' | 12.9% / 14.0% |
| share of all tags that land on the player | 20.5% (a fair share of seven is 14%) |
| player's fights (22 a round) that ended with somebody winning | **none**: 10 lost sight, 11 hit the autopilot's 16s cap, 1 went for paint |

Two findings from the plan stand. One reverses.

- **Stands: nothing is at stake.** Being tagged 53 times has no effect. The
  player's score is a count, and the gap between a good round and a bad one
  shows up only on the results card.
- **Stands: fights have no ending.** Not one of 108 fights over five rounds
  ended because someone won, because the game has no way for that to happen.
- **Reversed: the park is not too empty.** The plan guessed that a player who
  has to find the bots would spend a lot of time looking. The opposite is true.
  Everyone spawns around the plaza, the first fight starts 1.6 seconds in, and
  the round is one continuous brawl with no gap longer than 20 seconds. The
  problem isn't getting to the fights. It's that the round has **no shape**:
  no build-up, no lulls, nothing that changes between minute one and minute
  five.

## What I suggest, in order

### 1. Outs: a tag costs something

This is still the one change that fixes the most, for the reasons in the plan.
Fights get an outcome, aiming and cover start to matter, and the paint on a
body starts to carry information. The mechanism is unchanged: after *N* tags a
character is out. Hands up, can't fire, walks off for about 4 seconds, then
respawns out of the shooter's sight with its body paint cleared. The score
becomes outs, with tags as the tie-break.

**What changed is the number.** At the measured rate of 53 tags a round:

| tags to out | player outs a round | seconds a round spent out (at 4s each) |
| --- | --- | --- |
| 1 | ~53 | ~210 of 300 |
| 3 | ~18 | ~70 |
| 4 | ~13 | ~53 |
| 5 | ~11 | ~42 |

The plan suggested three. On these numbers three is too harsh: the player
would be out every 17 seconds and sit out almost a quarter of the round. I now
suggest **starting at four** and tuning with the harness toward the player
being out about every 25–35 seconds. That target is a judgement call you should
check by playing. The rates themselves will fall once outs exist, because an
out character isn't shooting anyone, so the real numbers will come in lower
than this table.

Cost: medium. `Character` (tag count, out state, clearing paint), a new `'out'`
state in `Bot`, per-character respawn in `CharactersSystem`, a firing lock and
an "out" HUD line for the player, and ranking by outs in `ResultsPanel` and the
HUD. The bots also need one new rule so they look like they understand the
game: one tag from out, back off.

### 2. Give the round a shape: spread the spawns

This is new, and it comes from the measurement. Today every character starts
within about 20 metres of the plaza, so the whistle starts a scrum. Spawning
the bots across the named places instead (the Ramble, Sheep Meadow, Bow
Bridge, Cherry Hill), with the player at the fountain, gives the first minute
an approach. You hear the first shots before you see anyone, and the fighting
spreads out across the park rather than piling up in one spot. With outs,
respawn points need the same spread, so this reuses that work.

Target, measured by the harness: first contact 15–25 seconds in, and a
longest quiet stretch of 30–40 seconds. That means breathing room rather than
empty minutes.

Cost: small. The spawn table in `CharactersSystem`, validated against the
navgrid like the signs were.

### 3. Show where a hit came from

There is no hit-direction indicator. Once tags cost something, being tagged
from somewhere you can't see stops being harmless and becomes frustrating. It
also matters most on a phone, where turning around is slow. A red arc at the
edge of the screen, pointing at the shooter and fading over about a second.

Cost: small. `Hud.ts` plus a test like the crosshair ones. It is worth doing
even without item 1.

### 4. A bounty on the leader

Whoever leads (on outs, or on tags without item 1) wears a visible marker and
is worth double. It gives the scoreboard a storyline, gives the player someone
to go after on purpose, and draws the bots to one place. It's cheap once item
1 exists.

### 5. A last-minute golden crate

At the one-minute warning, a crate at the fountain with a points multiplier,
announced by name the way crates already are. The plan offered this to cure an
empty park, and the park isn't empty. What's left is a way to end the round on
an event instead of a clock, which is worth less. It's cheap, but I'd do it
last of these five.

### Later: turf

Every named place becomes a zone owned by the colour with the most paint in it.
The results card becomes a map of the park in colours. It suits this game
better than any shooter mode, and it gives the park's size a purpose. It's a
whole iteration of its own, with new bot behaviour, and it doesn't conflict
with anything above.

### Not recommended

- **Retuning bot aim or fire rate first.** It is tempting while the player is
  tagged every 6 seconds, but without outs a tag costs nothing, so the number
  means little. Tune after item 1, against the harness.
- **Changing the camera.** Whether opponents feel too small on screen is a
  question for someone holding a mouse, not for the harness.

## What I'd put in iteration 9

Items **1, 2 and 3 together**. They're one design: outs give fights an ending,
spread spawns give the round a beginning, and the hit arc makes being out feel
fair. Use the harness to set `tagsToOut`, the out time and the spawn spread,
aiming for the targets above. Then play it yourself before deciding on 4 and 5.

If you would rather keep tags harmless, items 2 and 3 on their own are still
worth doing and cheap. But in my view the game's main problem would still be
there.

## How to judge whichever you pick

```
npm run preview                      # in one terminal
npm run playtest -- --seeds 5 --label <name>
```

The table prints to the terminal and is saved to
`captures/playtest/<name>.json`. `captures/playtest/fixed.json` is the
reference for this build. Rows that stay meaningful after any of these changes:
first contact, longest without a fight, player tagged per minute, and how
fights end (with outs, add an "ended: out" row; `endFight` in
`tools/autopilot.js` is where to count it).
