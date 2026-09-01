# Next, after iteration 5 (colours, economy, and the canvas)

All six items in `CLAUDE/prompt_5.md` are done — `CLAUDE/PLAN_5.md` is what each
turned into. `npm test` is eleven suites and 197 checks, exit 0. The new suite is
`tools/screen-test.mjs`; `character-test` and `paint-test` each grew the check
that the iteration is actually about.

## The thing most worth carrying forward: both colour tests were wrong first

Neither bug could be caught by looking at a colour and asking whether it was the
right one — `NEXT_2` already records why, and this pass earned the lesson three
more times. Both fixes ended up verified by *reintroducing the bug and watching
the test fail*, and every one of the intermediate attempts had passed against
both the fix and the bug. That check is cheap and it is the only thing that
separated a real test from a decorative one here.

What the shirt-colour test measured before it measured the right thing:

1. **Cyan paint on two bots.** Bots wander. The body moved between the reference
   frame and the comparison, so the diff was a moving silhouette, not a splat.
2. **Cyan, on a still player.** Fixed the movement and still passed against the
   bug — because cyan has no red at all, so cyan-times-magenta-shirt and
   cyan-times-navy-trousers both come out dark blue. *The probe colour has to be
   bright in a channel the two surfaces disagree about*, or the multiply hides.
3. **Magenta, torso versus "thigh".** The sweep's thigh spot at height 0.72
   lands on the **GUN** joint — the marker hangs there — so this compared the
   torso against the gun, and both carry the team colour. Asking the rig which
   joint a spot actually reaches took one probe and would have saved two rounds
   of this.
4. **Magenta, torso versus knee.** The knee genuinely lands on `LEG_L`, which
   has the most contrasting base colour on the body — and this camera cannot
   see it. The diff measured grass moving behind the shins.

What works: lime paint (green-dominant), on the torso (team magenta) versus the
face (skin), both of which the existing sweep has already proven are drawn *and*
visible. 1.7 apart with the fix, 73.9 with the bug, of a possible 441.

The z-fighting test needed the same treatment for a different reason: the
artifact is not a colour, it is a colour that *changes when the camera moves*.
Measured from two positions 3.5cm apart, the older colour holds 12.8% then 13.6%
with the fix, and 34.9% then 44.9% with `depthWrite` back on.

## Consequences worth knowing about

**The paint screen is not a `SurfaceRegistry` receiver, and that is load-bearing
in both directions.** Nothing registers it, so `PaintSystem` finds no receiver
and returns — the mural cannot be evicted by the world's vertex budget, and a
board everyone shoots at on purpose cannot spend that budget either. The cost is
that the board is placed by *geometry*, not by collider handle: `onHit` rejects
anything outside the plane's bounds, behind it, or too far off its normal. If a
second paintable board is ever wanted, that logic wants extracting rather than
copying.

**`ResultsStage.PANEL_SHARE` is now measured, not assumed.** The card grew by
about two thirds when the mural moved into it, and the constant that framed the
line-up above it silently stopped matching. It is read from the live card every
frame. The ceiling is 0.72 and deliberately *below* what a landscape phone asks
for (~0.85): honouring the real number aims low enough to push the figures'
heads off the top of the frame, and a strip of heads reads better than a strip
of torsos.

**Crates are a list now.** `LootState.crates` replaced `position`/`rounds`, and
bots latch the crate they set off for rather than re-asking every step — without
that, a bot standing between two of them dithers and repaths on every flip.
`LootSystem.respawn()` empties the list outright rather than retiring slot by
slot; doing it the other way leaves any stray entry standing and the crate count
grows round on round, which is how the match suite caught it.

**The mural persists across rounds**, matching the choice `MatchSystem.restart`
already documents for world paint. If that turns out to be wrong, it is one call
to `PaintScreen.clear()` in `restart`.

## Still unverified

- **The share sheet on a real phone.** `navigator.share` with files is the whole
  point of the feature — it is the only path that posts a picture anywhere in
  one step — and it has run in no browser that implements it. The desktop
  fallback (save, then an X intent that cannot carry the image) is what the
  headless suite exercises.
- **`context.filter` on older iOS.** The splat's wet rim is a darkened copy
  drawn under the full-colour one, and Safari only got 2D-context filters in 17.
  Older versions lose the rim and keep the splat, which is the right way round
  to degrade, but nothing has checked it.
- **Whether 200 rounds and three crates is right.** These came from a person
  rather than from arithmetic, which is the improvement; they have still only
  been played by a machine. Rounds should now end on the clock rather than on
  the ammo condition — worth confirming that they do.
- **iOS generally**, unchanged from `NEXT_4.md`.

## Still open from before

- `NEXT_3.md` P1 — the round clock runs while the start card is up — untouched,
  and the phone still makes it worse than the desktop does.
- `NEXT_2.md` P2 — the bots cannot use the map's verticality. Now the largest
  remaining piece of work in the game by some distance, the economy having been
  settled.
- `NEXT_2.md` P3 — the fountain's water still takes no paint and no splash.

## New, small, and worth doing

- **The board is the only thing in the park you can paint deliberately, and
  nothing says so.** A player who never turns east at spawn will not find it.
  The sign plaque machinery in `render/SignPlaque.ts` already exists.
- **No way to wipe the mural.** It will be wanted; it is a question about who is
  allowed to clear a shared painting, which a round of play should answer first.
- **Splats on the board are 3% of its width.** Right for consistency with the
  park, possibly wrong for a thing whose purpose is to be painted on — filling
  it takes most of a round. A per-surface splat scale would be a one-line
  addition to `PaintScreen` if it reads as too slow in a real game.
