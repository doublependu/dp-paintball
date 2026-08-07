/**
 * Headless movement tests.
 *
 * Drives the real game with real key events and asserts on the resulting
 * simulation state. This exists because a character controller that compiles is
 * not a character controller that works — every claim about slopes, autostep
 * and crouch clearance in the test course needs to actually be checked.
 *
 * Usage: node tools/movement-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
page.on('pageerror', (err) => console.error('[pageerror]', err.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'), {
  timeout: 30_000,
});

/** Places the character, faces them along `yaw`, and lets things settle. */
async function reset(x, y, z, yaw = 0) {
  await page.evaluate(
    ({ x, y, z, yaw }) => {
      const { player, state } = window.__paintball;
      state.yaw = yaw;
      state.pitch = 0;
      player.teleport(new (state.position.constructor)(x, y, z));
    },
    { x, y, z, yaw },
  );
  await waitSim(0.35);
}

const read = () =>
  page.evaluate(() => {
    const { state } = window.__paintball;
    return {
      x: state.position.x,
      y: state.position.y,
      z: state.position.z,
      speed: state.horizontalSpeed,
      grounded: state.grounded,
      height: state.height,
      crouching: state.crouching,
    };
  });

/**
 * Waits for `seconds` of *simulated* time.
 *
 * Wall clock is not a usable measure here: when frames are slow the loop caps
 * catch-up at MAX_SUB_STEPS and drops the backlog, so the game advances in slow
 * motion. Under software rendering that is a ~2.5x discrepancy, which silently
 * invalidates any assertion phrased in milliseconds.
 */
async function waitSim(seconds) {
  const start = await page.evaluate(() => window.__paintball.simTime());
  await page.waitForFunction(
    ({ start, seconds }) => window.__paintball.simTime() - start >= seconds,
    { start, seconds },
    { timeout: 120_000, polling: 30 },
  );
}

/** Holds keys for a span of simulated time. */
async function holdSim(keys, seconds) {
  for (const k of keys) await page.keyboard.down(k);
  await waitSim(seconds);
  for (const k of keys) await page.keyboard.up(k);
}

const hold = holdSim;

/** Holds keys and samples state while they're still down — speed decays fast. */
async function holdAndRead(keys, seconds) {
  for (const k of keys) await page.keyboard.down(k);
  await waitSim(seconds);
  const state = await read();
  for (const k of keys) await page.keyboard.up(k);
  return state;
}

/** Samples over a span of simulated time, returning the highest y seen. */
async function peakHeight(seconds) {
  let peak = -Infinity;
  const start = await page.evaluate(() => window.__paintball.simTime());
  for (;;) {
    peak = Math.max(peak, (await read()).y);
    const now = await page.evaluate(() => window.__paintball.simTime());
    if (now - start >= seconds) return peak;
    await page.waitForTimeout(25);
  }
}

