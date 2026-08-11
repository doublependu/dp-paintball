/**
 * Headless arena tests.
 *
 * The map's job is to be walkable and inescapable. These check that the player
 * lands on solid ground everywhere they might spawn or fight, that the
 * perimeter actually contains them, and that paint sticks to park surfaces.
 *
 * Usage: node tools/arena-test.mjs [url]
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
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

const startedAt = Date.now();
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
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 60_000 });
const readyMs = Date.now() - startedAt;

await page.mouse.click(512, 288);
await page.waitForTimeout(400);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

const read = () => page.evaluate(() => {
  const s = window.__paintball.state;
  return { x: s.position.x, y: s.position.y, z: s.position.z, grounded: s.grounded };
});

/** Drops the player from a height above a point and reports where they settle. */
async function dropAt(x, z, from = 20) {
  await page.evaluate(({ x, z, from }) => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(x, from, z));
  }, { x, z, from });
  await waitSim(3.4);
  return read();
}

check('loads within budget', readyMs < 4000, `${readyMs}ms`);

// --- Landing on solid ground across the map --------------------------------
// Sampled across every distinct region. Anything that falls through the world
// ends up far below; anything unreachable never grounds.
const probes = [
  ['plaza', 0, 8], ['mall', 0, 44], ['terrace', 0, 21],
  ['lake shore east', 34, -16], ['ramble', -30, -70],
  ['east woods', 60, 10], ['bridge deck', -44, -30],
  ['west bank', -66, -14], ['south lawn', 26, 74], ['sheep meadow', -50, 42],
  // The woodland belt: the whole point of it is that you can walk into it, so
  // every side of it has to be standable ground rather than scenery.
  ['belt north', -20, -130], ['belt south', 30, 140],
  ['belt west', -140, 20], ['belt east', 150, -30],
];
let landed = 0;
const failures = [];
for (const [name, x, z] of probes) {
  const at = await dropAt(x, z);
  const ok = at.grounded && at.y > -6 && Number.isFinite(at.y);
  if (ok) landed++; else failures.push(`${name} y=${at.y.toFixed(1)} grounded=${at.grounded}`);
}
check('player lands on solid ground everywhere', landed === probes.length,
      failures.length ? failures.join('; ') : `${landed}/${probes.length} regions`);

// --- The bridge is standable and crossable ---------------------------------
const onBridge = await dropAt(-44, -30, 14);
check('Bow Bridge deck is standable', onBridge.grounded && onBridge.y > 1.5,
      `settled at y=${onBridge.y.toFixed(2)}`);

// --- The arcade undercroft has standing headroom ---------------------------
// Must be walked into through an arch. Dropping from above just lands on the
// terrace slab that forms its roof, which proves nothing about the passage.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = Math.PI;  // face south, toward the colonnade at z=16
  player.teleport(new (state.position.constructor)(0, 1, 11));
});
await waitSim(1.2);
await page.keyboard.down('w');
await waitSim(3.0);
await page.keyboard.up('w');
await waitSim(0.5);
const undercroft = await read();
check('arcade undercroft is walkable through an arch',
      undercroft.grounded && undercroft.y < 1.5 && undercroft.z > 16.5,
      `reached z=${undercroft.z.toFixed(1)} at y=${undercroft.y.toFixed(2)}, under a 4.2m slab`);

// --- Containment -----------------------------------------------------------
// Sprint at each wall for long enough to cross the map, and confirm we are
// still inside. Phase 1 established that only flat vertical walls hold.
const escapes = [];
for (const [name, x, z, yaw] of [
  ['north', 0, -150, 0], ['south', 0, 150, Math.PI],
  ['west', -150, 0, Math.PI / 2], ['east', 150, 0, -Math.PI / 2],
]) {
  await page.evaluate(({ x, z, yaw }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    player.teleport(new (state.position.constructor)(x, 12, z));
  }, { x, z, yaw });
  await waitSim(2.0);
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  await waitSim(6.0);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await waitSim(0.4);
  const at = await read();
  // PARK_HALF is 168 and the wall stands at 166; a metre of slack covers the
  // capsule radius resting against it.
  const outside = Math.abs(at.x) > 167 || Math.abs(at.z) > 167 || at.y < -6;
  if (outside) escapes.push(`${name} -> (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`);
}
check('perimeter contains the player on all four sides', escapes.length === 0,
      escapes.length ? escapes.join('; ') : 'no escapes');

// --- Paint sticks to park surfaces -----------------------------------------
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = Math.PI; state.pitch = -0.12;
  player.teleport(new (state.position.constructor)(0, 3, 10));
});
await waitSim(2.0);
const beforePaint = await page.evaluate(() => window.__paintball.paint.splatCount);
await page.mouse.down();
await waitSim(1.0);
await page.mouse.up();
await waitSim(1.4);
const afterPaint = await page.evaluate(() => window.__paintball.paint.splatCount);
check('paint sticks to arena geometry', afterPaint > beforePaint,
      `${beforePaint} -> ${afterPaint} splats`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
