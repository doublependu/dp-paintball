# Next, after iteration 4 (the playtest fixes)

All six items in `CLAUDE/FEEDBACK_3.md` are done — see `CLAUDE/PLAN_4.md` for
what each turned into. `npm test` is green across all ten suites; the touch
suite is 24 checks now, and the new ones are the ones this iteration is about:
the left trigger fires, releasing one trigger leaves the other firing, aim
latches, and the four removed buttons are gone.

## Consequences worth knowing about

**A phone player cannot jump.** That follows directly from removing the button,
and it is mostly fine: the character controller autosteps 0.45m, so kerbs,
stairs and terrace edges are walked up without noticing. What is now closed on a
phone is anything between 0.45m and the 1.15m a jump clears — a bench, a low
wall, the lip of the fountain basin. Nothing in the park *traps* a player who
cannot jump, but a few shortcuts are gone. If that turns out to matter, the fix
that costs no buttons is a small auto-hop: jump automatically when walking into
something short enough to clear, which reads as vaulting rather than as a
missing control.

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
