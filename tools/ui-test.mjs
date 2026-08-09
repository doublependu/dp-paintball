/**
 * Headless UI and audio tests.
 *
 * The HUD is the only part of the game the player reads rather than plays, so
 * these check that it reflects real state rather than a copy of it. Audio is
 * checked for the thing that actually breaks in practice: browsers refuse to
 * start a context without a user gesture, and a context created too early
 * stays permanently suspended with no error.
 *
 * Usage: node tools/ui-test.mjs [url]
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
  // Deliberately NOT passing --autoplay-policy: the point is to prove audio
  // starts under the browser's real gesture requirement.
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

// --- Audio must not start before a gesture ---------------------------------
const beforeGesture = await page.evaluate(() => window.__paintball.audio.engine.isReady);
check('audio stays silent before any user gesture', beforeGesture === false);

await page.mouse.click(512, 288);
await page.waitForTimeout(700);
const afterGesture = await page.evaluate(() => ({
  ready: window.__paintball.audio.engine.isReady,
  state: window.__paintball.audio.engine.ctx?.state ?? 'none',
}));
check('audio unlocks on the click that grants pointer lock',
      afterGesture.ready === true, `context state: ${afterGesture.state}`);

// --- HUD presence ----------------------------------------------------------
const present = await page.evaluate(() => ({
  hud: Boolean(document.querySelector('.hud')),
  splash: Boolean(document.querySelector('.splash-overlay')),
  crosshair: Boolean(document.querySelector('.hud__viewport-crosshair')),
  // The HUD must never swallow clicks, or pointer lock breaks.
  hudEvents: getComputedStyle(document.querySelector('.hud')).pointerEvents,
  splashEvents: getComputedStyle(document.querySelector('.splash-overlay')).pointerEvents,
}));
check('HUD, splash and the viewport crosshair exist',
      present.hud && present.splash && present.crosshair);
check('overlays do not intercept pointer events',
      present.hudEvents === 'none' && present.splashEvents === 'none',
      `hud=${present.hudEvents} splash=${present.splashEvents}`);

// --- Counters track character state ----------------------------------------
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const V = state.position.constructor;
  const bot = characters.allBots[0];
  for (let i = 0; i < 3; i++) {
    bot.character.tickGameplay(5);
    game.events.emit('hit:character', {
      targetId: bot.id, shooterId: 'player', color: 0xff3d81,
      point: new V(bot.position.x, bot.position.y + 1.2, bot.position.z),
      normal: new V(0, 0, 1), impactSpeed: 32,
    });
  }
});
await waitSim(0.5);
const counters = await page.evaluate(() => ({
  shown: Number(document.querySelector('[data-given]').textContent),
  actual: window.__paintball.characters.playerCharacter.hitsGiven,
}));
check('the counter reflects the character, not a private tally',
      counters.shown === counters.actual && counters.shown >= 3,
      `shown ${counters.shown}, actual ${counters.actual}`);

// --- Lens splash on being tagged -------------------------------------------
await page.evaluate(() => {
  const { game, state, characters } = window.__paintball;
  const V = state.position.constructor;
  characters.playerCharacter.tickGameplay(5);
  const p = state.position;
  game.events.emit('hit:character', {
    targetId: 'player', shooterId: 'bot-a', color: 0x00d4e8,
    point: new V(p.x, p.y + 1.2, p.z - 0.2), normal: new V(0, 0, -1), impactSpeed: 34,
  });
});
const splashPixels = () => page.evaluate(() => {
  const c = document.querySelector('.splash-overlay');
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 12) opaque++;
  return opaque;
});

const blobsQueued = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
check('being tagged queues lens paint', blobsQueued > 0, `${blobsQueued} blobs`);

// And it must actually reach the canvas. Allow several frames: under software
// rendering a single frame can take 200ms, so a short wait proves nothing.
await page.waitForTimeout(1200);
const afterHit = await splashPixels();
check('the splash renders to the canvas', afterHit > 0, `${afterHit} painted pixels`);

// It must also drip away rather than staying forever. Bots keep shooting, so
// retreat to a quiet corner first — otherwise fresh splashes keep arriving and
// the measurement never sees an empty lens.
await page.evaluate(() => {
  const { player, state } = window.__paintball;
  player.teleport(new (state.position.constructor)(-58, 3, -58));
});
await waitSim(2.5);
await page.evaluate(() => {
  const { hud, state, game, characters } = window.__paintball;
  hud.lensSplash.clear();
  characters.playerCharacter.tickGameplay(5);
  const p = state.position;
  const V = p.constructor;
  game.events.emit('hit:character', {
    targetId: 'player', shooterId: 'bot-a', color: 0x00d4e8,
    point: new V(p.x, p.y + 1.2, p.z - 0.2), normal: new V(0, 0, -1), impactSpeed: 34,
  });
});
await page.waitForTimeout(200);
const blobsAfterHit = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
await page.waitForTimeout(5000);
const blobsAfterDrip = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
check('lens paint drips away', blobsAfterHit > 0 && blobsAfterDrip < blobsAfterHit,
      `${blobsAfterHit} blobs -> ${blobsAfterDrip}`);

// --- Toast -----------------------------------------------------------------
const toastVisible = await page.evaluate(() => {
  const { game, state } = window.__paintball;
  const V = state.position.constructor;
  game.events.emit('hit:character', {
    targetId: 'bot-b', shooterId: 'player', color: 0xa8e337,
    point: new V(0, 1, 0), normal: new V(0, 0, 1), impactSpeed: 30,
  });
  return new Promise((r) => setTimeout(() =>
    r(document.querySelector('[data-toast]').classList.contains('is-visible')), 120));
});
check('landing a hit shows a toast', toastVisible === true);

// --- Scoreboard ------------------------------------------------------------
await page.keyboard.down('Tab');
await page.waitForTimeout(350);
const board = await page.evaluate(() => ({
  visible: document.querySelector('[data-scoreboard]').classList.contains('is-visible'),
  rows: document.querySelectorAll('.hud__score-row').length,
  characters: window.__paintball.characters.allCharacters.length,
  sortedDescending: [...document.querySelectorAll('.hud__score-given')]
    .map((e) => Number(e.textContent))
    .every((v, i, a) => i === 0 || a[i - 1] >= v),
}));
await page.keyboard.up('Tab');
await page.waitForTimeout(250);
const boardClosed = await page.evaluate(() =>
  document.querySelector('[data-scoreboard]').classList.contains('is-visible'));

check('Tab opens the scoreboard', board.visible === true);
check('the scoreboard lists every character', board.rows === board.characters,
      `${board.rows} rows for ${board.characters} characters`);
check('the scoreboard is ranked', board.sortedDescending === true);
check('releasing Tab closes it', boardClosed === false);

// --- Pointer lock survived it all ------------------------------------------
const stillLocked = await page.evaluate(() => window.__paintball.game.input.isLocked);
check('pointer lock survives Tab', stillLocked === true,
      'Tab would otherwise move focus and silently kill input');

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
