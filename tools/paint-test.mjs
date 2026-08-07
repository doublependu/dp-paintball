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

const url = process.argv[2] ?? 'http://localhost:4173/';
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
  await page.waitForTimeout(350);
}

async function fireFor(ms, settleMs = 1200) {
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(settleMs);
}

// --- Accumulation ---------------------------------------------------------
await place(6, 1, 30, 0, -0.3);
const before = await stats();
await fireFor(900);
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
await page.waitForTimeout(1200);
const idle = await stats();
check('paint persists when not firing', idle.splats === after.splats, `${idle.splats} splats`);

// --- Rotated receivers ----------------------------------------------------
// The 45 degree ramp is a rotated box; projection must respect its world
// transform, not its local axes.
const beforeRamp = await stats();
await place(-24, 1, -18, Math.PI, -0.15);
await fireFor(700);
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

// --- Eviction -------------------------------------------------------------
// Fire once at open ground to learn which collider the ground is, then flood
// the buffer through the same event path a real impact takes.
await place(6, 1, 30, 0, -0.5);
await fireFor(300, 800);

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
