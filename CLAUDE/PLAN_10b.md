# Plan 10b — a friend's ball leaves their marker

`CLAUDE/prompt_10.md` reports one issue alongside the round-end feature that `PLAN_10.md` covered:

> In a multiplayer game, paint does not seem to come out of the paintball gun from a remote
> player. It does land though.

**It isn't fixed.** Iteration 10 only touched the round's end. `git show --stat aa355d3`
changes nothing in `src/net/` or `src/gameplay/Ballistics.ts`. Measured on HEAD's build, the
bug is still there (§1).

---

## 1. What happens now, reproduced

**How a remote shot travels today:**
- **The shooter's page:** the weapon fires from `AimSolver`'s muzzle. `Net.fired` records the
  shot with its place, its time on the room's clock, its origin and its direction, and sends a
  batch (`sh`) every 50ms (`SHOTS_MS`).
- **Every other page:** `Net.onShots` (`Net.ts:727`) calls
  `ballistics.fire(origin, direction, id, color, collider, lag)`.
  - `lag` is the shot's age on the room's clock, capped at 0.5s (`MAX_LAG`).
  - `BallisticsSystem.fire` (`Ballistics.ts:146`) steps the ball through `lag` seconds of
    flight at once, before it is ever drawn: "so that it is where it is on the page that fired
    it".
- **Meanwhile the shooter's figure on that page is drawn in the past:** a friend 100ms behind
  their presence (`Smooth` delay), a bot 160ms behind the host's reports.

So the ball is moved forward in time while the marker is drawn back in time. At 63 m/s, each
16ms of age puts the ball about 1m further from the marker before its first frame. The age is
the delay from the shooter to the server to this page, plus 0–50ms of batching.

**The repro.**
- **Setup:** a scratch Playwright script against HEAD's build (`npm run preview`). Two pages
  are in a real p3p2 room: the Docker image `p3p2/p3p2:0.1.1`, with net-test's GPU flags.
  - Ann (host) stands in a clear 30m lane and fires 30 balls from Aim's muzzle.
  - Grace (guest) stands 12.6m to her side.
  - Every WebSocket frame is held back `LAT` ms each way with Playwright's `routeWebSocket`, so
    a shot from Ann to Grace is delayed about 2 × `LAT`.
- **Recorded on Grace's page:** each remote ball's age, where it is first drawn, and where her
  page draws the shooter's marker in that frame. The same is recorded on Ann's page for her own
  balls, as the baseline.

| delay per hop | age given (p50) | Ann's ball, first drawn from her drawn marker | bots' balls, first drawn | bots' balls never drawn |
| --- | --- | --- | --- | --- |
| Ann's own page | — | **1.0m** (one fixed step), drawn ~42 frames | — | — |
| 0ms | 7ms | 1.0m (p90 4.1, max 5.1) | 2.2m | 0 of 36 |
| 25ms | 83ms | **6.1m** (5.1–8.1) | 7.1m | **6 of 27** |
| 60ms | 160ms | **11.0m** (9.1–15.8), drawn ~30 frames | 12.1m | **4 of 58** |
| 60ms, Ann walking | 163ms | 11.5m | 11.1m | **9 of 23** |

What this shows:
- **The marker is drawn in the right place; the ball isn't.** For a friend who is standing
  still, Grace's page draws Ann's marker 0.02m from the shot's real origin.
- **At normal internet delays, every remote ball first appears 5–15m out,** a good way into
  its flight. It then covers the rest in fewer frames than it would on the page that fired it.
- **Some balls are never drawn at all.** A ball whose target is nearer than the age × 63m
  lands inside the catch-up. In these runs that was 15–40% of the bots' balls, because bots
  fight at close range. All the player sees is the burst and the paint. That is the report's
  "it does land though".
- **The same happens to the bots' balls on a guest's page,** since those are remote shots there
  too.
- **Why the tests never caught it:** nothing in `net-test` looks at where a ball is drawn. On
  one machine the delay is close to zero, which puts the ball only 1–4m out.

