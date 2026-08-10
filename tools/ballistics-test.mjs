/**
 * Headless ballistics tests.
 *
 * Fires real shots in the real game and asserts on where they land. The claim
 * that matters most is convergent aiming: with the camera offset behind and to
 * the side of the muzzle, shots must still land on the crosshair, not beside it.
 *
 * Usage: node tools/ballistics-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

// The test course, not the park: every coordinate below is a fixture of
// that geometry.
const url = process.argv[2] ?? 'http://localhost:4173/dp-paintball/?scene=course';
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

// Simulated time is driven from here rather than by rendered frames. These
// headless frames are software-rasterised and land well under the ~12fps
// `simElapsed` needs to keep pace with the wall clock, so waiting on frames for
// simulated seconds cost minutes per test. See Game.stepSim.
//
// Claimed before boot starts the loop, so a run begins from the same world
// every time rather than from however far the bots wandered while the page
// was still loading.
await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
await page.evaluate(() => {
  if (!window.__paintball.setManualSim) {
    throw new Error('this build predates the sim step hook — rebuild it');
  }
  window.__paintball.setManualSim(true);
});
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'), {
  timeout: 30_000,
});

// Fire input is ignored until the canvas has pointer lock, and lock is only
// granted on a completed click. Without this, the first burst is swallowed.
await page.mouse.click(512, 288);
await page.waitForTimeout(400);
const locked = await page.evaluate(() => window.__paintball.game.input.isLocked);
if (!locked) {
  console.error('FATAL: pointer lock was not granted; fire input cannot be tested');
  await browser.close();
  process.exit(1);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function place(x, y, z, yaw, pitch = 0) {
  await page.evaluate(
    ({ x, y, z, yaw, pitch }) => {
      const { player, state } = window.__paintball;
      state.yaw = yaw;
      state.pitch = pitch;
      player.teleport(new (state.position.constructor)(x, y, z));
      window.__paintball.impacts.length = 0;
    },
    { x, y, z, yaw, pitch },
  );
  await waitSim(0.3);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

/** Fires for a span of simulated time, then waits for rounds to land. */
async function fireFor(seconds, settleSeconds = 1.4) {
  await page.mouse.down();
  await waitSim(seconds);
  await page.mouse.up();
  await waitSim(settleSeconds);
  // Only our own shots: anything else in the world firing would otherwise be
  // folded into the grouping measurement.
  return page.evaluate(() =>
    window.__paintball.impacts.filter((i) => i.shooterId === 'player'));
}

// --- Shots are produced and land ------------------------------------------
// Stand in the open facing the corridor wall at x=-13.2.
await place(-11.0, 1, 14, Math.PI / 2);
const impacts = await fireFor(0.7);
check('firing produces impacts', impacts.length >= 3, `${impacts.length} impacts`);

// --- Fire rate ------------------------------------------------------------
// 0.14s interval over 700ms is ~5 shots. Allow slack for frame quantisation.
check(
  'fire rate near config (0.14s)',
  impacts.length >= 3 && impacts.length <= 8,
  `${impacts.length} shots in 0.7s of sim`,
);

// --- Convergent aiming ----------------------------------------------------
// Facing -X at a wall whose inner face is x=-13.2. Every shot must land on that
// wall, at roughly the height we're aiming, not scattered off to one side.
const onWall = impacts.filter((i) => Math.abs(i.x - -13.2) < 0.35);
check(
  'shots land on the aimed wall',
  onWall.length >= impacts.length - 1,
  `${onWall.length}/${impacts.length} on the wall plane`,
);

if (impacts.length > 0) {
  const spreadZ = Math.max(...impacts.map((i) => i.z)) - Math.min(...impacts.map((i) => i.z));
  // At ~2.2m range, a 0.9 degree cone is only a few cm. Anything approaching
  // the 0.26m shoulder offset would mean aiming is not converging.
  check('shot grouping is tight at close range', spreadZ < 0.25, `z spread ${spreadZ.toFixed(3)}m`);

  const avgY = impacts.reduce((s, i) => s + i.y, 0) / impacts.length;
  check(
    'shots land near the aim height',
    Math.abs(avgY - 1.35) < 0.5,
    `mean impact y=${avgY.toFixed(2)}`,
  );
}

// --- Gravity produces an arc ----------------------------------------------
// Fire level across open ground; the drop over distance must be visible.
// x=30 is clear of every obstacle, and firing toward -Z from z=45 leaves ~95m
// of ground to land on. Firing off the edge of the 100m plane just produces
// projectiles that expire in mid-air with nothing to report.
await place(30, 1, 45, 0, 0);
const longShots = await fireFor(0.2, 2.5);
if (longShots.length > 0) {
  const far = longShots[0];
  const travelled = Math.hypot(far.x - 30, far.z - 45);
  // The upper bound is the muzzle-speed guard: a level shot from 2.35m carries
  // ~21m at 63 m/s and only ~14m at the 42 m/s this used to be, so the window
  // fails if the speed regresses as well as if the arc flattens out entirely.
  check(
    'shots arc downward over distance',
    far.y < 1.0 && travelled > 17 && travelled < 27,
    `landed ${travelled.toFixed(1)}m out at y=${far.y.toFixed(2)}`,
  );
} else {
  check('shots arc downward over distance', false, 'no impacts recorded');
}

// --- Projectiles are recycled, not leaked ---------------------------------
await place(0, 1, 20, 0);
await page.mouse.down();
await waitSim(1.5);
const midBurst = await page.evaluate(() => window.__paintball.ballistics.activeCount);
await page.mouse.up();
await waitSim(4.2);
const afterSettle = await page.evaluate(() => window.__paintball.ballistics.activeCount);
check('projectiles are in flight while firing', midBurst > 0, `${midBurst} active`);
check('projectiles expire after firing stops', afterSettle === 0, `${afterSettle} active`);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
