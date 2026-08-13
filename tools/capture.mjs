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
const url = process.argv[3] ?? 'http://localhost:4173/';
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

/**
 * Grabs the current frame into the page, or diffs against the last grab.
 *
 * Two frames of the same viewpoint that differ only in whether a body is
 * carrying paint give the one number this rubric never had: how many pixels the
 * paint is actually responsible for. Every other metric here is a property of
 * the whole image, and character paint has vanished twice without moving any of
 * them — see NEXT_1's P0, where a splat was recorded, counted, and then
 * silently rejected by a shader guard.
 */
const grabFrame = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const canvas = document.querySelector('canvas.game-canvas');
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    window.__captureRef = ctx.getImageData(0, 0, probe.width, probe.height).data;
    resolve(true);
  });
}));

const diffFrame = () => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => {
    const canvas = document.querySelector('canvas.game-canvas');
    const probe = document.createElement('canvas');
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const now = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const before = window.__captureRef;
    let changed = 0;
    for (let i = 0; i < now.length; i += 4) {
      // Generous threshold: SwiftShader dithers, and a splat is a solid block
      // of saturated colour rather than a subtle shift.
      if (Math.abs(now[i] - before[i]) +
          Math.abs(now[i + 1] - before[i + 1]) +
          Math.abs(now[i + 2] - before[i + 2]) > 60) changed++;
    }
    resolve(+(changed / (now.length / 4)).toFixed(4));
  });
}));

/**
 * Stands the player a few metres from the nearest bot, facing it.
 *
 * The drop height comes from the *bot's* feet, not the player's: they can be
 * tens of metres apart in elevation on this map, and taking the player's put
 * the camera under the terrain looking up at the underside of the park.
 */
const standNearBot = (range) => page.evaluate((range) => {
  const { player, state, characters } = window.__paintball;
  const V = state.position.constructor;
  let best = null;
  let bestDistance = Infinity;
  for (const bot of characters.allBots) {
    const d = Math.hypot(bot.position.x - state.position.x, bot.position.z - state.position.z);
    if (d < bestDistance) { bestDistance = d; best = bot; }
  }
  if (!best) return null;

  const dx = best.position.x - state.position.x;
  const dz = best.position.z - state.position.z;
  const length = Math.hypot(dx, dz) || 1;
  player.teleport(new V(best.position.x - (dx / length) * range, best.position.y + 1.5,
                        best.position.z - (dz / length) * range));
  state.yaw = Math.atan2(-dx / length, -dz / length);
  state.pitch = 0.05;
  return best.id;
}, range);

/**
 * Covers a bot in paint, from the side the camera is on.
 *
 * Hits are synthesised rather than fired, because a burst from a real marker at
 * a wandering bot lands a different number of splats every run and the whole
 * point of this shot is that it is comparable between passes. They are placed
 * on the *capsule* surface, which is where real impacts come from, and that
 * detail is the entire reason this measurement is worth having.
 */
const paintBot = (id) => page.evaluate((id) => {
  const { game, state, characters } = window.__paintball;
  const V = state.position.constructor;
  const bot = characters.allBots.find((b) => b.id === id);
  if (!bot) return 0;

  const facing = Math.atan2(state.position.x - bot.position.x,
                            state.position.z - bot.position.z);
  for (let i = 0; i < 12; i++) {
    const angle = facing + (i % 4 - 1.5) * 0.45;
    const height = 0.95 + Math.floor(i / 4) * 0.35;
    bot.character.tickGameplay(5);
    game.events.emit('hit:character', {
      targetId: bot.id,
      shooterId: 'player',
      color: 0xff3d81,
      point: new V(
        bot.position.x + Math.sin(angle) * 0.35,
        bot.position.y + height,
        bot.position.z + Math.cos(angle) * 0.35,
      ),
      normal: new V(Math.sin(angle), 0, Math.cos(angle)),
      impactSpeed: 38,
    });
  }
  return bot.character.paint.splatCount;
}, id);

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

// --- character shots --------------------------------------------------------
//
// Every viewpoint above is a landscape, and every visual bug reported by a
// human so far has been about the characters. These two are the ones that would
// have caught them: a painted body at fighting range, and the results line-up,
// which is seven painted bodies at close range in a fixed frame.
await page.evaluate(() => window.__paintball.setManualSim(true));
await page.evaluate((s) => window.__paintball.stepSim(s), 0.4);

