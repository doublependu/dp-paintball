# Next, after iteration 10b (a friend's ball leaves their marker)

Issue 1 of `prompt_10.md` is fixed, following `PLAN_10b.md`. There's one small departure,
listed under Tests. Nothing is committed.

## What was done

### The cause

When another page's shot arrived, `Net.onShots` flew the ball through its whole age at once
(up to 0.5s) before it was ever drawn. Meanwhile the page drew the shooter about 100ms in the
past. At 63 m/s, a ball on a normal internet connection first appeared 5–15m from the marker.
A ball whose target was nearer than that landed before it was drawn at all. All the player saw
was the burst and the paint. `PLAN_10b.md` §1 has the measurements.

### The change

- **`Net.onShots`** fires a remote ball from where it was fired, as it arrives, with no
  catch-up.
  - A shot more than 0.5s old when it arrives (`MAX_AGE_MS`) isn't flown. Its paint and tag
    still come through the log.
  - The wire format is unchanged: the shot's time was already sent.
- **`BallisticsSystem.fire`** loses its `lag` argument, the catch-up loop and the `ctx` it kept
  for that. No other caller passed `lag`.

### Measured on the fixed build

This is the `PLAN_10b.md` repro, two pages in a p3p2 room with 60ms added each way between each
page and the server:

| | before | after | the shooter's own page |
| --- | --- | --- | --- |
| friend standing: first drawn from their drawn marker | 11.0m | **1.03m** (max 2.06) | 1.03m |
| friend walking | 11.5m | **1.56m** | 0.96m |
| bots' balls on a guest's page | 12.1m | **1.0–1.1m** | — |
| bots' balls never drawn | 4 of 58, 9 of 23 | **1 of 60, 0 of 27** | — |
| log's paint after the local burst | 125 to 431ms | **34 to 272ms**, never first | — |

The one bot ball that wasn't drawn hit something within its first step, about 1m away. It
wouldn't be drawn on the host's page either.

## Tests

| suite | before | now | |
| --- | --- | --- | --- |
| `net-test` | 8 | 9 | +1, below |
| the other 12 | 279 | 279 | unchanged |

**`npm test`: 13 suites, 288 checks, all pass.** Each suite ran on its own on the final build:
16 minutes in all, with `net-test` against Docker `p3p2/p3p2:0.1.1` on the GPU.

**`net-test`, new:** "over a slow connection, a friend's ball leaves their marker on the other
page; a shot that comes half a second late is not flown".
- `arrive` and `park` take `{ delay }`. With it, every WebSocket message between a page and the
  server is held back that long, through `context.routeWebSocket`. This case uses 50ms each way.
- `lane()` finds a spot with 30m of open air ahead and none overhead, and stands Ada there. She
  fires 10 balls down it.
- `watchBalls()` records, on Grace's page, where each of Ada's balls was fired and where it was
  first drawn. It wraps `ballistics.acquire` and `ballistics.update`, so it depends on the
  pool's internals.
- **Checks:**
  - every ball is drawn;
  - every ball is first drawn within 3.5m of where it was fired.
- **Late shots:** `sendShot()` sends a hand-written `sh` message. One dated 2s ago isn't flown;
  one dated now is.
- **On the old build:** the first check failed with balls 9.1–12.9m out. With that check
  removed, the late-shot check failed too, because the old build flew the 2s-old shot.
- **On the new build:** it passed 4 of 4 runs, with balls 0–1m out.

**Departure from the plan:** the two new checks are one case, not two. They need the same room
and the same lane, and a case costs a server and two page loads.

## Load budget

Gzip -9, HEAD's build against this one:
- entry JS: 236,974 → 236,886 bytes (−88);
- CSS: unchanged.

Nothing new runs during play. A remote shot no longer takes up to 30 fixed steps when it
arrives.

## Still open

- **A bot's ball now reaches a guest later, by the delay.** That ball is judged on the guest's
  page. A moving guest is a little harder for the bots to hit; a standing one is hit the same.
  This is `PLAN_10b.md`'s Decision 1, taken as the default. Nothing measures how often bots hit
  guests, so the effect is from the code, not from data.
- **A sprinting friend's first frame is about 0.6m further from their drawn marker** than on
  their own page. The figure is drawn about 100ms behind. A decaying render offset in
  `BallisticsSystem.update` would close it, if it shows in play.
- **Friends' presence is dated by when it arrives here, not by when the server got it**
  (`Net.ts:341` drops p3p2's `at`). This might be a small stutter in a friend's walk. It's not
  checked.
- **Shots that arrive while the tab is hidden fly when it comes back.** This was already the
  case. The bots don't go after a hidden guest, so it only affects friends' balls, which are
  only shown.
- **Nobody has watched it by hand.** Worth a room on two machines, or one on a phone's mobile
  data: watch a friend and a bot fire from the side.
- **Carried over from `NEXT_10.md`:**
  - the phone's share row breaks when the browser can't share files;
  - Play again doesn't go back to fullscreen on a phone;
  - a ready-check for rooms;
  - five of the six multiplayer tests not ported. The new `delay` option is the start of the
    lag proxy that "a slow connection that drops" needs; dropping messages isn't there yet.

## Next

Play a room by hand on two machines, to see both iteration 10 and this fix. Then fix the
phone's share row, as `NEXT_10.md` suggests.
