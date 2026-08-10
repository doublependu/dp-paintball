/**
 * Headless bot tests.
 *
 * Navigation is the part that fails silently: a bot that can't path just stands
 * still, and a bot with a bad walkability grid wanders into the lake. So these
 * check the grid itself, then watch real bots for a stretch of simulated time
 * and assert they stayed on legal ground the whole while.
 *
 * Usage: node tools/bot-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/dp-paintball/';
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

// --- Navgrid ---------------------------------------------------------------
const nav = await page.evaluate(() => {
  const n = window.__paintball.characters.navGrid;
  return {
    cols: n.cols, rows: n.rows, walkable: n.walkableCount, buildMs: n.buildMs,
    // The middle of the lake must not be walkable; the plaza must be.
    lake: n.isWalkable(10, -32),
    plaza: n.isWalkable(0, 8),
    // Dead centre of the fountain basin is solid geometry.
    fountain: n.isWalkable(0, 0),
    // Out in the woodland belt, which is deliberately outside the navgrid —
    // the belt is somewhere for the player to wander, not for bots.
    outside: n.isWalkable(150, 150),
    // Half-extent of the grid in metres, so the bounds check below tracks the
    // map instead of a number that has to be remembered.
    half: (n.cols * 2) / 2,
  };
});
const walkablePct = (100 * nav.walkable) / (nav.cols * nav.rows);
check('navgrid builds quickly', nav.buildMs < 400, `${nav.buildMs.toFixed(0)}ms for ${nav.cols}x${nav.rows}`);
check('navgrid marks a sensible share walkable', walkablePct > 50 && walkablePct < 95,
      `${walkablePct.toFixed(1)}% of cells`);
check('the lake is not walkable', nav.lake === false);
check('the plaza is walkable', nav.plaza === true);
check('prop colliders block cells', nav.fountain === false, 'fountain basin centre');
check('out of bounds is not walkable', nav.outside === false);

// --- Pathfinding -----------------------------------------------------------
const paths = await page.evaluate(() => {
  const n = window.__paintball.characters.navGrid;
  const V = window.__paintball.state.position.constructor;
  const across = n.findPath(new V(0, 0, 8), new V(0, 0, 50));
  const total = across
    ? across.reduce((sum, p, i) =>
        i === 0 ? 0 : sum + Math.hypot(p.x - across[i - 1].x, p.z - across[i - 1].z), 0)
    : 0;
  return {
    acrossLength: across ? across.length : 0,
    acrossDistance: total,
    // Into open water: no route should exist.
    intoLake: n.findPath(new V(0, 0, 8), new V(10, 0, -32)) !== null,
  };
});
check('pathfinds across the park', paths.acrossLength >= 2,
      `${paths.acrossLength} waypoints over ${paths.acrossDistance.toFixed(0)}m`);
check('paths are string-pulled, not staircases',
      paths.acrossLength > 0 && paths.acrossDistance < 70,
      `${paths.acrossDistance.toFixed(0)}m for a ~42m journey`);

// --- Bots behave -----------------------------------------------------------
const before = await page.evaluate(() => window.__paintball.characters.allBots.map((b) => ({
  id: b.id, x: b.position.x, z: b.position.z, personality: b.personality.name,
})));
check('a full roster spawned', before.length >= 4, before.map((b) => b.id).join(', '));
check('personalities vary', new Set(before.map((b) => b.personality)).size >= 3,
      before.map((b) => b.personality).join(', '));

// Park the player centrally and sample bot positions throughout the run.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = 0;
  player.teleport(new (state.position.constructor)(0, 2, 12));
});
await waitSim(1.5);

let illegal = 0;
let offGround = 0;
const samples = 12;
for (let i = 0; i < samples; i++) {
  await waitSim(2.0);
  const bad = await page.evaluate(() => {
    const { characters } = window.__paintball;
    const n = characters.navGrid;
    let illegal = 0;
    let offGround = 0;
    for (const b of characters.allBots) {
      const half = (n.cols * 2) / 2;
      if (Math.abs(b.position.x) > half || Math.abs(b.position.z) > half) illegal++;
      else if (!n.isWalkable(b.position.x, b.position.z)) illegal++;
      // Y must track the terrain, since bots are moved kinematically.
      if (Math.abs(b.position.y - n.groundAt(b.position.x, b.position.z)) > 0.2) offGround++;
    }
    return { illegal, offGround };
  });
  illegal += bad.illegal;
  offGround += bad.offGround;
}
check('bots never stand on illegal ground', illegal === 0,
      `${illegal} violations across ${samples} samples`);
check('bots stay glued to the terrain', offGround === 0,
      `${offGround} deviations across ${samples} samples`);

const after = await page.evaluate(() => window.__paintball.characters.allBots.map((b) => ({
  id: b.id, x: b.position.x, z: b.position.z, state: b.state,
  taken: b.character.hitsTaken, given: b.character.hitsGiven,
})));
const movers = after.filter((b, i) =>
  Math.hypot(b.x - before[i].x, b.z - before[i].z) > 3).length;
check('bots navigate, not idle in place', movers >= Math.ceil(before.length / 2),
      `${movers}/${before.length} moved more than 3m`);

const totalGiven = after.reduce((s, b) => s + b.given, 0);
const playerTaken = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.hitsTaken);
check('bots engage and land hits', totalGiven + playerTaken > 0,
      `bots landed ${totalGiven}, player took ${playerTaken}`);

// --- Reaction to being hit -------------------------------------------------
const startled = await page.evaluate(async () => {
  const { game, characters, state } = window.__paintball;
  const bot = characters.allBots[0];
  const V = state.position.constructor;
  game.events.emit('hit:character', {
    targetId: bot.id, shooterId: 'player', color: 0xff3d81,
    point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
    normal: new V(0, 0, 1), impactSpeed: 34,
  });
  return bot.state;
});
check('a hit bot reacts', startled === 'startled', `state=${startled}`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
