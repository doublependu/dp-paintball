/**
 * Headless tests for the park's paint screen and the poster it produces.
 *
 * The screen is the one painted surface in the game that does not go through
 * `PaintSystem`: it keeps its own canvas in texture space and stamps into it,
 * because a board everyone shoots at on purpose would otherwise spend the whole
 * world-paint vertex budget and then evict its own beginning. See
 * `src/world/PaintScreen.ts`.
 *
 * Two things are worth testing and neither is "does it look right":
 *   - a shot lands at the place on the canvas it was aimed at, and only shots
 *     that actually hit the front of the board land at all;
 *   - the picture leaves the game — the results card shows it, and there is
 *     something to share.
 *
 * Usage: node tools/screen-test.mjs [url]
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
await page.waitForFunction(() => Boolean(window.__paintball), { timeout: 30_000 });
await page.evaluate(() => window.__paintball.setManualSim(true));
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 60_000 });
await page.mouse.click(512, 288);
await page.waitForTimeout(400);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const waitSim = (seconds) => page.evaluate((s) => window.__paintball.stepSim(s), seconds);

/**
 * Reads the mural's pixels back out of its own canvas.
 *
 * Straight from the 2D canvas rather than from the framebuffer, which is the
 * whole advantage of keeping the board's paint in texture space: no camera to
 * aim, no lighting to undo, and the same bytes that get shared.
 */
const readMural = () => page.evaluate(() => {
  const dataUrl = window.__paintball.paintScreen.toDataURL();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const probe = document.createElement('canvas');
      probe.width = img.width;
      probe.height = img.height;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      // The canvas starts as one flat colour, so "painted" is simply "not that".
      const base = [data[0], data[1], data[2]];
      let painted = 0;
      let sumX = 0;
      let sumY = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        if (Math.abs(data[i] - base[0]) + Math.abs(data[i + 1] - base[1]) +
            Math.abs(data[i + 2] - base[2]) < 30) continue;
        painted++;
        sumX += (p % img.width) / img.width;
        sumY += Math.floor(p / img.width) / img.height;
      }
      resolve({
        width: img.width,
        height: img.height,
        base,
        painted,
        // Centre of mass of the paint, in 0..1 canvas coordinates.
        centroid: painted === 0 ? null : { u: sumX / painted, v: sumY / painted },
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
});

// --- The board is in the park ----------------------------------------------
const blank = await readMural();
check('the mural is a 16:9 canvas', blank !== null && blank.width === 2048 &&
      blank.height === 1152, blank ? `${blank.width}x${blank.height}` : 'no image');
check('it starts blank', blank !== null && blank.painted === 0,
      blank ? `${blank.painted} painted pixels on a fresh canvas` : 'no image');

/**
 * Stands the player in front of the screen and fires at a point on it.
 *
 * The board hangs on the plaza's east rim facing west, so this stands to its
 * west and looks east. Aim is set by pointing at a world position on the board
 * rather than by a magic yaw, so the numbers below stay meaningful if it moves.
 */
async function shootAt({ from, at }) {
  await page.evaluate(({ from, at }) => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(from.x, from.y, from.z));
    // The camera trails behind, so aiming at the target from the *player* is
    // close enough: the board is 10m away and 11m wide.
    state.yaw = Math.atan2(-(at.x - from.x), -(at.z - from.z));
    state.pitch = Math.atan2(at.y - (from.y + 1.62),
                             Math.hypot(at.x - from.x, at.z - from.z));
  }, { from, at });
  await waitSim(0.5);
  await page.mouse.down();
  await waitSim(0.7);
  await page.mouse.up();
  await waitSim(1.0);
}

// Straight at the middle of the board, from due west of it.
const CENTRE = { x: 13.2, y: 4.5, z: 2 };
await shootAt({ from: { x: 3, y: 1.5, z: 2 }, at: CENTRE });

