

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