let painted = await standNearBot(8);
if (painted) {
  // Settle *before* painting: the spring arm takes the best part of a second
  // to catch up with a teleport, and a camera still easing between the two
  // frames moves a third of the image on its own.
  await page.evaluate((s) => window.__paintball.stepSim(s), 1.4);
  // Then close the gap again. The bot has been walking the whole time, and
  // eight metres becomes twenty while the camera catches up — which is how the
  // first version of this shot ended up measuring a figure forty pixels tall.
  painted = await standNearBot(8);
  await page.evaluate((s) => window.__paintball.stepSim(s), 0.5);
  // And stop it wandering out of frame mid-measurement. `respawn` in place is
  // the only stand-still there is: it clears the path and the target, so the
  // bot holds position until it decides to repath.
  await page.evaluate((id) => {
    const bot = window.__paintball.characters.allBots.find((b) => b.id === id);
    bot.respawn(bot.position.clone());
  }, painted);
  await paintBot(painted);
  // Then long enough for the flinch the hits trigger to play out.
  await page.evaluate((s) => window.__paintball.stepSim(s), 0.8);
  const metrics = await measure();
  await page.screenshot({ path: join(outDir, 'painted-bot.png') });
  await grabFrame();
  // The same frame with the paint taken off. Nothing else moves: the
  // simulation is manual by here, so any pixel that changes is a pixel the
  // paint was drawing.
  await page.evaluate((id) => {
    const bot = window.__paintball.characters.allBots.find((b) => b.id === id);
    bot.character.paint.clear();
  }, painted);
  // One step, not a fraction of a second: long enough for the cleared count to
  // reach the shader and short enough that the canopies behind the bot have
  // not swayed. `character-test` learned this the expensive way — a diff taken
  // across a third of a second measures the park, not the paint.
  await page.evaluate((s) => window.__paintball.stepSim(s), 1 / 60);
  const paintPixels = await diffFrame();
  await page.screenshot({ path: join(outDir, 'painted-bot-clean.png') });
  report.shots.push({ name: 'painted-bot', paintPixels, ...metrics });
}

// The results line-up, reached by running the clock out.
//
// Everybody is dressed for it first: scores from a fixed table rather than
// `Math.random`, so two passes of this rubric produce the same end card, and
// real paint on every body, because the whole reason this shot is worth taking
// is that it is the only framed close-up of seven painted characters in the
// game.
await page.evaluate(() => {
  const { game, match, characters, state } = window.__paintball;
  const V = state.position.constructor;

  characters.allCharacters.forEach((character, index) => {
    character.hitsGiven = [5, 1, 3, 1, 3, 2, 0][index] ?? 2;
    character.hitsTaken = [2, 2, 3, 6, 2, 4, 5][index] ?? 3;
    character.paint.clear();
  });

  for (const bot of characters.allBots) {
    for (let i = 0; i < 6; i++) {
      const angle = i * 1.05;
      bot.character.tickGameplay(5);
      game.events.emit('hit:character', {
        targetId: bot.id,
        shooterId: 'player',
        color: [0xff3d81, 0xa8e337, 0x00d4e8][i % 3],
        point: new V(
          bot.position.x + Math.sin(angle) * 0.35,
          bot.position.y + 0.9 + (i % 3) * 0.3,
          bot.position.z + Math.cos(angle) * 0.35,
        ),
        normal: new V(Math.sin(angle), 0, Math.cos(angle)),
        impactSpeed: 40,
      });
    }
  }

  match.timeLeft = 0.2;
});
await page.evaluate((s) => window.__paintball.stepSim(s), 0.5);
await page.waitForTimeout(2500);
const resultsMetrics = await measure();
await page.screenshot({ path: join(outDir, 'results.png') });
report.shots.push({ name: 'results', ...resultsMetrics });

await browser.close();

writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(report, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nload ${readyMs}ms   errors: ${errors.length || 'none'}\n`);
console.log(pad('shot', 20) + pad('warmth', 9) + pad('spread', 9) + pad('edges', 9) +
            pad('hues', 6) + pad('calls', 7) + pad('tris', 10) + 'paint');
for (const s of report.shots) {
  console.log(
    pad(s.name, 20) + pad(s.shadowWarmth, 9) + pad(s.lumaSpread, 9) +
    pad(s.edgeDensity, 9) + pad(s.hueSpread, 6) + pad(s.drawCalls, 7) +
    pad(s.triangles, 10) + (s.paintPixels ?? ''),
  );
}
console.log(`\nwritten to ${outDir}/`);
