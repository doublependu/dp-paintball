/**
 * Headless paint tests.
 *
 * Covers accumulation, projection onto rotated geometry, and the eviction path
 * that keeps the vertex buffer bounded. Eviction is driven by emitting
 * hit:world events directly — the same path a real impact takes, just without
 * waiting twenty minutes for the gun to place ten thousand splats.
 *
 * Usage: node tools/paint-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

// The test course, not the park: every coordinate below is a fixture of
// that geometry.
const url = process.argv[2] ?? 'http://localhost:4173/?scene=course';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });

const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

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
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'), {
  timeout: 30_000,
});

await page.mouse.click(512, 288);
await page.waitForTimeout(400);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const stats = () =>
  page.evaluate(() => ({
    splats: window.__paintball.paint.splatCount,
    placed: window.__paintball.paint.placedCount,
    verts: window.__paintball.paint.vertexCount,
    impacts: window.__paintball.impacts.length,
  }));

async function place(x, y, z, yaw, pitch = 0) {
  await page.evaluate(
    ({ x, y, z, yaw, pitch }) => {
      const { player, state } = window.__paintball;
      state.yaw = yaw;
      state.pitch = pitch;
      player.teleport(new (state.position.constructor)(x, y, z));
      window.__paintball.impacts.length = 0;
    },
    { x, y, z, yaw, pitch },
  );
  await waitSim(0.35);
}

/** Advances the simulation by `seconds`, stepping it directly. */
async function waitSim(seconds) {
  await page.evaluate((s) => window.__paintball.stepSim(s), seconds);
}

async function fireFor(seconds, settleSeconds = 1.2) {
  await page.mouse.down();
  await waitSim(seconds);
  await page.mouse.up();
  await waitSim(settleSeconds);
}

// --- Accumulation ---------------------------------------------------------
await place(6, 1, 30, 0, -0.3);
const before = await stats();
await fireFor(0.9);
const after = await stats();
check(
  'firing places splats',
  after.splats > before.splats,
  `${before.splats} -> ${after.splats}`,
);
check(
  'every impact produces a splat',
  after.splats - before.splats === after.impacts,
  `${after.splats - before.splats} splats for ${after.impacts} impacts`,
);

// --- Persistence ----------------------------------------------------------
await waitSim(1.2);
const idle = await stats();
check('paint persists when not firing', idle.splats === after.splats, `${idle.splats} splats`);

// --- Rotated receivers ----------------------------------------------------
// The 45 degree ramp is a rotated box; projection must respect its world
// transform, not its local axes.
const beforeRamp = await stats();
await place(-24, 1, -18, Math.PI, -0.15);
await fireFor(0.7);
const afterRamp = await stats();
check(
  'paints onto rotated geometry (45 degree ramp)',
  afterRamp.splats > beforeRamp.splats,
  `+${afterRamp.splats - beforeRamp.splats} splats`,
);

// --- Vertex budget --------------------------------------------------------
check(
  'vertex count is proportional and bounded',
  afterRamp.verts > 0 && afterRamp.verts < 150_000,
  `${afterRamp.verts} verts for ${afterRamp.splats} splats ` +
    `(${(afterRamp.verts / afterRamp.splats).toFixed(1)}/splat)`,
);

// --- Overlapping paint does not z-fight -------------------------------------
//
// FEEDBACK_5: "z fighting artifact when different color paint overlap each
// other on objects such as trees and benches". All world paint is one merged
// buffer with one polygon offset, which separates paint from the surface but
// not from other paint — two decals over the same triangle are built from that
// triangle's own vertices and end up at the same depth to the bit. The material
// now writes no depth at all, so the draw order decides and the newest splat
// wins everywhere.
//
// Measured by colour rather than by looking for speckle: lay cyan down, cover
// it with magenta, and the patch must read magenta. A tie broken by depth
// precision reads as a mixture of the two, and — the part that makes it a
// z-fighting test rather than a draw-order one — the mixture shifts when the
// camera moves a few millimetres, because that is what changes the interpolated
// depths. So it is measured twice, from two positions a hair apart.
await place(6, 1, 30, 0, -1.0);
await fireFor(0.3, 0.8);

