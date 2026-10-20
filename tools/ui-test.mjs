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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
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
// Everything an ordinary visit asks for: p3p2's small entry loads with the
// page, and the rest of it — and any server — only once a room is opened.
const requests = [];
const sockets = [];
page.on('request', (r) => requests.push(r.url()));
page.on('websocket', (ws) => sockets.push(ws.url()));

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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

// --- Alone, the page asks no server anything --------------------------------
//
// Multiplayer is p3p2's, and a visit that opens no room must cost nothing for
// it: no socket, nothing from any other origin, and of p3p2's own files only
// the entry — its room client, panel and QR code load when a room is opened.
const origin = new URL(url).origin;
const elsewhere = requests.filter((u) => !u.startsWith(origin) && !/^(data|blob):/.test(u));
check('an ordinary visit asks no other server anything',
      elsewhere.length === 0 && sockets.length === 0,
      elsewhere[0] ?? sockets[0] ?? `${requests.length} requests, all to ${origin}`);
const p3p2Files = requests.filter((u) => /\/p3p2[-.]/.test(u)).map((u) => new URL(u).pathname);
check('of p3p2, only its entry loads until a room is opened',
      p3p2Files.length > 0 && !p3p2Files.some((p) => /p3p2-(core|panel|qr|local)-/.test(p)),
      p3p2Files.join(', ') || 'p3p2 never loaded');
const solo = await page.evaluate(() => ({
  seat: window.__paintball.net?.seat,
  room: window.__paintball.net?.room,
  places: window.__paintball.net?.fingerprint().places.map((p) => p.who).join(),
}));
check('alone, the park is the player and six bots', solo.room === null && solo.seat === 0 &&
      solo.places === 'me,bot,bot,bot,bot,bot,bot', JSON.stringify(solo));

// --- The version in the corner, and the way to more games -------------------
const loaderLink = await page.evaluate(async (u) => {
  // The loader is gone by now; the page as served still has it.
  const doc = new DOMParser().parseFromString(await (await fetch(u)).text(), 'text/html');
  const a = doc.querySelector('#loader a.maize-link');
  return a && { href: a.getAttribute('href'), target: a.getAttribute('target'), text: a.textContent.trim() };
}, url);
check('the loading card links to more games on Maize.Live',
      loaderLink?.href === 'https://maize.live' && loaderLink.target === '_blank' &&
      /more games on maize\.live/i.test(loaderLink.text),
      JSON.stringify(loaderLink));

const buildTag = await page.evaluate(() => {
  const el = document.querySelector('[data-build-tag]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // The fixed parts of the HUD; the crate marker roams the screen's edge and is
  // left out.
  const overlaps = [...document.querySelectorAll(
    '.hud__counters, .hud__clock, .hud__hint, .hud__viewport-crosshair, .perf-hud',
  )]
    .filter((e) => {
      const h = e.getBoundingClientRect();
      return h.width > 0 && h.height > 0 && r.left < h.right && r.right > h.left &&
        r.top < h.bottom && r.bottom > h.top;
    })
    .map((e) => e.className);
  return {
    text: el.textContent.trim(),
    left: r.left, top: r.top, right: r.right, bottom: r.bottom,
    width: innerWidth, height: innerHeight,
    overlaps,
    events: getComputedStyle(el).pointerEvents,
  };
});
let head = '';
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().slice(0, 4);
} catch { /* no git: the format is still checked */ }
check('the version reads v. and the commit’s first four characters',
      /^v\.[0-9a-f]{4}$/.test(buildTag?.text ?? ''),
      `${buildTag?.text}${head && buildTag?.text !== `v.${head}` ? ` — built from another commit than HEAD (${head}); rebuild` : ''}`);
check('the version sits in the bottom-right corner',
      buildTag && buildTag.left > buildTag.width * 0.8 && buildTag.top > buildTag.height * 0.85 &&
      buildTag.right <= buildTag.width && buildTag.bottom <= buildTag.height,
      buildTag && `${Math.round(buildTag.left)},${Math.round(buildTag.top)} on ${buildTag.width}×${buildTag.height}`);
check('the version covers nothing on the HUD', buildTag?.overlaps.length === 0, buildTag?.overlaps.join(', '));
check('the version takes no clicks', buildTag?.events === 'none', buildTag?.events);

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

// And it must actually reach the canvas, which the HUD repaints as the
// simulation advances.
await waitSim(0.3);
const afterHit = await splashPixels();
check('the splash renders to the canvas', afterHit > 0, `${afterHit} painted pixels`);

