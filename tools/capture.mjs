/**
 * Visual capture harness.
 *
 * Takes a fixed set of framed shots and measures each one, so a change can be
 * compared against the previous pass rather than against memory. The shot list
 * is pinned deliberately: judging "is it better" from freehand screenshots is
 * how you convince yourself of improvements that aren't there.
 *
 * The metrics target specific claims the look is supposed to make:
 *   shadowWarmth  highlights should be warmer than shadows. Negative means
 *                 shadows are cooler than lights, which is the Ghibli tell the
 *                 whole lighting model is built around.
 *   edgeDensity   fraction of pixels sitting on an ink line. Too low and the
 *                 Borderlands read is gone; too high and it's a scribble.
 *   lumaSpread    standard deviation of luminance. Flat images score low.
 *   hueSpread     distinct hue buckets present. Measures palette variety, and
 *                 catches "everything is one green".
 *
 * Usage: node tools/capture.mjs [outDir] [url]
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'captures';
const url = process.argv[3] ?? 'http://localhost:4173/dp-paintball/';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

mkdirSync(outDir, { recursive: true });

/**
 * Pinned viewpoints. `y` is a clearance above the ground; the player is dropped
 * from there and allowed to settle, so shots stay valid if terrain changes.
 */
const SHOTS = [
  { name: 'plaza-fountain', x: 0, z: 10, yaw: 0, pitch: -0.05 },
  { name: 'terrace-north', x: 0, z: 21, yaw: 0, pitch: -0.15 },
  { name: 'mall-allee', x: 0, z: 46, yaw: Math.PI, pitch: -0.02 },
  { name: 'lake-shore', x: -13, z: -11, yaw: 0.15, pitch: -0.04 },
  // From the west bank, three-quarters onto the span. The bridge moved west
  // with the enlarged lake; the old viewpoint now looks at open water, and
  // standing on the approach itself frames nothing but the parapet.
  { name: 'bow-bridge', x: -58, z: -14, yaw: -0.72, pitch: -0.05 },
  { name: 'ramble', x: -30, z: -70, yaw: 1.2, pitch: 0.0 },
  { name: 'arcade-undercroft', x: 0, z: 20, yaw: Math.PI, pitch: 0.0 },
  // Added when the map grew its outer two rings. The first four shots above
  // are all inside the play area, and every one of them frames a landmark —
  // so none of them could tell you whether the woodland belt reads as a wood,
  // whether the skyline reads as Manhattan, or whether the park boundary
  // reads as a boundary. Those are exactly the three things the expansion is
  // for, so the rubric has to be able to see them.
  { name: 'meadow-skyline', x: -50, z: 42, yaw: Math.PI, pitch: 0.06 },
  { name: 'woodland-belt', x: -120, z: 30, yaw: -Math.PI / 2, pitch: 0.0 },
  { name: 'park-wall', x: -150, z: 0, yaw: Math.PI / 2, pitch: 0.05 },
];

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const startedAt = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 90_000 });
const readyMs = Date.now() - startedAt;
await page.mouse.click(640, 360);
await page.waitForTimeout(400);

async function waitSim(seconds) {
  const start = await page.evaluate(() => window.__paintball.simTime());
  await page.waitForFunction(({ start, seconds }) =>
    window.__paintball.simTime() - start >= seconds, { start, seconds },
    { timeout: 240_000, polling: 40 });
}

/**
 * Reads the drawing buffer and derives the rubric metrics.
 * Must sample inside rAF: the context has no preserveDrawingBuffer, so reading
 * it outside a frame silently returns an empty image.
 */
const measure = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const canvas = document.querySelector('canvas.game-canvas');
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const { data, width, height } = ctx.getImageData(0, 0, probe.width, probe.height);

    const luma = new Float32Array(width * height);
    const hues = new Set();
    let sumLuma = 0;

    // Warmth: red minus blue, which separates a warm highlight from a cool one
    // without needing a full colour-space conversion.
    const warmth = new Float32Array(width * height);

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[p] = l;
      warmth[p] = r - b;
      sumLuma += l;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min > 0.06) {
        let h = 0;
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        hues.add(Math.floor(h * 6));
      }
    }

    const meanLuma = sumLuma / luma.length;
    let variance = 0;
    for (const l of luma) variance += (l - meanLuma) ** 2;
    const lumaSpread = Math.sqrt(variance / luma.length);

    // Split the image into its darkest and lightest fifths and compare warmth.
    const sorted = Float32Array.from(luma).sort();
    const darkCut = sorted[Math.floor(sorted.length * 0.2)];
    const lightCut = sorted[Math.floor(sorted.length * 0.8)];
    let darkWarm = 0; let darkN = 0;
    let lightWarm = 0; let lightN = 0;
    for (let p = 0; p < luma.length; p++) {
      if (luma[p] <= darkCut) { darkWarm += warmth[p]; darkN++; }
      else if (luma[p] >= lightCut) { lightWarm += warmth[p]; lightN++; }
    }
    const shadowWarmth = (darkN ? darkWarm / darkN : 0) - (lightN ? lightWarm / lightN : 0);

    // Sobel-ish edge count on luminance, as a proxy for ink coverage.
    let edges = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx = luma[i + 1] - luma[i - 1];
        const gy = luma[i + width] - luma[i - width];
        if (Math.hypot(gx, gy) > 0.12) edges++;
      }
    }

    const info = window.__paintball.game.render.renderer.info;
    resolve({
      meanLuma: +meanLuma.toFixed(3),
      lumaSpread: +lumaSpread.toFixed(3),
      shadowWarmth: +shadowWarmth.toFixed(3),
      edgeDensity: +(edges / (width * height)).toFixed(4),
      hueSpread: hues.size,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
    });
  });
}));

const report = { readyMs, shots: [], errors };

for (const shot of SHOTS) {
  await page.evaluate(({ x, z, yaw, pitch }) => {
    const { player, state } = window.__paintball;
    state.yaw = yaw;
    state.pitch = pitch;
    player.teleport(new (state.position.constructor)(x, 8, z));
  }, shot);
  // Let the drop settle and the camera arm ease out.
  await waitSim(2.6);

  const metrics = await measure();
  await page.screenshot({ path: join(outDir, `${shot.name}.png`) });
  report.shots.push({ name: shot.name, ...metrics });
}

await browser.close();

writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nload ${readyMs}ms   errors: ${errors.length || 'none'}\n`);
console.log(pad('shot', 20) + pad('warmth', 9) + pad('spread', 9) + pad('edges', 9) +
            pad('hues', 6) + pad('calls', 7) + 'tris');
for (const s of report.shots) {
  console.log(
    pad(s.name, 20) + pad(s.shadowWarmth, 9) + pad(s.lumaSpread, 9) +
    pad(s.edgeDensity, 9) + pad(s.hueSpread, 6) + pad(s.drawCalls, 7) + s.triangles,
  );
}
console.log(`\nwritten to ${outDir}/`);
