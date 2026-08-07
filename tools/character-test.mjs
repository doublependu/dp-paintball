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
check('the player and a bot roster exist', roster.length >= 4 && roster[0].id === 'player',
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
// Bots wander, so rather than firing at a fixed coordinate, step up to whichever
// bot is nearest and re-aim at its live chest position between bursts.
const totalBotHits = () => page.evaluate(() =>
  window.__paintball.characters.allBots.reduce((s, b) => s + b.character.hitsTaken, 0));
const botSplats = () => page.evaluate(() =>
  window.__paintball.characters.allBots.reduce((s, b) => s + b.character.paint.splatCount, 0));

const hitsBefore = await totalBotHits();
const splatsBefore = await botSplats();
let landed = false;

for (let attempt = 0; attempt < 6 && !landed; attempt++) {
  // Plant ourselves a few metres from the closest bot, facing it.
  await page.evaluate(() => {
    const { player, state, characters } = window.__paintball;
    let best = null;
    let bestD = Infinity;
    for (const b of characters.allBots) {
      const d = Math.hypot(b.position.x - state.position.x, b.position.z - state.position.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    const dx = best.position.x - state.position.x;
    const dz = best.position.z - state.position.z;
    const len = Math.hypot(dx, dz) || 1;
    // Stand 6m short of the bot, on the line between us.
    const stand = new (state.position.constructor)(
      best.position.x - (dx / len) * 6, 2, best.position.z - (dz / len) * 6);
    player.teleport(stand);
    state.yaw = Math.atan2(-(dx / len), -(dz / len));
    state.pitch = 0.02;
  });
  await waitSim(0.6);
  // Re-aim at the live position, since it moved while we settled.
  await page.evaluate(() => {
    const { state, characters } = window.__paintball;
    let best = null;
    let bestD = Infinity;
    for (const b of characters.allBots) {
      const d = Math.hypot(b.position.x - state.position.x, b.position.z - state.position.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    const dx = best.position.x - state.position.x;
    const dz = best.position.z - state.position.z;
    state.yaw = Math.atan2(-dx, -dz);
  });
  await page.mouse.down();
  await waitSim(0.8);
  await page.mouse.up();
  await waitSim(1.0);
  landed = (await totalBotHits()) > hitsBefore;
}

const playerRow = (await stats()).find((c) => c.id === 'player');
check('shooting a character registers on that character', landed,
      `bot hits ${hitsBefore} -> ${await totalBotHits()}`);
check('paint lands on the body', (await botSplats()) > splatsBefore,
      `bot splats ${splatsBefore} -> ${await botSplats()}`);
check('the shooter is credited', playerRow.given > 0, `player given ${playerRow.given}`);

// --- Grace window, measured in simulation time ------------------------------
// Drive the event path directly at a fixed rate: 40 hits over 4 simulated
// seconds against a 1s window should register about 4, not 40. Firing a real
// gun at a moving bot cannot measure this cleanly.
const graceResult = await page.evaluate(async () => {
  const { game, characters, state } = window.__paintball;
  const bot = characters.allBots[0];
  const V = state.position.constructor;
  const before = bot.character.hitsTaken;
  for (let i = 0; i < 40; i++) {
    game.events.emit('hit:character', {
      targetId: bot.id, shooterId: 'player', color: 0xff3d81,
      point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
      normal: new V(0, 0, 1), impactSpeed: 30,
    });
    // 0.1s of simulation between hits, ticked explicitly.
    bot.character.tickGameplay(0.1);
  }
  return bot.character.hitsTaken - before;
});
check('grace window throttles hits in sim time',
      graceResult >= 3 && graceResult <= 6,
      `${graceResult} of 40 hits registered across 4s of simulated grace time`);

// --- The player's own body can be painted ----------------------------------
// Third-person means paint on your own back is a headline feature, so it needs
// its own check; nothing shoots the player yet.
const playerPaintBefore = await page.evaluate(() =>
  window.__paintball.characters.playerCharacter.paint.splatCount);
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const Vec = state.position.constructor;
  const p = state.position;
  // A bot may have tagged us moments ago; clear the grace window so this
  // synthetic hit is not silently swallowed.
  characters.playerCharacter.tickGameplay(5);
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