// It must also drip away rather than staying forever. Bots keep shooting, so
// retreat to a quiet corner first — otherwise fresh splashes keep arriving and
// the measurement never sees an empty lens.
await page.evaluate(() => {
  const { player, state, characters } = window.__paintball;
  const V = state.position.constructor;
  player.teleport(new V(-58, 3, -58));
  // And the bots to the far corner. The drip below is measured over five
  // simulated seconds, and a bot that finds the player inside that window puts
  // *new* blobs on the lens — the count comes back unchanged and the check
  // fails claiming paint never fades.
  for (const bot of characters.allBots) {
    bot.respawn(new V(bot.position.x + 260, bot.position.y, bot.position.z + 260));
  }
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
await waitSim(0.2);
const blobsAfterHit = await page.evaluate(() => window.__paintball.hud.lensSplash.blobCount);
await waitSim(5);
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
await waitSim(0.35);
const board = await page.evaluate(() => ({
  visible: document.querySelector('[data-scoreboard]').classList.contains('is-visible'),
  rows: document.querySelectorAll('.hud__score-row').length,
  characters: window.__paintball.characters.allCharacters.length,
  sortedDescending: [...document.querySelectorAll('.hud__score-given')]
    .map((e) => Number(e.textContent))
    .every((v, i, a) => i === 0 || a[i - 1] >= v),
}));
await page.keyboard.up('Tab');
await waitSim(0.25);
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

// --- Pause -----------------------------------------------------------------
//
// Esc is not pressed here. Leaving a pointer lock is browser UI rather than a
// page event: headless Chrome ignores a synthetic Escape, and the real one is
// never delivered to the page at all. Both end in the same place — the lock is
// gone — which is what the pause actually keys off, so that is what is done.
const beforePause = await page.evaluate(() => window.__paintball.match.timeLeft);
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(300);
const paused = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  card: document.querySelector('.pause')?.classList.contains('is-visible'),
  clock: document.querySelector('[data-pause-clock]')?.textContent,
  // The card has to take clicks; every other overlay must not.
  events: getComputedStyle(document.querySelector('.pause')).pointerEvents,
  hintHidden: document.querySelector('[data-hint]').classList.contains('is-hidden'),
}));
check('losing the pointer mid-round raises the pause card',
      paused.phase === 'paused' && paused.card === true,
      `phase=${paused.phase} card=${paused.card}`);
check('the pause card takes clicks', paused.events === 'auto', paused.events);
check('the pause card shows the clock it stopped', /^\d:\d\d$/.test(paused.clock ?? ''),
      paused.clock);
check('the HUD hint stays down behind the card', paused.hintHidden === true);

// The whole point: a pause has to actually stop the round.
await waitSim(5);
const heldFor = await page.evaluate(() => window.__paintball.match.timeLeft);
check('the clock does not run while paused', heldFor === beforePause,
      `${beforePause.toFixed(2)}s -> ${heldFor.toFixed(2)}s over 5 simulated seconds`);

// The repo link is the one thing on the card that must not resume — grabbing
// the pointer as a new tab opens would be a small hostage situation.
// A pointerdown, because that is what the card listens for — see the note on
// PauseOverlay.onPointerDown. A synthetic click would sail past the guard
// without ever touching it.
await page.evaluate(() => {
  const link = document.querySelector('.pause .fork-badge');
  link.removeAttribute('href');
  link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
});
await page.waitForTimeout(150);
check('the repo link does not resume the round',
      (await page.evaluate(() => window.__paintball.match.phase)) === 'paused');

// The other ways off the card: more games, and friends. FRIENDS itself is not
// pressed here — it opens p3p2's panel, which is net-test's to try.
const card = await page.evaluate(() => {
  const link = (a) => a && { href: a.getAttribute('href'), target: a.getAttribute('target') };
  const group = document.querySelector('[data-pause-friends-group]');
  return {
    maize: link(document.querySelector('.pause .maize-link')),
    friends: Boolean(group && !group.hidden && getComputedStyle(group).display !== 'none'),
    p3p2: link(document.querySelector('.pause__p3p2 a')),
    subtitle: document.querySelector('.pause__subtitle')?.textContent,
  };
});
check('the pause card links to more games on Maize.Live',
      card.maize?.href === 'https://maize.live' && card.maize.target === '_blank', JSON.stringify(card.maize));
check('FRIENDS is on the park’s pause card', card.friends === true);
check('the pause card says where a room comes from: p3p2.me',
      card.p3p2?.href === 'https://p3p2.me' && card.p3p2.target === '_blank', JSON.stringify(card.p3p2));
check('alone, the pause card says the paint will wait', card.subtitle === 'The paint will wait.', card.subtitle);
await page.evaluate(() => {
  for (const a of document.querySelectorAll('.pause .maize-link, .pause__p3p2 a')) {
    a.removeAttribute('href');
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  }
});
await page.waitForTimeout(150);
check('the Maize.Live and p3p2.me links do not resume the round',
      (await page.evaluate(() => window.__paintball.match.phase)) === 'paused');

// Clear of the second or so in which a browser refuses a lock after Esc.
await page.waitForTimeout(1600);
await page.click('[data-pause-resume]');
await page.waitForTimeout(500);
const resumed = await page.evaluate(() => ({
  phase: window.__paintball.match.phase,
  locked: window.__paintball.game.input.isLocked,
  card: document.querySelector('.pause').classList.contains('is-visible'),
}));
check('clicking the card gives the pointer back and restarts the clock',
      resumed.phase === 'playing' && resumed.locked === true && resumed.card === false,
      `phase=${resumed.phase} locked=${resumed.locked} card=${resumed.card}`);
await waitSim(2);
const afterResume = await page.evaluate(() => window.__paintball.match.timeLeft);
check('the round runs again once resumed', afterResume < heldFor,
      `${heldFor.toFixed(2)}s -> ${afterResume.toFixed(2)}s`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

// --- The test course is a fixture, with no room and no FRIENDS -------------
//
// Its match is a sandbox that never pauses, so there is no card to look on;
// what matters is that no room can be opened there at all.
const course = await browser.newPage({ viewport: { width: 1024, height: 576 } });
await course.goto(new URL('?scene=course', url).href, { waitUntil: 'load' });
await course.waitForFunction(
  () => window.__paintball?.bootTimings().some((t) => t.phase === 'TOTAL'), null, { timeout: 60_000 });
const onCourse = await course.evaluate(() => ({
  net: window.__paintball.net,
  friends: document.querySelectorAll('[data-pause-friends-group]:not([hidden])').length,
}));
check('the test course has no room, and shows no FRIENDS',
      onCourse.net === null && onCourse.friends === 0, JSON.stringify(onCourse));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
