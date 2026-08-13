

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
