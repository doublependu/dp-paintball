/**
 * Headless character tests.
 *
 * Covers hit routing (person vs. park), the grace window, scoring, and that
 * paint actually lands on a body. The grace-window check matters specifically:
 * it was being decremented on render-frame time rather than simulation time, so
 * it expired several times too fast on a slow machine.
 *
 * Usage: node tools/character-test.mjs [url]
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

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 60_000 });
await page.mouse.click(512, 288);
await page.waitForTimeout(400);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitSim(seconds) {
  const start = await page.evaluate(() => window.__paintball.simTime());
  await page.waitForFunction(({ start, seconds }) =>
    window.__paintball.simTime() - start >= seconds, { start, seconds },
    { timeout: 180_000, polling: 30 });
}

const stats = () => page.evaluate(() =>
  window.__paintball.characters.allCharacters.map((c) => ({
    id: c.id, taken: c.hitsTaken, given: c.hitsGiven, splats: c.paint.splatCount,
  })));

// --- Roster ----------------------------------------------------------------
const roster = await stats();
check('player and dummies exist', roster.length === 4 && roster[0].id === 'player',
      roster.map((r) => r.id).join(', '));

// --- Rig geometry ----------------------------------------------------------
const rig = await page.evaluate(() => {
  const c = window.__paintball.characters.playerCharacter;
  const g = c.rig.geometry;
  return {
    verts: g.getAttribute('position').count,
    tris: g.getIndex().count / 3,
    hasJoint: Boolean(g.getAttribute('aJoint')),
    hasUv: Boolean(g.getAttribute('uv')),
    joints: c.rig.jointMatrices.length,
  };
});
check('rig geometry is one skinned mesh',
      rig.hasJoint && rig.hasUv && rig.joints === 8 && rig.verts === rig.tris * 2,
      `${rig.verts} verts, ${rig.tris} tris, ${rig.joints} joints`);

// --- Hit routing: person, not park -----------------------------------------
// Stand west of dummy-a at (-13, 2) and fire east into it.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  state.yaw = Math.PI / 2; state.pitch = 0;
  player.teleport(new (state.position.constructor)(-4, 2, 2));
  window.__paintball.impacts.length = 0;
});
await waitSim(1.4);

const worldBefore = await page.evaluate(() => window.__paintball.paint.splatCount);
await page.mouse.down();
await waitSim(1.0);
await page.mouse.up();
await waitSim(1.2);

const afterBurst = await stats();
const dummyA = afterBurst.find((c) => c.id === 'dummy-a');
const playerRow = afterBurst.find((c) => c.id === 'player');
const worldAfter = await page.evaluate(() => window.__paintball.paint.splatCount);

check('hits on a character register on that character', dummyA.taken > 0,
      `dummy-a took ${dummyA.taken}`);
check('paint lands on the body', dummyA.splats > 0, `${dummyA.splats} splats on dummy-a`);
check('the shooter is credited', playerRow.given >= dummyA.taken,
      `player given ${playerRow.given}`);
check('character hits do not also paint the world',
      worldAfter === worldBefore,
      `world splats ${worldBefore} -> ${worldAfter}`);

// --- Grace window, measured in simulation time ------------------------------
// Fire continuously for 4 simulated seconds. With a 1s window, that is at most
// ~5 registered hits, not the ~28 shots actually fired.
const beforeGrace = (await stats()).find((c) => c.id === 'dummy-a').taken;
await page.mouse.down();
await waitSim(4.0);
await page.mouse.up();
await waitSim(1.2);
const afterGrace = (await stats()).find((c) => c.id === 'dummy-a').taken;
const registered = afterGrace - beforeGrace;
check('grace window throttles hits in sim time',
      registered >= 2 && registered <= 7,
      `${registered} hits registered over 4s of continuous fire`);

// --- The player's own body can be painted ----------------------------------
// Third-person means paint on your own back is a headline feature, so it needs
// its own check; nothing shoots the player yet.
const playerPaintBefore = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.paint.splatCount);
await page.evaluate(() => {
  const { game, state } = window.__paintball;
  const Vec = state.position.constructor;
  const p = state.position;
  game.events.emit('hit:character', {
    targetId: 'player',
    shooterId: 'dummy-a',
    color: 0x00d4e8,
    // Chest height, just in front of the torso.
    point: new Vec(p.x, p.y + 1.1, p.z - 0.2),
    normal: new Vec(0, 0, -1),
    impactSpeed: 34,
  });
});
await waitSim(0.4);
const playerPaintAfter = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.paint.splatCount);
const playerTaken = (await stats()).find((c) => c.id === 'player').taken;
check('the player character can be painted', playerPaintAfter > playerPaintBefore,
      `${playerPaintBefore} -> ${playerPaintAfter} splats`);
check('being hit increments the player counter', playerTaken > 0, `taken ${playerTaken}`);

// --- Animation responds to state -------------------------------------------
// Must go through real input: PlayerController rewrites state.crouching from
// the input map every fixed step, so poking the flag directly does nothing.
const pelvisY = () => page.evaluate(() =>
  window.__paintball.characters.playerCharacter.rig.joints[1].position.y);
const standingPelvis = await pelvisY();
await page.keyboard.down('Control');
await waitSim(0.8);
const crouchedPelvis = await pelvisY();
await page.keyboard.up('Control');
await waitSim(0.6);
const recoveredPelvis = await pelvisY();

check('crouch lowers the pelvis', crouchedPelvis < standingPelvis - 0.2,
      `${standingPelvis.toFixed(3)} -> ${crouchedPelvis.toFixed(3)}`);
check('standing back up restores the pelvis',
      recoveredPelvis > crouchedPelvis + 0.2,
      `${crouchedPelvis.toFixed(3)} -> ${recoveredPelvis.toFixed(3)}`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