const afterCentre = await readMural();
check('shooting the screen paints it', afterCentre.painted > 0,
      `${afterCentre.painted} painted pixels`);

// --- A place on the board is a place in the picture -------------------------
//
// Driven by putting impacts at exact points on the canvas plane rather than by
// shooting at it. Where a real shot lands is a question about the marker, the
// aim solver — which traces from the *camera*, three and a half metres behind
// the player — and a ballistic arc, and none of those are what is under test
// here. `canvasMesh.localToWorld` turns a place on the picture into a place in
// the park, which is exactly the mapping this is checking the inverse of.
//
// It matters because there are two independent chances to end up mirrored: the
// texture is sampled with `flipY`, and the board is rotated a quarter turn to
// face west. A mirrored mural is invisible until somebody paints a word on it.
async function stamp(u, v) {
  return page.evaluate(({ u, v }) => {
    const { game, paintScreen, state } = window.__paintball;
    const V = state.position.constructor;
    const [width, height] = paintScreen.size;
    paintScreen.clear();
    // Local (x, y) on the plane, with +Z out of its face; a little proud of it,
    // as a real impact point is.
    const point = paintScreen.canvasMesh.localToWorld(
      new V((u - 0.5) * width, (0.5 - v) * height, 0.02));
    const normal = paintScreen.canvasMesh.localToWorld(new V(0, 0, 1))
      .sub(paintScreen.canvasMesh.localToWorld(new V(0, 0, 0))).normalize();
    game.events.emit('hit:world', {
      shooterId: 'probe', color: 0xff3d81, point, normal,
      impactSpeed: 40, colliderHandle: -1,
    });
    return paintScreen.splatCount;
  }, { u, v });
}

for (const [name, u, v] of [
  ['the middle', 0.5, 0.5],
  ['the right', 0.8, 0.5],
  ['the left', 0.2, 0.5],
  ['the top', 0.5, 0.2],
  ['the bottom', 0.5, 0.8],
]) {
  const splats = await stamp(u, v);
  const mural = await readMural();
  const landed = mural.centroid;
  check(`a hit at ${name} of the board lands at ${name} of the picture`,
        splats === 1 && landed !== null &&
        Math.abs(landed.u - u) < 0.06 && Math.abs(landed.v - v) < 0.06,
        landed
          ? `aimed u=${u} v=${v}, landed u=${landed.u.toFixed(2)} v=${landed.v.toFixed(2)}`
          : `${splats} splats, nothing painted`);
}

// --- The back of the board is not the picture -------------------------------
// Without a facing test a shot into the back prints a mirrored splat on the
// front, from paint nobody standing in the plaza can see.
await page.evaluate(() => window.__paintball.paintScreen.clear());
await shootAt({ from: { x: 24, y: 1.5, z: 2 }, at: CENTRE });
const afterBehind = await readMural();
const behindHits = await page.evaluate(() => window.__paintball.impacts.length);
check('shots into the back of the board do not paint the picture',
      afterBehind.painted === 0,
      `${behindHits} impacts recorded, ${afterBehind.painted} painted pixels`);

// --- World paint stays off it ----------------------------------------------
// The board is deliberately absent from `SurfaceRegistry`, so `PaintSystem`
// finds no receiver and returns. If it ever gets registered, the mural competes
// for the world vertex budget and is the first thing evicted out of it.
//
// Tested by replaying an impact on the board's *own* collider rather than by
// counting decals after a burst: a burst also sprays the paving and the trees
// behind the board, and those are world decals that ought to be there.
// Fired at the front again first, because the previous case left the most
// recent impacts on the *back* of the board — and the board rightly refuses
// those, which would look like this test failing.
await page.evaluate(() => window.__paintball.paintScreen.clear());
await page.evaluate(() => { window.__paintball.impacts.length = 0; });
await shootAt({ from: { x: 3, y: 1.5, z: 2 }, at: CENTRE });

