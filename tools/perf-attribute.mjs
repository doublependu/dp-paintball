/**
 * Frame-cost attribution.
 *
 * `perf.mjs` says how slow a frame is; this says *what* made it slow. It hides
 * one group of objects at a time and re-measures, which is the only reliable
 * way to attribute cost — reasoning from triangle counts is how you end up
 * optimising the thing that was already free.
 *
 * Usage: node tools/perf-attribute.mjs [url] [spot]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/dp-paintball/';
const spotName = process.argv[3] ?? 'plaza-fountain';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const SPOTS = {
  'plaza-fountain': { x: 0, z: 10, yaw: 0, pitch: -0.05 },
  'mall-allee': { x: 0, z: 46, yaw: Math.PI, pitch: -0.02 },
  'meadow-skyline': { x: -50, z: 42, yaw: Math.PI, pitch: 0.06 },
  'woodland-belt': { x: -120, z: 30, yaw: -Math.PI / 2, pitch: 0 },
};
const spot = SPOTS[spotName];
if (!spot) throw new Error(`unknown spot ${spotName}`);

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-dev-shm-usage',
         '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 90_000 });
await page.mouse.click(960, 540);
await page.waitForTimeout(500);

await page.evaluate(({ x, z, yaw, pitch }) => {
  const { player, state } = window.__paintball;
  state.yaw = yaw; state.pitch = pitch;
  player.teleport(new (state.position.constructor)(x, 8, z));
}, spot);
await page.waitForTimeout(2500);

/**
 * Classifies scene objects into the groups worth attributing separately, then
 * lets each one be toggled by name.
 */
await page.evaluate(() => {
  const scene = window.__paintball.game.render.scene;
  const groups = { foliage: [], trunksFar: [], trunksNear: [], city: [], terrain: [], props: [] };
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const positions = o.geometry?.getAttribute?.('position');
    const verts = positions ? positions.count : 0;
    if (o.isInstancedMesh && verts === 4) groups.foliage.push(o);
    else if (o.isInstancedMesh && o.geometry.getAttribute('aTint') && o.geometry.getAttribute('aSize')) {
      groups.city.push(o);
    } else if (o.isInstancedMesh && o.material?.vertexColors && !o.castShadow) groups.trunksFar.push(o);
    else if (o.isInstancedMesh && o.material?.vertexColors) groups.trunksNear.push(o);
    else if (o.material?.vertexColors && !o.isInstancedMesh) groups.terrain.push(o);
    else groups.props.push(o);
  });
  window.__attr = groups;
  return null;
});

const sample = (frames) => page.evaluate((n) => new Promise((resolve) => {
  const times = [];
  let last = performance.now();
  let count = 0;
  const tick = () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (++count < n) { requestAnimationFrame(tick); return; }
    const warm = times.slice(8).sort((a, b) => a - b);
    resolve(warm[Math.floor(warm.length * 0.5)]);
  };
  requestAnimationFrame(tick);
}), frames);

const setVisible = (group, visible) => page.evaluate(({ group, visible }) => {
  for (const o of window.__attr[group]) o.visible = visible;
}, { group, visible });

const setShadows = (enabled) => page.evaluate((enabled) => {
  const scene = window.__paintball.game.render.scene;
  scene.traverse((o) => { if (o.isDirectionalLight) o.castShadow = enabled; });
}, enabled);

const counts = await page.evaluate(() => Object.fromEntries(
  Object.entries(window.__attr).map(([k, v]) => [k, v.length]),
));

const base = await sample(140);
console.log(`\nspot: ${spotName}   baseline median: ${base.toFixed(2)}ms`);
console.log(`meshes: ${JSON.stringify(counts)}\n`);
console.log('  hidden group     median    saved');

for (const group of Object.keys(counts)) {
  if (counts[group] === 0) continue;
  await setVisible(group, false);
  await page.waitForTimeout(300);
  const m = await sample(140);
  await setVisible(group, true);
  console.log(`  ${group.padEnd(17)}${m.toFixed(2).padEnd(10)}${(base - m).toFixed(2)}ms`);
}

await setShadows(false);
await page.waitForTimeout(400);
const noShadow = await sample(140);
await setShadows(true);
console.log(`  ${'(shadows off)'.padEnd(17)}${noShadow.toFixed(2).padEnd(10)}${(base - noShadow).toFixed(2)}ms`);

for (const pass of ['prepass', 'outline', 'bloom', 'grade']) {
  await page.evaluate((p) => window.__paintball.game.render.nprPipeline.setPassEnabled(p, false), pass);
  await page.waitForTimeout(300);
  const m = await sample(140);
  await page.evaluate((p) => window.__paintball.game.render.nprPipeline.setPassEnabled(p, true), pass);
  console.log(`  ${`(${pass} off)`.padEnd(17)}${m.toFixed(2).padEnd(10)}${(base - m).toFixed(2)}ms`);
}

await browser.close();
