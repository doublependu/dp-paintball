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
const readMural = (face = 'front') => page.evaluate((which) => {
  const dataUrl = window.__paintball.paintScreen.toDataURL(which);
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
}, face);

// --- The board is in the park ----------------------------------------------
const blank = await readMural();
check('the mural is a 16:9 canvas', blank !== null && blank.width === 2048 &&
      blank.height === 1152, blank ? `${blank.width}x${blank.height}` : 'no image');
check('it starts blank', blank !== null && blank.painted === 0,
      blank ? `${blank.painted} painted pixels on a fresh canvas` : 'no image');

/**
 * Where the board is, asked of the board.
 *
 * Hardcoded coordinates here were a maintenance trap the moment the screen
 * moved off the plaza: `centre` and `normal` are resolved at build time and
 * are exactly what the poster camera and the painting bots read, so a site
 * change moves the whole suite with it.
 */
const board = await page.evaluate(() => {
  const { centre, normal, size } = window.__paintball.paintScreen;
  return {
    centre: { x: centre.x, y: centre.y, z: centre.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
    size: [size[0], size[1]],
  };
});
/**
 * A standing position `distance` metres out along the board's normal.
 *
 * The height is asked of the navgrid rather than assumed. The board used to
 * stand on the plaza, where the ground is dead level at zero and any literal
 * worked; it stands on Sheep Meadow's west rim now, three and a half metres
 * up, and a hardcoded 1.5 puts the player underground with the shots going
 * into the inside of the terrain.
 */
const inFront = async (distance) => {
  const x = board.centre.x + board.normal.x * distance;
  const z = board.centre.z + board.normal.z * distance;
  const y = await page.evaluate(
    ({ x, z }) => window.__paintball.characters.navGrid.groundAt(x, z) + 1.2,
    { x, z },
  );
  return { x, y, z };
};

/**
 * Stands the player in front of the screen and fires at a point on it.
 *
 * Aim is set by pointing at a world position on the board rather than by a
 * magic yaw, so the numbers below stay meaningful wherever it stands.
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

// Straight at the middle of the board, from square in front of it.
const CENTRE = board.centre;
await shootAt({ from: await inFront(10), at: CENTRE });

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

// --- The back is its own picture, and it runs the other way ------------------
//
// The board takes paint on both sides now. The front is the round's canvas and
// the thing that gets shared; the back faces the woods and is nobody's poster.
//
// The mirror is the part worth testing. A splat on the back has to land where
// the person who fired it saw it land, which is the opposite end of the canvas
// from where the same world position falls on the front — and a face that
// stamps its back the same way round as its front looks correct from every
// angle except the one that matters.
await page.evaluate(() => window.__paintball.paintScreen.clear());
await shootAt({ from: await inFront(-11), at: CENTRE });

const backPaint = await readMural('back');
const frontAfterBack = await readMural('front');
check('shooting the back of the board paints the back',
      backPaint.painted > 0 && frontAfterBack.painted === 0,
      `back ${backPaint.painted} painted pixels, front ${frontAfterBack.painted}`);

// Stamped rather than shot, for the same reason the front's uv cases are: this
// is a question about a mapping, not about a marker and an arc.
const mirrored = await page.evaluate(() => {
  const { game, paintScreen, state } = window.__paintball;
  const V = state.position.constructor;
  const [width, height] = paintScreen.size;
  paintScreen.clear();
  // A world point a quarter of the way along the board from its own left.
  const point = paintScreen.canvasMesh.localToWorld(
    new V((0.25 - 0.5) * width, 0, -0.6));
  const out = paintScreen.backMesh.localToWorld(new V(0, 0, 1))
    .sub(paintScreen.backMesh.localToWorld(new V(0, 0, 0))).normalize();
  game.events.emit('hit:world', {
    shooterId: 'probe', color: 0x00d4e8, point, normal: out,
    impactSpeed: 40, colliderHandle: -1,
  });
  return { front: paintScreen.splatCount, back: paintScreen.backSplatCount };
});
const backSpot = await readMural('back');
check('the back of the picture runs the other way',
      mirrored.back === 1 && mirrored.front === 0 && backSpot.centroid !== null &&
      Math.abs(backSpot.centroid.u - 0.75) < 0.06,
      backSpot.centroid
        ? `world point at front-u 0.25 landed at back-u ${backSpot.centroid.u.toFixed(2)}, wanted 0.75`
        : 'nothing painted on the back');

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
await shootAt({ from: await inFront(10), at: CENTRE });

const isolation = await page.evaluate(() => {
  const { game, paint, paintScreen, impacts, state } = window.__paintball;
  // An impact on the front of the board is one that landed within a couple of
  // metres of its centre, which nothing else in the meadow is.
  const c = paintScreen.centre;
  const onBoard = [...impacts].reverse().find(
    (i) => Math.hypot(i.x - c.x, i.y - c.y, i.z - c.z) < 3.2);
  if (!onBoard) return { error: 'no impact on the front of the board to source a collider from' };

  const V = state.position.constructor;
  const n = paintScreen.normal;
  paintScreen.clear();
  const before = { world: paint.splatCount, screen: paintScreen.splatCount };
  for (let i = 0; i < 5; i++) {
    game.events.emit('hit:world', {
      shooterId: 'probe',
      color: 0xffd23f,
      point: new V(onBoard.x, onBoard.y + i * 0.1, onBoard.z),
      normal: new V(n.x, n.y, n.z),
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
// Put some paint back on the front first: the case above cleared it, and a
// poster of a blank board proves nothing about a poster.
await page.evaluate(() => window.__paintball.paintScreen.clear());
await shootAt({ from: await inFront(10), at: CENTRE });

await page.evaluate(() => { window.__paintball.match.timeLeft = 0.05; });
await waitSim(0.5);
// Waited for rather than slept through. The share controls are appended once
// the PNG has been encoded, which is the one part of the card that is not
// synchronous — and encoding a 1600x900 poster under a software rasteriser is
// slower than any fixed delay worth writing down.
await page
  .waitForSelector('[data-share-action="save"]', { timeout: 15_000 })
  .catch(() => {});

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

// --- What is being shared is a photograph of the park, not the flat canvas ---
//
// The prompt asked for "a game play screen capture with the painted mural in
// it", which is a different picture from the mural's own canvas: this one has
// the board standing on its plinth in the meadow, lit and inked, with whoever
// was nearby still in shot. It is taken at the whistle, before `ResultsStage`
// reparents every character out of the park — that ordering is the whole
// contract between `PosterCapture` and `ResultsSystem`, and nothing but
// registration order enforces it.
const poster = await page.evaluate(async () => {
  const captured = window.__paintball.poster.hasPoster;
  const src = document.querySelector('[data-results-image]')?.getAttribute('src') ?? '';
  const size = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.width, img.height]);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return { captured, size };
});
check('the whistle takes a picture of the park with the mural in it',
      poster.captured === true, poster.captured ? '' : 'no poster captured');
check('the poster is 16:9 and the card is showing it',
      poster.size !== null && poster.size[0] === 1600 && poster.size[1] === 900,
      poster.size ? `${poster.size[0]}x${poster.size[1]}` : 'no image on the card');

// --- Posting to X ------------------------------------------------------------
//
// Two separate bugs lived here. The link went to the source repository rather
// than to the game, and the control was a button that started a download *and*
// called `window.open` in one gesture — which browsers throttle, silently, and
// the popup is the half that loses. It is a real anchor now.
const xLink = await page.evaluate(() => {
  const el = document.querySelector('[data-share-action="x"]');
  if (!el) return null;
  return { tag: el.tagName, href: el.getAttribute('href') ?? '', target: el.getAttribute('target') };
});
check('Post to X is a real link, to the game',
      xLink !== null && xLink.tag === 'A' && xLink.target === '_blank' &&
      xLink.href.includes('x.com/intent') && xLink.href.includes('v0.maize.live'),
      xLink ? `${xLink.tag} → ${xLink.href.slice(0, 76)}` : 'no X control');

// A save button must have a live object URL behind it before anyone can press
// it: the blob is built when the card appears, not in the click handler,
// because Safari spends the gesture across an await and the share then fails.
const ready = await page.evaluate(() => {
  const save = document.querySelector('[data-share-action="save"]');
  if (!save) return { ok: false, why: 'no save button' };
  return { ok: true };
});
check('the poster is prepared before it is asked for', ready.ok === true, ready.why ?? '');

// --- A new round gets a clean canvas, and only a clean canvas ---------------
//
// The front is wiped because it is the round's picture and the thing that goes
// out to social media: a souvenir that is half of last round's game is not this
// round's souvenir. Everything else is deliberately left alone — the back is
// the park's graffiti wall, and world paint carries the day's mess from round
// to round, which is the choice `MatchSystem.restart` has always documented.
//
// The card's own image must survive too. It is a data URL taken at the whistle
// rather than a live view of the canvas, so the wipe that happens on the click
// that dismisses the card must not blank the picture being shared.
await page.evaluate(() => {
  const { game, paintScreen, state } = window.__paintball;
  const V = state.position.constructor;
  // One splat on each face, placed rather than shot.
  const out = paintScreen.normal;
  for (const [face, sign] of [['front', 1], ['back', -1]]) {
    void face;
    const point = paintScreen.canvasMesh.localToWorld(new V(0, 0, sign > 0 ? 0.02 : -0.6));
    game.events.emit('hit:world', {
      shooterId: 'probe', color: 0xa8e337, point,
      normal: new V(out.x * sign, 0, out.z * sign),
      impactSpeed: 40, colliderHandle: -1,
    });
  }
});
const beforeRestart = await page.evaluate(() => ({
  front: window.__paintball.paintScreen.splatCount,
  back: window.__paintball.paintScreen.backSplatCount,
  world: window.__paintball.paint.splatCount,
  cardSrc: document.querySelector('[data-results-image]')?.getAttribute('src') ?? '',
}));
await page.mouse.click(512, 288);
await page.waitForTimeout(500);
const afterRestart = await page.evaluate(() => ({
  front: window.__paintball.paintScreen.splatCount,
  back: window.__paintball.paintScreen.backSplatCount,
  world: window.__paintball.paint.splatCount,
  cardSrc: document.querySelector('[data-results-image]')?.getAttribute('src') ?? '',
  phase: window.__paintball.match.phase,
}));
check('a new round wipes the front of the mural',
      afterRestart.phase === 'playing' && beforeRestart.front > 0 && afterRestart.front === 0,
      `${beforeRestart.front} splats -> ${afterRestart.front}`);
check('and leaves the back and the park alone',
      afterRestart.back === beforeRestart.back && afterRestart.back > 0 &&
      afterRestart.world === beforeRestart.world,
      `back ${beforeRestart.back} -> ${afterRestart.back}, ` +
      `world ${beforeRestart.world} -> ${afterRestart.world}`);
check('the picture on the card is not wiped with it',
      beforeRestart.cardSrc.length > 1000 && afterRestart.cardSrc === beforeRestart.cardSrc,
      `${beforeRestart.cardSrc.length} bytes -> ${afterRestart.cardSrc.length}`);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