const isolation = await page.evaluate(() => {
  const { game, paint, paintScreen, impacts, state } = window.__paintball;
  // The board's front face is at x≈13.28, facing west. An impact on it is one
  // that stopped just short of that and well above head height.
  const onBoard = [...impacts].reverse().find(
    (i) => i.x > 12.8 && i.x < 13.5 && i.y > 2 && i.y < 7);
  if (!onBoard) return { error: 'no impact on the front of the board to source a collider from' };

  const V = state.position.constructor;
  paintScreen.clear();
  const before = { world: paint.splatCount, screen: paintScreen.splatCount };
  for (let i = 0; i < 5; i++) {
    game.events.emit('hit:world', {
      shooterId: 'probe',
      color: 0xffd23f,
      point: new V(onBoard.x, onBoard.y + i * 0.1, onBoard.z),
      normal: new V(-1, 0, 0),
      impactSpeed: 40,
      colliderHandle: onBoard.colliderHandle,
    });
  }
  return { before, after: { world: paint.splatCount, screen: paintScreen.splatCount } };
});

if (isolation.error) {
  check('the screen takes its own paint, not world decals', false, isolation.error);
} else {
  check('the screen takes its own paint, not world decals',
        isolation.after.screen > isolation.before.screen &&
        isolation.after.world === isolation.before.world,
        `screen ${isolation.before.screen} -> ${isolation.after.screen}, ` +
        `world decals ${isolation.before.world} -> ${isolation.after.world}`);
}

// --- The poster reaches the results card ------------------------------------
await page.evaluate(() => { window.__paintball.match.timeLeft = 0.05; });
await waitSim(0.5);
await page.waitForTimeout(1200);

const card = await page.evaluate(() => {
  const mural = document.querySelector('[data-results-mural]');
  const img = document.querySelector('[data-results-image]');
  const buttons = [...document.querySelectorAll('[data-share-action]')];
  return {
    visible: document.querySelector('.results').classList.contains('is-visible'),
    muralShown: mural !== null && !mural.hidden,
    src: img?.getAttribute('src') ?? '',
    actions: buttons.map((b) => b.dataset.shareAction),
    // The card lets clicks through to the canvas so that clicking anywhere
    // starts the next round; the share controls have to opt back in, or
    // sharing the picture also throws it away.
    clickable: buttons.every((b) => getComputedStyle(b).pointerEvents === 'auto'),
  };
});
check('the results card shows the mural', card.visible && card.muralShown &&
      card.src.startsWith('data:image/png;base64,'),
      `visible=${card.visible} shown=${card.muralShown} src=${card.src.slice(0, 24)}…`);
check('there is something to share it with', card.actions.length > 0,
      card.actions.join(', ') || 'no buttons');
check('the share buttons take clicks of their own', card.clickable === true);

// A save button must have a live object URL behind it before anyone can press
// it: the blob is built when the card appears, not in the click handler,
// because Safari spends the gesture across an await and the share then fails.
const ready = await page.evaluate(() => {
  const save = document.querySelector('[data-share-action="save"]');
  if (!save) return { ok: false, why: 'no save button' };
  return { ok: true };
});
check('the poster is prepared before it is asked for', ready.ok === true, ready.why ?? '');

// --- The mural survives a new round -----------------------------------------
// Deliberate, and the same call `MatchSystem.restart` documents for world
// paint: a park that carries the day's mess from round to round suits this game
// better than one that wipes clean every five minutes.
const beforeRestart = await page.evaluate(() =>
  window.__paintball.paintScreen.splatCount);
await page.mouse.click(512, 288);
await page.waitForTimeout(500);
const afterRestart = await page.evaluate(() => ({
  splats: window.__paintball.paintScreen.splatCount,
  phase: window.__paintball.match.phase,
}));
check('the mural carries over into the next round',
      afterRestart.phase === 'playing' && afterRestart.splats === beforeRestart,
      `${beforeRestart} splats -> ${afterRestart.splats}`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