The script is at
`/tmp/claude-1000/-home-rx-Repos-mine-public-dp-paintball/468c43d8-83f2-4f18-92a8-aa6a899e1b44/scratchpad/repro-remote-shots.mjs`
(`LAT=60 node repro-remote-shots.mjs`; `RUN=1` makes Ann walk; `NOCATCHUP=1` tries §2 at
runtime). §4 turns it into a `net-test` check that fails on today's build.

---

## 2. The change: fly a remote ball from its origin, as it arrives

**No catch-up.** When a remote shot arrives, it's fired from its origin and flies its whole
path at its real speed, as a ball fired on this page does.

**Tried at runtime before writing this.** The repro wrapped Grace's `ballistics.fire` to pass
an age of 0; no source changed. At 60ms per hop:

| | today | without the catch-up | Ann's own page |
| --- | --- | --- | --- |
| Ann standing: first drawn from her drawn marker | 11.0m | **1.03m** | 1.03m |
| Ann walking: first drawn from her drawn marker | 11.5m | **1.54m** | 0.96m |
| Ann's ball: frames drawn (p50) | 30 | 40 | 42 |
| bots' balls: first drawn from the drawn marker | 12.1m | **1.1m** | — |
| bots' balls never drawn | 4 of 58, 9 of 23 | **0 of 27, 0 of 36** | — |

### 2.1 What else it changes

1. **A remote ball lands later on this page, by the delay (about 50–200ms).**
   - **A friend's ball is only shown here (`cosmetic`).** The shooter's page judges it, and its
     paint and tag come through the room's log.
   - **The paint and the local burst come closer together.** The log's paint is sent in batches
     every 250ms (`PAINT_MS`) and travels with the same delay as the shot. Measured on Grace's
     page, the paint arrived this long after the ball burst there:

     | delay per hop | today | without the catch-up |
     | --- | --- | --- |
     | 20ms | 44 to 283ms | −10 to 284ms |
     | 60ms | 125 to 431ms | −17 to 244ms |

     Without the catch-up, the paint came first for 1 ball in 30, by one frame. The gap no
     longer grows with the delay; what's left is the paint's own 250ms batching.
   - **A friend's tag on this player** is sent the moment it is judged. It will now arrive 0–50ms
     before the ball bursts here, rather than one delay after it. That's from the code; I didn't
     measure it.
2. **A bot's ball that reaches a guest arrives later by the delay.** That ball is judged on the
   guest's page.
   - A guest who is moving is a little harder for the bots to hit. They already aim at where the
     host draws the guest, which is 100ms plus the delay in the past.
   - A guest who is standing still is hit the same as before.
   - In exchange, what a guest sees coming is what hits them. Today a bot's ball can appear
     metres from its marker, or not at all, and still tag them. See Decision 1.
3. **A shot that arrives late is dropped.**
   - **Today:** a shot's age is capped at 0.5s of catch-up.
   - **Without the cap,** a shot held up by a connection hiccup or a reconnect would leave the
     marker seconds after it was fired. A bot's ball could then tag a guest seconds late.
   - **So:** a shot older than 0.5s isn't flown at all. `MAX_LAG` becomes `MAX_AGE`. Its paint
     and its tag still come through the log.
   - **The wire format doesn't change:** the shot's time is already sent.

### 2.2 Considered and left out

- **Starting a moving shooter's ball at the drawn marker.**
  - The figure is drawn about 100ms behind. For a walking friend, the first frame is 1.54m from
    the drawn marker, against 0.96m on the shooter's own page. That's half a frame of the ball's
    travel.
  - A render offset that decays from the drawn marker to the true path over ~0.1s would close
    it, in `BallisticsSystem.update`.
  - It isn't worth the code now. It's worth adding if a sprinting friend's shots look wrong in
    play.
- **Keeping the catch-up and only drawing the start of the flight from the marker.**
  - It keeps today's landing times.
  - It still loses every ball whose target is nearer than the delay × 63m, which is the most
    visible case.
  - It keeps the paint arriving well after the burst.
- **Holding each shot until the figure is drawn at that moment,** about 100ms more.
  - The marker and the ball would match exactly, even on the move.
  - But the log's paint would often arrive before the ball, which reads worse than 0.5m.

