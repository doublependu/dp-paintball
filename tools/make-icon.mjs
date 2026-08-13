/**
 * Rasterises `public/icon.svg` into the PNGs a home screen wants.
 *
 * iOS ignores SVG icons entirely — an `apple-touch-icon` has to be a PNG, and
 * without one the saved app gets a blurry screenshot of whatever was on screen.
 * Android takes the manifest's PNGs. The SVG stays the source of truth; this
 * only ever needs re-running when it changes.
 *
 * Usage: node tools/make-icon.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

/** name, size. 180 is the iOS touch icon; the rest are the manifest's. */
const TARGETS = [
  ['public/apple-touch-icon.png', 180],
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
];

const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage();

for (const [out, size] of TARGETS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  writeFileSync(out, await page.screenshot({ omitBackground: false }));
  console.log(`${out} — ${size}x${size}`);
}

await browser.close();
