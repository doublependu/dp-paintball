# Next, after iteration 4 (the playtest fixes)

All six items in `CLAUDE/FEEDBACK_3.md` are done — see `CLAUDE/PLAN_4.md` for
what each turned into. `npm test` is green across all ten suites; the touch
suite is 24 checks now, and the new ones are the ones this iteration is about:
the left trigger fires, releasing one trigger leaves the other firing, aim
latches, and the four removed buttons are gone.

## Consequences worth knowing about

**Jump was removed and then put back, and the detour is worth recording.** With
no jump button, everything between the 0.45m the controller autosteps and the
1.15m a jump clears becomes a wall — a bench, a low wall, the lip of the
fountain basin. The fix tried first was an auto-hop: when a step was blocked,
probe forward at hop height and down beyond the obstacle, and jump for the
player if it was short enough with somewhere to land. It worked, and it was
dropped anyway in favour of simply giving the button back.

Why the button won: an auto-hop is a movement rule the player cannot see, and it
fires exactly when they walk into something — which is also what they do when
they mean to take cover behind it. Walking into the back of a bench to hide put
them on top of it, in the open. A button that does nothing until it is pressed
has no such failure mode, and a fourth button turned out to be affordable.

If auto-hop is ever wanted again, the probe pair is the part worth keeping: a
forward ray at hop height separates a bench from a wall without caring how thick
it is, and a downward ray past it is what stops a hop over a railing into the
lake.

**Waving is gone on a phone.** No gameplay cost, but it was the one purely
social gesture in a game whose whole premise is that nobody dies. A double-tap
on the left stick would give it back for free if it is missed.

**The install offer is shown once**, before the first round. A player who
dismisses it by starting the game has no way back to it short of reloading. If
that proves annoying, the pause card is the natural second home for it.

## Still unverified

- **iOS, again.** The install path, the Share instructions, the standalone
  launch and the selection fixes are all reasoned about and none has run on an
  iPhone. The next playtest is what closes this.
- **Whether two triggers is the right answer** or one trigger in a better place.
  Only a hand knows.
- **Frame rate on real hardware.** Unchanged from `NEXT_3.md`: the pixel-ratio
  cap is asserted, the frame time is not measurable here.

## Still open from before

`CLAUDE/NEXT_3.md` P1 — the round clock runs while the start card is up — is
untouched and still worth doing; the phone makes it worse than the desktop does,
because a phone takes longer to get past that card. And `CLAUDE/NEXT_2.md`'s P0,
the ammo economy, remains the one item that wants a human rather than a machine.