---

## 3. Files

| file | change |
| --- | --- |
| `src/net/Net.ts` | `onShots`: no age passed to `fire`; a shot older than `MAX_AGE` (0.5s) is skipped. `MAX_LAG` → `MAX_AGE`, with its comment. |
| `src/gameplay/Ballistics.ts` | `fire()`: the `lag` parameter, its catch-up loop and its doc comment go. No other caller passes it. |

Load cost: a few bytes less. Nothing new runs during play, and a remote shot no longer steps
up to 30 times on arrival.

---

## 4. Tests

**`net-test`, new: "a friend's ball leaves their marker on the other page, over a slow
connection".**
- **The delay:** both pages' WebSocket frames are held back 40ms each way. `arrive` learns a
  `delay` option that sets up `context.routeWebSocket`. This is the part of p3p2's lag proxy
  that `NEXT_9.md` lists as not ported.
- **The shots:** Ada stands still in a clear lane and fires 10 balls far down it with `shoot`.
- **What Grace's page records:** each ball from Ada's place, with its origin (from `shot:fired`
  with `remote`) and where it is first drawn. The draw position comes from wrapping
  `ballistics.update` and reading the pool's render positions, as the repro does.
- **Checks:**
  - every ball is drawn;
  - every ball is first drawn within 2.5m of its origin. At this delay, today's build puts it
    5–9m out, so the check fails there first.

**`net-test`, new: "a shot that arrives half a second late isn't flown".**
- Ada's page sends a hand-made `sh` message dated 2s ago through `net.room.send`.
- Grace's `ballistics.activeCount` doesn't change, and no remote `shot:fired` is emitted.
- A control message dated now is flown.

**Unchanged:**
- **The other `net-test` cases.** In the bots-and-guest case Grace stands still 6m from the bot,
  so the later arrival doesn't change whether she's tagged.
- **The other suites.** `ballistics-test` and `mural-test` call `fire` without an age.

The whole of `npm test` runs on an idle machine, with `net-test` on the GPU, as `NEXT_8.md` and
`NEXT_9.md` advise.

---

## 5. Order of work

1. Add the slow-connection case to `net-test`, and see it fail on today's build.
2. Remove the catch-up from `Ballistics.fire` and `Net.onShots`, and add `MAX_AGE`.
3. Add the late-shot case.
4. `npm run build`, then `npm test`. Then `NEXT_10b.md`.
5. **By hand, which nothing headless replaces:** a room with two machines, or one on a phone's
   mobile data. Watch a friend and a bot fire from the side.

---

## Decisions for you

These are the defaults I'll go with unless you say otherwise:

1. **Bots get slightly worse at hitting a guest who is moving,** by about the network delay
   (§2.1, item 2). The alternative is to keep the catch-up for bots' balls only. Then those balls
   stay invisible at close range on a guest's page, which is half of this bug.
2. **A shot older than 0.5s is dropped.** That's the old cap, reused. A higher value would keep
   balls from a slow connection at the cost of balls that leave the marker late.
3. **The plan's name.** `PLAN_10.md` was already implemented for the feature, so this is
   `PLAN_10b.md`, and its summary will be `NEXT_10b.md`. Rename it if you'd rather it be
   `PLAN_11`.

## Not in this plan

- **A friend's position is timed by when it arrives here, not by when the server got it.**
  - p3p2's `presence.on` passes that time (`at`) for `Smooth.set`, but `Net` drops it
    (`Net.ts:341`). `readPresence` could use `room.presence.at(member)`.
  - p3p2's docs say the figure is then drawn where the friend was when the batch happened to
    arrive. That can be up to 1/20s off, by a different amount each time.
  - It might show as a slight stutter in a friend's walk. It's unrelated to this bug and is a
    two-line change. I haven't checked how it looks.
- **Shots that arrive while the tab is hidden fly when it comes back.** The loop doesn't run,
  so they wait in the pool. That happens today too, after up to 0.5s of catch-up. The bots
  don't go after a hidden guest, so this only affects friends' balls, which are only shown.
  The fix would be to drop remote shots while `document.hidden`.