const overlapReady = await page.evaluate(() => {
  const { game, state, impacts } = window.__paintball;
  const handle = impacts.at(-1)?.colliderHandle;
  if (handle === undefined) return false;
  const Vec = state.position.constructor;

  // A patch of ground a couple of metres in front of where we are standing,
  // painted twice over: every cyan splat gets a magenta one at exactly the same
  // point, which is the coplanar case the report is about.
  const points = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = 0.35 + (i % 5) * 0.32;
    points.push(new Vec(state.position.x + Math.cos(a) * r,
                        0,
                        state.position.z - 2.2 + Math.sin(a) * r));
  }
  for (const color of [0x00d4e8, 0xff3d81]) {
    for (const point of points) {
      game.events.emit('hit:world', {
        shooterId: 'overlap', color, point: point.clone(),
        normal: new Vec(0, 1, 0), impactSpeed: 40, colliderHandle: handle,
      });
    }
  }
  return true;
});

/**
 * Counts saturated cyan and magenta pixels in the frame.
 *
 * Neither hue occurs naturally in this park — it is grass, stone and sky — and
 * the camera is aimed steeply down at painted ground, so what is counted is
 * paint. Deliberately not a mean: a mean over a speckled tie lands between the
 * two colours and looks like a third colour rather than like a fault.
 */
const countHues = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(document.querySelector('canvas.game-canvas'), 0, 0, 320, 180);
    const d = ctx.getImageData(0, 0, 320, 180).data;
    let magenta = 0, cyan = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (r > g + 40 && r > 70) magenta++;
      else if (b > r + 40 && g > r + 20) cyan++;
    }
    resolve({ magenta, cyan });
  });
}));

if (!overlapReady) {
  check('overlap test could run', false, 'no impact recorded to source a collider from');
} else {
  await waitSim(0.3);
  const near = await countHues();
  // A few millimetres, which is all a depth tie needs to resolve the other way.
  await page.evaluate(() => {
    const { player, state } = window.__paintball;
    const p = state.position;
    player.teleport(new (state.position.constructor)(p.x, p.y, p.z + 0.035));
  });
  await waitSim(0.3);
  const far = await countHues();

  check('the newer colour covers the older one where they overlap',
        near.magenta > near.cyan * 6 && far.magenta > far.cyan * 6,
        `near ${near.magenta} magenta / ${near.cyan} cyan, ` +
        `far ${far.magenta} magenta / ${far.cyan} cyan`);

  // And the split does not move when the camera does, which is the difference
  // between "drawn in the right order" and "winning the coin toss this frame".
  const nearShare = near.cyan / Math.max(1, near.magenta + near.cyan);
  const farShare = far.cyan / Math.max(1, far.magenta + far.cyan);
  check('the overlap does not change with the camera',
        Math.abs(nearShare - farShare) < 0.05,
        `older colour holds ${(nearShare * 100).toFixed(1)}% then ${(farShare * 100).toFixed(1)}%`);
}

// --- Eviction -------------------------------------------------------------
// Fire once at open ground to learn which collider the ground is, then flood
// the buffer through the same event path a real impact takes.
await place(6, 1, 30, 0, -0.5);
await fireFor(0.3, 0.8);

const evictionResult = await page.evaluate(() => {
  const { game, paint, state, impacts } = window.__paintball;
  const handle = impacts.at(-1)?.colliderHandle;
  if (handle === undefined) return { error: 'no impact recorded to source a collider from' };

  const Vec = state.position.constructor;
  const before = { splats: paint.splatCount, verts: paint.vertexCount };

  // The ground spans 100m and sits at y=0; scatter across it.
  for (let i = 0; i < 14000; i++) {
    game.events.emit('hit:world', {
      shooterId: 'flood',
      color: 0xff3d81,
      point: new Vec(((i * 37) % 900) / 10 - 45, 0, ((i * 61) % 900) / 10 - 45),
      normal: new Vec(0, 1, 0),
      impactSpeed: 30,
      colliderHandle: handle,
    });
  }

  return {
    before,
    after: { splats: paint.splatCount, verts: paint.vertexCount },
    placed: paint.placedCount,
  };
});

if (evictionResult.error) {
  check('eviction test could run', false, evictionResult.error);
  evictionResult.after = { splats: 0, verts: 0 };
  evictionResult.placed = 0;
}

check(
  'vertex buffer stays within budget under flood',
  evictionResult.after.verts <= 150_000,
  `${evictionResult.after.verts} verts after ${evictionResult.placed} total placements`,
);
check(
  'eviction drops old splats rather than growing forever',
  evictionResult.after.splats < evictionResult.placed,
  `holding ${evictionResult.after.splats} of ${evictionResult.placed} placed`,
);

// The game must still be alive and rendering after all that.
await page.waitForTimeout(600);
const alive = await page.evaluate(
  () => window.__paintball.game.render.renderer.info.render.calls > 0,
);
check('renderer still drawing after eviction', alive);

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
