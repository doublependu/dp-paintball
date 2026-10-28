/**
 * Headless touch-control tests.
 *
 * The phone build is the one control scheme that cannot be checked by playing
 * it — nobody has a phone plugged into CI — so everything the thumbs do is
 * driven here through real touch events (CDP's `Input.dispatchTouchEvent`,
 * which Chrome turns into the same pointer events a finger produces) against a
 * phone viewport, held sideways and then upright.
 *
 * What it is actually guarding: that touch feeds the same `Input` the keyboard
 * does, that a tap in the look area never fires the marker, that the game plays
 * either way up, and that turning the phone mid-round holds the round rather
 * than letting it run under a layout that just moved beneath the thumbs.
 *
 * Usage: node tools/touch-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

/** A phone held sideways. Roughly an iPhone 14 in landscape. */
const LANDSCAPE = { width: 844, height: 390 };
/** The same phone upright. */
const PORTRAIT = { width: 390, height: 844 };
/**
 * Two more upright screens the cards have to fit: an entry-level Android
 * (20:9, the narrowest common shape) and an iPhone SE (16:9, the shortest).
 */
const PORTRAIT_SIZES = [PORTRAIT, { width: 360, height: 800 }, { width: 375, height: 667 }];
/**
 * How far apart two posters of the wall may be, as a mean per channel out of
 * 255, shrunk to 32×18. Set from the two runs in `NEXT_11.md`.
 */
const POSTER_TOLERANCE = 12;

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});

const context = await browser.newContext({
  viewport: LANDSCAPE,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

// `?touch=1` forces the touch build. The emulated context reports a coarse
// pointer anyway, but pinning it means a failure here is never "the emulation
// stopped claiming to be a phone".
await page.goto(`${url}?touch=1`, { waitUntil: 'load' });

await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
await page.evaluate(() => window.__paintball.setManualSim(true));
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 60_000 });

const cdp = await context.newCDPSession(page);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Advances the simulation directly — see the note in ui-test.mjs. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

/**
 * Every finger currently on the glass.
 *
 * CDP wants the full set of active points on every event, not just the one
 * that moved, so tracking them here is what makes two thumbs possible — and
 * two thumbs at once is the whole point of the layout.
 */
const points = new Map();

async function dispatch(type) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: [...points.values()],
    modifiers: 0,
  });
}

async function touchDown(id, x, y) {
  points.set(id, { x, y, id });
  await dispatch('touchStart');
}

async function touchMove(id, x, y) {
  points.set(id, { x, y, id });
  await dispatch('touchMove');
}

async function touchUp(id) {
  const point = points.get(id);
  points.delete(id);
  // touchEnd carries the points that *left*, and the ones still down stay in
  // the list — hence the temporary re-add rather than sending an empty set.
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: point ? [point] : [],
    modifiers: 0,
  });
}

async function tap(x, y, id = 90) {
  await touchDown(id, x, y);
  await touchUp(id);
}