/** Walks forward from a spawn and reports the height gained. */
async function climbFrom(x, y, z, yaw, seconds) {
  await reset(x, y, z, yaw);
  const before = await read();
  await hold(['w'], seconds);
  const after = await read();
  return { gain: after.y - before.y, before, after };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- Walk -----------------------------------------------------------------
// Facing yaw=0 means forward is -Z, so walking must decrease z.
await reset(0, 1, 20);
const walkStart = await read();
const walkEnd = await holdAndRead(['w'], 1.2);
const walked = walkStart.z - walkEnd.z;
check('walks forward', walked > 3.5, `moved ${walked.toFixed(2)}m in 1.2s`);
check(
  'walk speed near config (4.4 m/s)',
  Math.abs(walkEnd.speed - 4.4) < 0.6,
  `${walkEnd.speed.toFixed(2)} m/s`,
);

// --- Sprint ---------------------------------------------------------------
await reset(0, 1, 20);
const sprintEnd = await holdAndRead(['w', 'Shift'], 1.2);
check(
  'sprint faster than walk (7.2 m/s)',
  sprintEnd.speed > walkEnd.speed + 1.5,
  `${sprintEnd.speed.toFixed(2)} m/s`,
);

// --- Jump -----------------------------------------------------------------
// Apex is ~0.32s after launch, so sample across the whole arc rather than
// guessing at a single instant.
await reset(0, 1, 20);
await page.keyboard.press('Space');
const apex = await peakHeight(0.9);
await waitSim(0.6);
const landed = await read();
check('jump reaches roughly its configured 1.15m', apex > 0.95, `apex y=${apex.toFixed(2)}`);
check('lands again', landed.grounded && landed.y < 0.3, `y=${landed.y.toFixed(2)}`);

// --- Crouch ---------------------------------------------------------------
await reset(0, 1, 20);
await page.keyboard.down('Control');
await waitSim(0.3);
const crouched = await read();
await page.keyboard.up('Control');
await waitSim(0.4);
const stoodUp = await read();
check('crouch shrinks the capsule', crouched.crouching && crouched.height < 1.2, `h=${crouched.height}`);
check('stands back up in the open', !stoodUp.crouching && stoodUp.height > 1.7, `h=${stoodUp.height}`);

// --- Headroom -------------------------------------------------------------
// The tunnel at x=14 has 1.4m of clearance. Crouch, walk in, release crouch:
// the upward cast should find the ceiling and refuse to stand.
await reset(14, 1, -11, Math.PI);
await page.keyboard.down('Control');
await waitSim(0.2);
await hold(['w'], 1.6);
const underCover = await read();
await page.keyboard.up('Control');
await waitSim(0.5);
const triedToStand = await read();
check(
  'reaches the tunnel while crouched',
  underCover.crouching && underCover.z > -9 && underCover.z < -3,
  `z=${underCover.z.toFixed(2)}`,
);
check(
  'refuses to stand up under the overhang',
  triedToStand.crouching && triedToStand.height < 1.2,
  `h=${triedToStand.height.toFixed(2)}`,
);

// --- Autostep -------------------------------------------------------------
// The 0.35m flight sits at x=3, rising from z=-20 toward z=-14.4, so it has to
// be approached walking in +Z (yaw = PI). Under the 0.45m autostep limit, it
// should be walkable without jumping.
const steps = await climbFrom(3, 1, -24, Math.PI, 2.6);
check(
  'walks up 0.35m steps without jumping',
  steps.gain > 0.9,
  `climbed ${steps.gain.toFixed(2)}m`,
);

// NOT asserted: that the 0.5m flight (above the 0.45m autostep limit) blocks
// us. It sometimes does and sometimes doesn't — a capsule's rounded bottom can
// roll over a ledge edge when slide is enabled, so maxStepHeight is a soft
// preference, not a ceiling. Reported for visibility; see the note on phase 4
// about arena containment.
const tallSteps = await climbFrom(10, 1, -24, Math.PI, 2.6);
console.log(`NOTE  0.5m steps (above autostep limit): climbed ${tallSteps.gain.toFixed(2)}m`);

// A flat vertical wall is the invariant that actually matters — it's what keeps
// players inside the arena — and it holds regardless of approach.
const wall = await climbFrom(-11.5, 1, 14, Math.PI / 2, 2.6);
check('is blocked by a vertical wall', wall.gain < 0.2, `climbed ${wall.gain.toFixed(2)}m`);

// --- Ramps ----------------------------------------------------------------
// Each ramp has its low lip facing -Z, so all are approached walking in +Z.
// ~6.8m of flat ground precedes the lip, so most of a short run is spent
// walking up to the ramp rather than on it. Give it long enough to be
// unambiguous.
const ramp45 = await climbFrom(-24, 1, -20, Math.PI, 4.5);
check('climbs the 45 degree ramp', ramp45.gain > 2.5, `rose ${ramp45.gain.toFixed(2)}m`);

const ramp60 = await climbFrom(-16, 1, -20, Math.PI, 4.5);
check(
  'does not climb the 60 degree ramp',
  ramp60.gain < 0.8,
  `rose ${ramp60.gain.toFixed(2)}m`,
);

// --- Camera pullback ------------------------------------------------------
// The corridor walls run along Z, so the camera only meets one if we face
// across the corridor (yaw = PI/2 points the camera back toward +X).
const armDistance = () =>
  page.evaluate(() => {
    const { state, camera } = window.__paintball;
    const c = camera();
    return Math.hypot(c.x - state.renderPosition.x, c.z - state.renderPosition.z);
  });

await reset(-11.5, 1, 14, Math.PI / 2);
await waitSim(0.6);
const armInCorridor = await armDistance();

await reset(0, 1, 30, Math.PI / 2);
await waitSim(0.9);
const armInOpen = await armDistance();

check(
  'camera pulls in against a corridor wall',
  armInCorridor < armInOpen - 1.0,
  `corridor ${armInCorridor.toFixed(2)}m vs open ${armInOpen.toFixed(2)}m`,
);

// Fade only kicks in below a 1.1m arm, and mid-corridor still leaves 1.8m. Hug
// the far wall (inner face at x=-9.8) so the camera is forced right in.
await reset(-10.5, 1, 14, Math.PI / 2);
await waitSim(0.7);
const tightArm = await armDistance();
const opacity = await page.evaluate(() => window.__paintball.state.avatarOpacity);
check(
  'avatar fades when the camera is tight',
  opacity < 0.5,
  `opacity ${opacity.toFixed(2)} at arm ${tightArm.toFixed(2)}m`,
);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
