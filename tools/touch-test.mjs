/**
 * Headless touch-control tests.
 *
 * The phone build is the one control scheme that cannot be checked by playing
 * it — nobody has a phone plugged into CI — so everything the thumbs do is
 * driven here through real touch events (CDP's `Input.dispatchTouchEvent`,
 * which Chrome turns into the same pointer events a finger produces) against a
 * landscape phone viewport.
 *
 * What it is actually guarding: that touch feeds the same `Input` the keyboard
 * does, that a tap in the look area never fires the marker, and that portrait
 * holds the round rather than letting it run behind a card.
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
const PORTRAIT = { width: 390, height: 844 };

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
    gateVisible: Boolean(document.querySelector('.rotate-gate.is-visible')),
    pauseVisible: Boolean(document.querySelector('.pause.is-visible')),
  };
});

// --- The controls exist, and are not yet in the player's hands ---------------

const atBoot = await state();
check('touch layer is built on a touch device', Boolean(await page.$('.touch')));
check('controls start hidden', !atBoot.live && atBoot.startVisible,
      `live=${atBoot.live} start=${atBoot.startVisible}`);
check('no rotate gate in landscape', !atBoot.gateVisible);

// --- Tap to play -------------------------------------------------------------

await tap(LANDSCAPE.width / 2, LANDSCAPE.height / 2);
const engaged = await state();
check('a tap takes the controls', engaged.engaged && engaged.live && !engaged.startVisible,
      `engaged=${engaged.engaged} live=${engaged.live}`);

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

// On the card, but not on its repo link — which is the one thing here that
// deliberately does not resume.
const cardTitle = await centerOf('.pause__title');
await tap(cardTitle.x, cardTitle.y, 7);
const resumed = await state();
check('tapping the pause card resumes', resumed.phase === 'playing' && resumed.engaged,
      `phase=${resumed.phase}`);

// --- Horizontal only ---------------------------------------------------------

await page.setViewportSize(PORTRAIT);
// Waiting on the gate rather than on a timeout: a headless frame here can take
// the better part of a second, and every fixed wait chosen to survive that
// would be a wait the suite spends on every run.
await page
  .waitForFunction(() => Boolean(document.querySelector('.rotate-gate.is-visible')), { timeout: 5000 })
  .catch(() => {});
const portrait = await state();
check('portrait raises the rotate gate', portrait.gateVisible);
check('portrait holds the round', portrait.phase === 'paused' && !portrait.engaged,
      `phase=${portrait.phase}`);

await page.setViewportSize(LANDSCAPE);
await page
  .waitForFunction(() => !document.querySelector('.rotate-gate.is-visible'), { timeout: 5000 })
  .catch(() => {});
const backToLandscape = await state();
check('turning back clears the gate', !backToLandscape.gateVisible);

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

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
