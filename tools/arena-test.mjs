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

/**
 * Two query flags, and between them they are what makes a run repeatable.
 *
 * `manual` freezes the simulation clock before the first frame — see `main.ts`.
 * Claiming it through `setManualSim` after the page loads is a race the loop
 * sometimes wins, and a run that starts a tenth of a second into the round is a
 * different round.
 *
 * `seed` pins the loot, which is seeded from the wall clock on purpose so that
 * crates hide somewhere new every game. Left free, a round diverges the moment
 * the first bot goes restocking — about two minutes in, which is exactly where
 * the natural-round case below spends its time.
 */
const base = process.argv[2] ?? 'http://localhost:4173/';
const url = base + (base.includes('?') ? '&' : '?') + 'manual&seed=1';
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
//
// The bots go to the far corner of the park first. This is the one probe in
// this suite that has to walk a specific line rather than fall straight down,
// and five bots spawn within twenty metres of the arch: one standing in the
// bay is a wall, and the walk stops short of the undercroft for reasons that
// have nothing to do with the architecture being tested.
await page.evaluate(() => {
  const { player, state, characters } = window.__paintball;
  const V = state.position.constructor;
  for (const bot of characters.allBots) {
    bot.respawn(new V(bot.position.x + 260, bot.position.y, bot.position.z + 260));
  }
  state.yaw = Math.PI;  // face south, toward the colonnade at z=16
  player.teleport(new V(0, 1, 11));
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

// --- The grand stairs actually climb ---------------------------------------
// They did not. Three flights were placed on the plateau *behind* the terrace,
// climbing down a slope that rises to meet them: the bottom flight was buried,
// the top one stood in the air, and the terrace could only be reached by
// walking the long way round. Walking up them is the only check that catches
// that, because every individual flight was exactly where it was asked to be.
async function walkFrom(x, z, yaw, seconds, drop = 1) {
  await page.evaluate(({ x, z, yaw, drop }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    player.teleport(new (state.position.constructor)(x, drop, z));
  }, { x, z, yaw, drop });
  await waitSim(1.0);
  await page.keyboard.down('w');
  await waitSim(seconds);
  await page.keyboard.up('w');
  await waitSim(0.4);
  return read();
}

const climbed = await walkFrom(19, 4, Math.PI, 5.0);
check('the grand stairs climb from the plaza to the terrace',
      climbed.grounded && climbed.y > 3.9 && climbed.z > 15,
      `reached (${climbed.x.toFixed(1)}, ${climbed.y.toFixed(2)}, ${climbed.z.toFixed(1)})`);

// --- And the bridge can be got onto ----------------------------------------
// Bow Bridge's abutments top out 2m above the ground its approach corridor is
// levelled to, so both ends were a wall with a bridge on top until the ramps
// went in.
const onRamp = await walkFrom(-44, -5, 0, 4.5);
check('Bow Bridge is reachable from its southern approach',
      onRamp.grounded && onRamp.y > 2.0 && onRamp.z < -15,
      `reached (${onRamp.x.toFixed(1)}, ${onRamp.y.toFixed(2)}, ${onRamp.z.toFixed(1)})`);

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

// --- The place signs -------------------------------------------------------
//
// Driven off the exported table rather than off a copy of it, so a marker that
// moves takes these checks with it instead of leaving a stale coordinate here.
// The table was settled against the layout masks offline; what is checked here
// is the live park, which is the only place the colliders and the navgrid
// exist.
const signs = await page.evaluate(() => {
  const { signs, layout } = window.__paintball;
  const all = [
    { ...signs.dedication, half: 2.4 / 2 },
    ...signs.places.map((s) => ({ ...s, half: 1.9 / 2 })),
  ];
  return all.map((sign) => {
    // The real footprint, not a bounding square: the board is turned to face
    // its subject, so its own axes are what the posts and the plank run along.
    const yaw = Math.atan2(sign.faceX - sign.x, sign.faceZ - sign.z);
    const along = [Math.cos(yaw), -Math.sin(yaw)];
    const through = [Math.sin(yaw), Math.cos(yaw)];
    const at = (a, b) => [
      sign.x + along[0] * a + through[0] * b,
      sign.z + along[1] * a + through[1] * b,
    ];

    let walk = 0;
    let lake = 0;
    for (const a of [-sign.half, 0, sign.half]) {
      for (const b of [-0.25, 0.15]) {
        const [x, z] = at(a, b);
        walk = Math.max(walk, layout.walkMask(x, z));
        lake = Math.max(lake, layout.lakeMask(x, z));
      }
    }
    // Fall measured between the two post feet, which is what actually decides
    // whether one of them floats.
    const foot = sign.half - 0.3;
    const left = layout.heightAt(...at(-foot, -0.09));
    const right = layout.heightAt(...at(foot, -0.09));

    const { PLAZA, TERRACE, ARCADE } = layout;
    return {
      name: sign.name,
      x: sign.x,
      z: sign.z,
      walk,
      lake,
      fall: Math.abs(left - right),
      fountain: Math.hypot(sign.x - PLAZA.x, sign.z - PLAZA.z) < 8.5,
      terrace: Math.abs(sign.x) < TERRACE.halfWidth + 1.5 &&
        sign.z > ARCADE.z - 2.5 && sign.z < TERRACE.southZ + 2,
      screen: layout.screenBlocks(sign.x, sign.z, 3),
    };
  });
});

check('there is a sign for every named place', signs.length === 11,
      signs.map((s) => s.name).join(', '));

// A sign is a collider and the navgrid is built by querying physics, so one
// overhanging a walk pinches the path every bot on that side of the park uses.
// Hence 0.05 here where `canPlant` lets a tree have 0.15.
const onWalk = signs.filter((s) => s.walk >= 0.05 || s.lake >= 0.05);
check('no sign stands on a walk or in the water', onWalk.length === 0,
      onWalk.map((s) => `${s.name} walk=${s.walk.toFixed(2)} lake=${s.lake.toFixed(2)}`).join('; ') ||
      `${signs.length} footprints clear, worst walk ${Math.max(...signs.map((s) => s.walk)).toFixed(2)}`);

const inProp = signs.filter((s) => s.fountain || s.terrace || s.screen);
check('no sign stands inside something else', inProp.length === 0,
      inProp.map((s) => s.name).join('; ') || 'clear of the basin, the terrace and the board');

const steep = signs.filter((s) => s.fall > 0.25);
check('every sign stands on ground flat enough for both posts',
      steep.length === 0,
      steep.map((s) => `${s.name} falls ${s.fall.toFixed(2)}m`).join('; ') ||
      `worst fall between the posts ${Math.max(...signs.map((s) => s.fall)).toFixed(2)}m`);

const crowded = [];
for (let i = 0; i < signs.length; i++) {
  for (let j = i + 1; j < signs.length; j++) {
    const d = Math.hypot(signs[i].x - signs[j].x, signs[i].z - signs[j].z);
    if (d < 2.5) crowded.push(`${signs[i].name}/${signs[j].name} ${d.toFixed(1)}m`);
  }
}
check('no two signs are on top of each other', crowded.length === 0,
      crowded.join('; ') || 'all at least 2.5m apart');

// Reachability, which is the check that catches a sign that walled itself into
// the wood: the grid is pruned to what is reachable from the player's spawn, so
// a cell near a sign means somebody can walk up and read it. 4.5m rather than
// 2m because the grid is 2m and a sign blocks the cells it overlaps — the
// nearest standable centre beside a 2.4m board is a cell away by construction.
const reach = await page.evaluate((table) => {
  const nav = window.__paintball.characters.navGrid;
  return table.map((sign) => {
    const cell = nav.nearestWalkable(sign.x, sign.z, 4);
    return {
      name: sign.name,
      distance: cell ? Math.hypot(cell.x - sign.x, cell.z - sign.z) : Infinity,
    };
  });
}, signs.map(({ name, x, z }) => ({ name, x, z })));
const stranded = reach.filter((r) => !(r.distance <= 4.5));
check('every sign has walkable ground beside it', stranded.length === 0,
      stranded.map((r) => `${r.name} ${r.distance.toFixed(1)}m`).join('; ') ||
      `furthest ${Math.max(...reach.map((r) => r.distance)).toFixed(1)}m`);

// And a sign takes paint, fired at rather than stamped — the whole point of
// registering the boards is that they are ordinary park geometry, and neither
// the frame nor the plinth of the paint screen is, which is how that omission
// went unnoticed for an iteration.
const shot = await page.evaluate(() => {
  const { player, state, signs, layout } = window.__paintball;
  const spec = signs.places.find((s) => s.name === 'The Mall');
  // Stand five metres out along the way the board is looking, and look back at
  // the middle of the plank — pitch solved rather than left flat, because the
  // ground five metres from a sign is not the ground under it.
  const dx = spec.faceX - spec.x;
  const dz = spec.faceZ - spec.z;
  const length = Math.hypot(dx, dz);
  const x = spec.x + (dx / length) * 5;
  const z = spec.z + (dz / length) * 5;
  const eye = layout.heightAt(x, z) + 1.62;
  // Board top 2.05m above the sign's own ground, and 0.65m of plank under it.
  const boardY = layout.heightAt(spec.x, spec.z) + 2.05 - 0.33;
  state.yaw = Math.atan2(-(spec.x - x), -(spec.z - z));
  state.pitch = Math.atan2(boardY - eye, 5);
  player.teleport(new (state.position.constructor)(x, layout.heightAt(x, z) + 0.4, z));
  window.__paintball.impacts.length = 0;
  return { x: spec.x, z: spec.z, name: spec.name };
});
await waitSim(1.2);
await page.mouse.down();
await waitSim(0.8);
await page.mouse.up();
await waitSim(1.2);
const onSign = await page.evaluate(({ x, z }) =>
  window.__paintball.impacts.filter((i) => Math.hypot(i.x - x, i.z - z) < 1.6 && i.y > 1.0).length,
  shot);
check('paint sticks to a place sign', onSign > 0,
      `${onSign} impacts on "${shot.name}" from 5m in front of it`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
