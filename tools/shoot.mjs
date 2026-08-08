/**
 * Headless screenshot + diagnostics harness.
 *
 * Drives the system Chrome via playwright-core (no browser download). Used to
 * verify rendering during development, and it's the foundation the phase 9
 * visual critic loop builds on.
 *
 * Usage: node tools/shoot.mjs [url] [outPath] [waitSeconds]
 */
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/dp-paintball/';
const out = process.argv[3] ?? 'shot.png';
const waitSeconds = Number(process.argv[4] ?? 6);

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

if (!EXECUTABLE) {
  throw new Error('No system Chrome found. Set CHROME_PATH to a browser binary.');
}

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    // SwiftShader gives us a real WebGL2 context without a GPU, which is what
    // makes this work on a headless box.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
page.on('requestfailed', (req) =>
  logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`),
);

const startedAt = Date.now();
await page.goto(url, { waitUntil: 'load' });

// Wait for the game to signal readiness rather than guessing at a delay.
let ready = false;
try {
  await page.waitForFunction(() => !document.querySelector('#loader'), { timeout: 30_000 });
  ready = true;
} catch {
  ready = false;
}
const readyMs = Date.now() - startedAt;

// Let a few frames run so anything time-based has settled.
await page.waitForTimeout(waitSeconds * 1000);

const diag = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const canvas = document.querySelector('canvas.game-canvas');
      const base = {
        hasCanvas: Boolean(canvas),
        canvasCss: canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : null,
        canvasBuffer: canvas ? `${canvas.width}x${canvas.height}` : null,
        hasWebgl2: Boolean(canvas?.getContext('webgl2')),
        loaderPresent: Boolean(document.querySelector('#loader')),
      };

      // Sample frame times, then read the canvas from inside a rAF callback.
      // The context is created without preserveDrawingBuffer, so the drawing
      // buffer is only valid between the game's draw and the next composite —
      // reading it outside rAF returns an empty image and silently lies.
      const frameTimes = [];
      let last = performance.now();
      let frames = 0;

      const sample = () => {
        const now = performance.now();
        frameTimes.push(now - last);
        last = now;
        if (++frames < 40) {
          requestAnimationFrame(sample);
          return;
        }

        let distinctColorBuckets = -1;
        if (canvas) {
          const probe = document.createElement('canvas');
          probe.width = 160;
          probe.height = 90;
          const ctx = probe.getContext('2d');
          if (ctx) {
            ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
            const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
            const seen = new Set();
            for (let i = 0; i < data.length; i += 4) {
              seen.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
            }
            distinctColorBuckets = seen.size;
          }
        }

        const sorted = [...frameTimes].sort((a, b) => a - b);
        resolve({
          ...base,
          distinctColorBuckets,
          medianFrameMs: Number((sorted[sorted.length >> 1] ?? 0).toFixed(2)),
          worstFrameMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
        });
      };

      requestAnimationFrame(sample);
    }),
);

await page.screenshot({ path: out });
await browser.close();

const report = { url, out, ready, readyMs, ...diag, logs };
console.log(JSON.stringify(report, null, 2));
writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(report, null, 2));