/** The centre of a control, in CSS pixels. */
async function centerOf(selector) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`touch-test: ${selector} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const state = () => page.evaluate(() => {
  const pb = window.__paintball;
  return {
    engaged: pb.game.input.isLocked,
    phase: pb.match.phase,
    ammo: pb.match.ammo.get('player'),
    yaw: pb.state.yaw,
    aiming: pb.state.aiming,
    grounded: pb.state.grounded,
    y: pb.state.position.y,
    sprinting: pb.state.sprinting,
    speed: pb.state.horizontalSpeed,
    position: { x: pb.state.position.x, y: pb.state.position.y, z: pb.state.position.z },
    live: Boolean(document.querySelector('.touch.is-live')),
    startVisible: Boolean(document.querySelector('.touch-start.is-visible')),
    pauseVisible: Boolean(document.querySelector('.pause.is-visible')),
  };
});

/**
 * The camera's view in degrees: `fov` is three's vertical angle, and `across`
 * is the horizontal one that follows from it at the canvas's aspect.
 */
const view = (target = page) => target.evaluate(() => {
  const camera = window.__paintball.game.render.camera;
  const half = (camera.fov * Math.PI) / 360;
  return {
    fov: camera.fov,
    across: (2 * Math.atan(Math.tan(half) * camera.aspect) * 180) / Math.PI,
  };
});

/**
 * Every touch control that is showing, plus the HUD's counters and clock,
 * against each other and against the edges of the screen. A button's 4px drop
 * shadow counts as the button.
 */
const layoutClashes = () => page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.touch__btn, .hud__counters, .hud__clock')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => {
      const r = el.getBoundingClientRect();
      const shadow = el.classList.contains('touch__btn') ? 4 : 0;
      const classes = el.className.split(' ');
      return {
        name: classes.find((c) => c.includes('--')) ?? classes[0],
        left: r.left, right: r.right, top: r.top, bottom: r.bottom + shadow,
      };
    });
  const clashes = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.left < 0 || a.top < 0 || a.right > innerWidth || a.bottom > innerHeight) {
      clashes.push(`${a.name} off screen`);
    }
    for (const b of boxes.slice(i + 1)) {
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        clashes.push(`${a.name} on ${b.name}`);
      }
    }
  }
  return { clashes, count: boxes.length };
});

/** Whether the left trigger is on screen at all. */
const leftTriggerShown = () => page.evaluate(() =>
  getComputedStyle(document.querySelector('.touch__btn--fire-left')).display !== 'none');

/**
 * The end-of-round poster shrunk to 32×18, as RGB. Small enough that two
 * posters of the same wall compare on composition rather than on a branch that
 * swayed between them.
 */
const posterThumb = () => page.evaluate(async () => {
  const poster = window.__paintball.poster;
  if (!poster.hasPoster) return null;
  const image = new Image();
  image.src = poster.toDataURL();
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, 32, 18);
  return [...context.getImageData(0, 0, 32, 18).data].filter((_, i) => i % 4 !== 3);
});

/**
 * Every bot off to the far corner, as ui-test does. The poster is a picture of
 * the painting wall, and two of them only compare if nobody wandered into one.
 */
const sendBotsAway = () => page.evaluate(() => {
  for (const bot of window.__paintball.characters.allBots) {
    const V = bot.position.constructor;
    bot.respawn(new V(bot.position.x + 260, bot.position.y, bot.position.z + 260));
  }
});

/** The pause card, measured: FRIENDS and the links at its foot are what scrolling hides. */
const pauseFit = () => page.evaluate(() => {
  const card = document.querySelector('.pause__card');
  const links = document.querySelector('.pause__links').getBoundingClientRect();
  return { overflow: card.scrollHeight - card.clientHeight, linksBottom: links.bottom, height: innerHeight };
});

/**
 * The results card, measured: whether it is on screen without scrolling, whether
 * anything on it runs past its sides, and whether Play again is clear of every
 * touch button — the fire thumb's next tap lands where those are.
 */
const resultsFit = () => page.evaluate(() => {
  const card = document.querySelector('.results__card');
  const box = card.getBoundingClientRect();
  const parts = card.querySelectorAll(
    '.results__header > *, .results__head > span, .results__row > span, .results__share > *');
  const outside = [...parts]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
    })
    .map((el) => el.textContent.trim().slice(0, 16) || el.className);
  const again = document.querySelector('[data-results-again]').getBoundingClientRect();
  const hits = [...document.querySelectorAll('.touch__btn')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && again.left < r.right && again.right > r.left &&
        again.top < r.bottom + 4 && again.bottom > r.top;
    })
    .map((b) => b.className);
  return {
    top: box.top,
    bottom: box.bottom,
    height: innerHeight,
    scroll: card.scrollHeight - card.clientHeight,
    wide: card.scrollWidth - card.clientWidth,
    outside,
    hits,
  };
});

/** Resizes the page and waits until the layout has caught up. */
async function resize(size) {
  await page.setViewportSize(size);
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height,
                             size, { timeout: 5000 });
}

// --- The controls exist, and are not yet in the player's hands ---------------

const atBoot = await state();
check('touch layer is built on a touch device', Boolean(await page.$('.touch')));
check('controls start hidden', !atBoot.live && atBoot.startVisible,
      `live=${atBoot.live} start=${atBoot.startVisible}`);

// --- Tap to play -------------------------------------------------------------

await tap(LANDSCAPE.width / 2, LANDSCAPE.height / 2);
const engaged = await state();
check('a tap takes the controls', engaged.engaged && engaged.live && !engaged.startVisible,
      `engaged=${engaged.engaged} live=${engaged.live}`);

// Sideways is the shape the game was made for, and nothing about it changes.
const sidewaysView = await view();
check('sideways, the camera keeps its 62°', Math.abs(sidewaysView.fov - 62) < 0.05,
      `${sidewaysView.fov.toFixed(2)}° tall, ${sidewaysView.across.toFixed(1)}° across`);
const sidewaysLayout = await layoutClashes();
check('sideways, no control sits on another or on the HUD, and all are on screen',
      sidewaysLayout.clashes.length === 0,
      sidewaysLayout.clashes.join(', ') || `${sidewaysLayout.count} clear`);

// --- The version, in the one gap a phone has --------------------------------
//
// Every corner is a button here, so the build sits in the gutter under the
// right trigger. It must clear every button, shadow included, or it reads as
// a label on one of them.
const tagClear = await page.evaluate(() => {
  const tag = document.querySelector('[data-build-tag]')?.getBoundingClientRect();
  if (!tag) return { missing: true };
  const hits = [...document.querySelectorAll('.touch__btn')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      // The buttons' 4px drop shadow counts as the button.
      return r.width > 0 && tag.left < r.right && tag.right > r.left &&
        tag.top < r.bottom + 4 && tag.bottom > r.top;
    })
    .map((b) => b.className);
  return { hits, right: innerWidth - tag.right, bottom: innerHeight - tag.bottom };
});
check('the version clears every touch button', !tagClear.missing && tagClear.hits.length === 0,
      tagClear.missing ? 'no label' : tagClear.hits.join(', ') ||
        `${tagClear.right.toFixed(0)}px from the right, ${tagClear.bottom.toFixed(0)}px from the bottom`);

// --- The stick ---------------------------------------------------------------

const before = await state();
// Land in the left zone and push forward. The stick plants where it lands, so
// the origin is wherever the thumb touched down.
await touchDown(1, 160, 250);
await touchMove(1, 160, 190);
await waitSim(1.0);
const walked = await state();
const moved = Math.hypot(walked.position.x - before.position.x, walked.position.z - before.position.z);
check('the stick walks the player', moved > 1.2, `${moved.toFixed(2)}m in 1s`);

// Past 85% of travel the same gesture asks for a sprint — there is no button.
await touchMove(1, 160, 140);
await waitSim(0.5);
const sprinting = await state();
check('pushing the stick to its edge sprints', sprinting.sprinting,
      `speed=${sprinting.speed.toFixed(2)}`);

await touchUp(1);
await waitSim(0.6);
const stopped = await state();
check('lifting the thumb stops the player', stopped.speed < 0.6 && !stopped.sprinting,
      `speed=${stopped.speed.toFixed(2)}`);

// --- Looking -----------------------------------------------------------------

const beforeYaw = (await state()).yaw;
// A drag of 160px, in two steps with a frame between them. The pause is not
// politeness: the browser coalesces pointer moves onto animation frames, and
// these headless frames are software-rasterised and slow, so two dispatches in
// the same frame arrive as one.
await touchDown(2, 640, 200);
await touchMove(2, 560, 200);
await page.waitForTimeout(60);
await touchMove(2, 480, 200);
await page.waitForTimeout(60);
await touchUp(2);
// The camera drains the accumulated delta on its own update, so the gesture has
// to be finished before the simulation is stepped.
await waitSim(0.1);
const turned = await state();
const yawDelta = turned.yaw - beforeYaw;
// Dragging left turns left, which is a *positive* yaw here — the camera
// subtracts the delta. 160px at the configured scale is a little over a right
// angle, so anything in that neighbourhood is right.
check('dragging the right side turns the camera', yawDelta > 0.9 && yawDelta < 3.0,
      `${yawDelta.toFixed(2)} rad`);

// --- A tap in the look zone must not cost paint ------------------------------

const beforeTapAmmo = (await state()).ammo;
await tap(640, 240, 3);
await waitSim(0.4);
const afterTapAmmo = (await state()).ammo;
check('a tap in the look zone does not fire', afterTapAmmo === beforeTapAmmo,
      `${beforeTapAmmo} -> ${afterTapAmmo}`);

// --- Fire --------------------------------------------------------------------

const fire = await centerOf('.touch__btn--fire');
await touchDown(4, fire.x, fire.y);
await waitSim(0.5);
await touchUp(4);
const fired = await state();
check('the fire button spends paint', fired.ammo < beforeTapAmmo,
      `${beforeTapAmmo} -> ${fired.ammo}`);

// Held fire keeps firing, and releasing stops it.
const afterRelease = fired.ammo;
await waitSim(0.5);
const idle = await state();
check('releasing the trigger stops the marker', idle.ammo === afterRelease,
      `${afterRelease} -> ${idle.ammo}`);

// --- Two triggers, one action ------------------------------------------------

// The left button exists so the right thumb can keep aiming while the game is
// firing, which only works if letting go of one trigger does not release the
// other.
const fireRight = await centerOf('.touch__btn--fire');
const fireLeft = await centerOf('.touch__btn--fire-left');
await touchDown(10, fireRight.x, fireRight.y);
await touchDown(11, fireLeft.x, fireLeft.y);
await waitSim(0.4);
const bothHeld = await state();
check('the left trigger fires too', bothHeld.ammo < idle.ammo,
      `${idle.ammo} -> ${bothHeld.ammo}`);

await touchUp(10);
await waitSim(0.4);
const oneHeld = await state();
check('releasing one trigger leaves the other firing', oneHeld.ammo < bothHeld.ammo,
      `${bothHeld.ammo} -> ${oneHeld.ammo}`);

await touchUp(11);
await waitSim(0.4);
const noneHeld = await state();
check('releasing both stops the marker', noneHeld.ammo === oneHeld.ammo,
      `${oneHeld.ammo} -> ${noneHeld.ammo}`);

// --- Aim is a toggle ---------------------------------------------------------

const aim = await centerOf('.touch__btn--aim');
await tap(aim.x, aim.y, 5);
await waitSim(0.2);
const aimed = await state();
await tap(aim.x, aim.y, 5);
await waitSim(0.2);
const unaimed = await state();
check('aim toggles on and off', aimed.aiming && !unaimed.aiming,
      `on=${aimed.aiming} off=${unaimed.aiming}`);

// --- Jump --------------------------------------------------------------------

const jump = await centerOf('.touch__btn--jump');
await touchDown(12, jump.x, jump.y);
// Held across the step rather than tapped: a press is edge-triggered, and the
// step that reads it has to happen while the thumb is still down.
await waitSim(0.25);
const jumping = await state();
await touchUp(12);
check('the jump button leaves the ground', !jumping.grounded || jumping.y > 0.3,
      `grounded=${jumping.grounded} y=${jumping.y.toFixed(2)}`);
await waitSim(1.2);

// --- And the buttons playtesting removed are gone ----------------------------

const removed = await page.evaluate(() =>
  ['crouch', 'wave', 'scores'].filter((name) =>
    document.querySelector(`.touch__btn--${name}`)));
check('crouch, wave and scores are not on the phone', removed.length === 0,
      removed.join(', '));

// --- Pause and resume --------------------------------------------------------

const pauseButton = await centerOf('.touch__btn--pause');
await tap(pauseButton.x, pauseButton.y, 6);
const paused = await state();
check('the pause button holds the round', paused.phase === 'paused' && paused.pauseVisible,
      `phase=${paused.phase}`);

// Everything on the card in one look: FRIENDS and the two links are at the
// bottom, and a card that scrolls hides exactly those.
const cardFit = await pauseFit();
check('the pause card fits a landscape phone without scrolling',
      cardFit.overflow <= 1 && cardFit.linksBottom <= cardFit.height,
      `${cardFit.overflow}px over, links end at ${Math.round(cardFit.linksBottom)} of ${cardFit.height}`);

// On the card, but not on its repo link — which is the one thing here that
// deliberately does not resume.
const cardTitle = await centerOf('.pause__title');
await tap(cardTitle.x, cardTitle.y, 7);
const resumed = await state();
check('tapping the pause card resumes', resumed.phase === 'playing' && resumed.engaged,
      `phase=${resumed.phase}`);

// --- The end of a round --------------------------------------------------------
//
// The results card covers most of a landscape screen, the fire button included.
// The start prompt used to come up under it, so the fire thumb's next tap after
// the whistle started the next round before anyone had read the card.
await tap(LANDSCAPE.width / 2, LANDSCAPE.height / 2, 20);
const fireSpot = await centerOf('[data-button="fire"]');
await tap(fireSpot.x, fireSpot.y, 21);
await sendBotsAway();
await page.evaluate(() => {
  window.__paintball.match.timeLeft = 0.05;
  window.__paintball.stepSim(0.2);
});
const resultsCard = () => page.evaluate(() => ({
  card: document.querySelector('.results').classList.contains('is-visible'),
  again: document.querySelector('[data-results-again]')?.disabled ?? null,
}));
const atWhistle = { ...(await state()), ...(await resultsCard()) };
check('the whistle puts the card up and leaves the start prompt down',
      atWhistle.phase === 'ended' && atWhistle.card && !atWhistle.startVisible && !atWhistle.live,
      `phase=${atWhistle.phase} card=${atWhistle.card} start=${atWhistle.startVisible}`);
// Kept to compare the upright one against, below.
const sidewaysPoster = await posterThumb();
// The share row is appended once the poster is encoded, and the card grows by
// it — which moves Play again. Everything below measures the finished card.
await page.waitForSelector('[data-share-action="save"]', { timeout: 15_000 }).catch(() => {});

for (let i = 0; i < 3; i++) await tap(fireSpot.x, fireSpot.y, 22 + i);
const afterFireTaps = { ...(await state()), ...(await resultsCard()) };
check('the fire thumb tapping on after the whistle starts nothing',
      afterFireTaps.phase === 'ended' && afterFireTaps.card && !afterFireTaps.engaged,
      `phase=${afterFireTaps.phase} engaged=${afterFireTaps.engaged}`);

// Clear of every touch button, shadow included, and on the screen.
const againFit = await page.evaluate(() => {
  const again = document.querySelector('[data-results-again]')?.getBoundingClientRect();
  if (!again) return { missing: true };
  const hits = [...document.querySelectorAll('.touch__btn')]
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && again.left < r.right && again.right > r.left &&
        again.top < r.bottom + 4 && again.bottom > r.top;
    })
    .map((b) => b.className);
  const card = document.querySelector('.results__card').getBoundingClientRect();
  return { hits, cardTop: card.top, cardBottom: card.bottom, height: innerHeight };
});
check('Play again clears every touch button', !againFit.missing && againFit.hits.length === 0,
      againFit.missing ? 'no button' : againFit.hits.join(', ') || 'clear');
check('the results card fits a landscape phone',
      !againFit.missing && againFit.cardTop >= 0 && againFit.cardBottom <= againFit.height,
      `card ${Math.round(againFit.cardTop)}–${Math.round(againFit.cardBottom)} of ${againFit.height}`);

const againSpot = await centerOf('[data-results-again]');
await tap(againSpot.x, againSpot.y, 25);
const tooSoon = await state();
check('Play again does nothing before it arms', tooSoon.phase === 'ended' && !tooSoon.engaged,
      `phase=${tooSoon.phase} armed=${(await resultsCard()).again === false}`);

// Arming counts frame time, which here only `stepSim` hands out.
await page.evaluate(() => window.__paintball.stepSim(2.1));
await tap(againSpot.x, againSpot.y, 26);
const again = { ...(await state()), ...(await resultsCard()) };
check('once armed, Play again starts the round and hands the controls back',
      again.phase === 'playing' && again.engaged && again.live && !again.card,
      `phase=${again.phase} engaged=${again.engaged} live=${again.live} card=${again.card}`);

// In a room the next round can start from a friend's Play again, while this
// player is still on the card: the start prompt has to come back for them.
await page.evaluate(() => {
  window.__paintball.match.timeLeft = 0.05;
  window.__paintball.stepSim(0.2);
});
await page.evaluate(() => window.__paintball.matchSystem.restart());
const fromElsewhere = await state();
check('a round started from elsewhere brings the start prompt back',
      fromElsewhere.phase === 'playing' && fromElsewhere.startVisible && !fromElsewhere.engaged,
      `phase=${fromElsewhere.phase} start=${fromElsewhere.startVisible}`);

// --- Upright -------------------------------------------------------------------
//
// The same phone, turned to portrait. This used to be a gate asking for it to be
// turned back, which on a phone with its rotation locked was the whole game.

await sendBotsAway();
await resize(PORTRAIT);
const upright = await state();
check('upright, the start prompt is up and nothing asks for a turn',
      upright.startVisible && !(await page.$('.rotate-gate')),
      `start=${upright.startVisible} gate=${Boolean(await page.$('.rotate-gate'))}`);

await tap(PORTRAIT.width / 2, PORTRAIT.height / 2, 30);
const uprightEngaged = await state();
check('upright, a tap takes the controls', uprightEngaged.engaged && uprightEngaged.live,
      `engaged=${uprightEngaged.engaged} live=${uprightEngaged.live}`);

// Settled first: the camera eases to a new width rather than snapping.
await waitSim(1.0);
const uprightView = await view();
check('upright, the camera still sees 48° across',
      uprightView.across >= 48 && uprightView.fov <= 90.5,
      `${uprightView.fov.toFixed(1)}° tall, ${uprightView.across.toFixed(1)}° across`);

const uprightAim = await centerOf('.touch__btn--aim');
await tap(uprightAim.x, uprightAim.y, 31);
await waitSim(1.0);
const aimedView = await view();
await tap(uprightAim.x, uprightAim.y, 31);
await waitSim(1.0);
check('upright, aim still narrows the view', aimedView.fov < uprightView.fov - 5,
      `${uprightView.fov.toFixed(1)}° -> ${aimedView.fov.toFixed(1)}°`);

const uprightLayout = await layoutClashes();
check('upright, no control sits on another or on the HUD, and all are on screen',
      uprightLayout.clashes.length === 0,
      uprightLayout.clashes.join(', ') || `${uprightLayout.count} clear`);
check('upright, the left trigger is put away', !(await leftTriggerShown()));

// The stick, low on the left where the thumb rests.
const uprightBefore = await state();
await touchDown(32, 100, 680);
await touchMove(32, 100, 620);
await waitSim(1.0);
await touchUp(32);
const uprightWalked = await state();
const uprightMoved = Math.hypot(uprightWalked.position.x - uprightBefore.position.x,
                                uprightWalked.position.z - uprightBefore.position.z);
check('upright, the stick walks the player', uprightMoved > 1.2,
      `${uprightMoved.toFixed(2)}m in 1s`);

// Looking, from the top half — including its left side, which is not the stick's.
await waitSim(0.6);
const uprightYaw = (await state()).yaw;
await touchDown(33, 300, 300);
await touchMove(33, 220, 300);
await page.waitForTimeout(60);
await touchMove(33, 140, 300);
await page.waitForTimeout(60);
await touchUp(33);
await waitSim(0.1);
const uprightTurn = (await state()).yaw - uprightYaw;
check('upright, dragging the top half turns the camera', uprightTurn > 0.9 && uprightTurn < 3.0,
      `${uprightTurn.toFixed(2)} rad`);

// Fire is also a look pad upright: the one thumb on the right both fires and
// aims, which is what the left trigger is for when the phone is sideways.
const uprightFire = await centerOf('.touch__btn--fire');
const beforeFire = await state();
await touchDown(34, uprightFire.x, uprightFire.y);
await waitSim(0.4);
const holdingFire = await state();
await touchMove(34, uprightFire.x - 80, uprightFire.y);
await page.waitForTimeout(60);
await touchMove(34, uprightFire.x - 160, uprightFire.y);
await page.waitForTimeout(60);
await waitSim(0.4);
const draggingFire = await state();
// The turn is read once the thumb is up, as the look-zone drag's is: a headless
// frame is slower than the 60ms above, so the last move can still be waiting
// to be coalesced, and the release is what delivers it.
await touchUp(34);
await waitSim(0.1);
const releasedFire = await state();
check('upright, holding fire spends paint', holdingFire.ammo < beforeFire.ammo,
      `${beforeFire.ammo} -> ${holdingFire.ammo}`);
const fireTurn = releasedFire.yaw - holdingFire.yaw;
check('upright, dragging from fire turns the camera and keeps firing',
      fireTurn > 0.9 && fireTurn < 3.0 && draggingFire.ammo < holdingFire.ammo,
      `${fireTurn.toFixed(2)} rad, ${holdingFire.ammo} -> ${draggingFire.ammo}`);

// A thumb pressing a button rocks on it. That must not move the aim.
await waitSim(0.3);
const beforeRock = await state();
await touchDown(35, uprightFire.x, uprightFire.y);
await touchMove(35, uprightFire.x + 3, uprightFire.y);
await page.waitForTimeout(60);
await touchMove(35, uprightFire.x, uprightFire.y + 3);
await page.waitForTimeout(60);
await touchMove(35, uprightFire.x - 2, uprightFire.y - 2);
await page.waitForTimeout(60);
await touchUp(35);
await waitSim(0.1);
const afterRock = await state();
check('upright, a thumb rocking on fire does not turn the camera',
      afterRock.yaw === beforeRock.yaw, `${(afterRock.yaw - beforeRock.yaw).toFixed(4)} rad`);

// The pause card, at every upright size, and its legend for this grip.
const uprightPause = await centerOf('.touch__btn--pause');
await tap(uprightPause.x, uprightPause.y, 36);
const uprightLegend = await page.evaluate(() =>
  [...document.querySelectorAll('.pause__key')]
    .filter((key) => getComputedStyle(key).display !== 'none')
    .map((key) => key.textContent.trim()));
check('upright, the pause card describes the upright grip',
      uprightLegend.some((key) => key.includes('drag to aim')) &&
        !uprightLegend.some((key) => key.includes('either hand')),
      uprightLegend.join(' | '));
for (const size of PORTRAIT_SIZES) {
  await resize(size);
  const fit = await pauseFit();
  check(`the pause card fits ${size.width}×${size.height} upright without scrolling`,
        fit.overflow <= 1 && fit.linksBottom <= fit.height,
        `${fit.overflow}px over, links end at ${Math.round(fit.linksBottom)} of ${fit.height}`);
}
await resize(PORTRAIT);
const uprightTitle = await centerOf('.pause__title');
await tap(uprightTitle.x, uprightTitle.y, 37);
check('upright, tapping the pause card resumes', (await state()).engaged);

// --- Turning the phone mid-round ---------------------------------------------
//
// A thumb on the stick and one on the trigger, and the phone turns under them.
// The layout moves, so whatever they were holding is no longer there.
await touchDown(38, 100, 680);
await touchMove(38, 100, 620);
const fireUpright = await centerOf('.touch__btn--fire');
await touchDown(39, fireUpright.x, fireUpright.y);
await waitSim(0.2);
await resize(LANDSCAPE);
await page
  .waitForFunction(() => Boolean(document.querySelector('.pause.is-visible')), { timeout: 5000 })
  .catch(() => {});
const turnedSideways = await state();
const heldThrough = await page.evaluate(() => {
  const input = window.__paintball.game.input;
  const move = input.getMoveVector();
  return { fire: input.isDown('fire'), move: Math.hypot(move.x, move.y) };
});
check('turning the phone mid-round holds the round',
      turnedSideways.phase === 'paused' && !turnedSideways.engaged && turnedSideways.pauseVisible,
      `phase=${turnedSideways.phase} engaged=${turnedSideways.engaged}`);
check('and lets go of the stick and the trigger', !heldThrough.fire && heldThrough.move === 0,
      `fire=${heldThrough.fire} move=${heldThrough.move}`);
await touchUp(38);
await touchUp(39);

const sidewaysTitle = await centerOf('.pause__title');
await tap(sidewaysTitle.x, sidewaysTitle.y, 40);
await waitSim(1.0);
const resumedSideways = await state();
const backSideways = await view();
check('resumed sideways: the left trigger is back and the view is 62° again',
      resumedSideways.engaged && (await leftTriggerShown()) && Math.abs(backSideways.fov - 62) < 0.05,
      `engaged=${resumedSideways.engaged} fov=${backSideways.fov.toFixed(2)}`);

await resize(PORTRAIT);
await page
  .waitForFunction(() => Boolean(document.querySelector('.pause.is-visible')), { timeout: 5000 })
  .catch(() => {});
check('turning back upright holds the round again', (await state()).phase === 'paused');
const titleAgain = await centerOf('.pause__title');
await tap(titleAgain.x, titleAgain.y, 41);
await waitSim(1.0);

// --- The end of a round, upright ---------------------------------------------

await sendBotsAway();
await page.evaluate(() => {
  window.__paintball.match.timeLeft = 0.05;
  window.__paintball.stepSim(0.2);
});
// The share row is built once the poster is encoded, which is the one part of
// the card that is not synchronous.
await page.waitForSelector('[data-share-action="save"]', { timeout: 15_000 }).catch(() => {});

// The same wall, framed the same way, whichever way up the phone was. A centre
// crop of a portrait frame used to be a close-up of the board and nothing else.
const uprightPoster = await posterThumb();
const posterDifference = uprightPoster && sidewaysPoster
  ? uprightPoster.reduce((sum, value, i) => sum + Math.abs(value - sidewaysPoster[i]), 0) /
    uprightPoster.length
  : Infinity;
check('upright, the poster is the same picture of the park as sideways',
      posterDifference < POSTER_TOLERANCE,
      `mean difference ${posterDifference.toFixed(1)} of 255`);

for (const size of PORTRAIT_SIZES) {
  await resize(size);
  const fit = await resultsFit();
  check(`the results card fits ${size.width}×${size.height} upright, all of it on the card`,
        fit.top >= 0 && fit.bottom <= fit.height && fit.scroll <= 1 && fit.wide <= 1 &&
          fit.outside.length === 0,
        `card ${Math.round(fit.top)}–${Math.round(fit.bottom)} of ${fit.height}, ` +
          `${fit.scroll}px scroll, ${fit.wide}px wide` +
          (fit.outside.length ? `, off the side: ${fit.outside.join(', ')}` : ''));
  check(`Play again clears every touch button at ${size.width}×${size.height}`,
        fit.hits.length === 0, fit.hits.join(', ') || 'clear');
}

await resize(PORTRAIT);
await page.evaluate(() => window.__paintball.stepSim(2.1));
const uprightAgain = await centerOf('[data-results-again]');
await tap(uprightAgain.x, uprightAgain.y, 42);
const againUpright = await state();
check('upright, Play again starts the next round',
      againUpright.phase === 'playing' && againUpright.engaged && againUpright.live,
      `phase=${againUpright.phase} engaged=${againUpright.engaged}`);

// --- The render budget -------------------------------------------------------

// The emulated phone reports a device pixel ratio of 2 and would render at it
// if nothing capped it. This is the cheap half of the phone performance work —
// the expensive half is a frame time nobody can measure on a software
// rasteriser, and is not asserted here.
const pixelRatio = await page.evaluate(() =>
  window.__paintball.game.render.renderer.getPixelRatio());
check('a phone renders under the touch pixel-ratio cap', pixelRatio <= 1.5,
      `ratio=${pixelRatio}`);

// --- And none of it on a desktop ---------------------------------------------

// The phone's page is done with, and under a software rasteriser it would
// otherwise be painting every frame while the desktop page below boots.
await context.close();

const desktop = await browser.newContext({ viewport: { width: 1024, height: 576 } });
const desktopPage = await desktop.newPage();
await desktopPage.goto(url, { waitUntil: 'load' });
await desktopPage.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
const noTouchLayer = await desktopPage.evaluate(() => ({
  layer: Boolean(document.querySelector('.touch')),
  flagged: document.documentElement.classList.contains('is-touch'),
}));
check('nothing is built on a mouse-driven machine',
      !noTouchLayer.layer && !noTouchLayer.flagged,
      `layer=${noTouchLayer.layer} flag=${noTouchLayer.flagged}`);

// The view's width is a rule about the screen's shape, not about thumbs. Booted
// first, since the handle above exists before the camera does, and stepped by
// hand like everything else here: in a full run this page's own frames were
// too few to see the camera ease out within any wait worth writing down.
await desktopPage.waitForFunction(() => !document.querySelector('#loader'), undefined,
                                  { timeout: 120_000 });
await desktopPage.evaluate(() => window.__paintball.setManualSim(true));
await desktopPage.setViewportSize({ width: 600, height: 1000 });
// The canvas takes its new shape from a ResizeObserver, on the page's next frame.
await desktopPage
  .waitForFunction(() => window.__paintball.game.render.camera.aspect < 1, undefined,
                   { timeout: 30_000 })
  .catch(() => {});
await desktopPage.evaluate(() => window.__paintball.stepSim(1.0));
const tallWindow = await view(desktopPage);
check('a desktop window dragged tall widens its view too', tallWindow.across >= 48,
      `${tallWindow.fov.toFixed(1)}° tall, ${tallWindow.across.toFixed(1)}° across`);

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
