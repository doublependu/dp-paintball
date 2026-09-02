/**
 * Headless tests for bots painting the mural.
 *
 * The claim under test is a strong one — that an NPC shooting a paintball
 * marker forty times can leave something on a wall that a person would call a
 * drawing — and it rests on two things that are easy to get quietly wrong:
 *
 *   - the aim. A bot's fighting cone is 4.5 to 12 degrees, which at ten metres
 *     is a group well over a metre across. Drawing needs the marks to land
 *     within a splat's width of where the design says, which took both a much
 *     tighter cone and an elevation solve that flies the real flight model
 *     rather than the drag-free approximation the fighting aim uses.
 *   - the slots. Two painters on one patch of board is one illegible painting.
 *
 * So the middle case here is differential, in the way `NEXT_5.md` argues every
 * test of this kind has to be: it measures the same drawing painted twice, once
 * by a bot and once with the fighting aim, and asserts the gap. A test that only
 * checked "paint landed on the board" would pass against either.
 *
 * Usage: node tools/mural-test.mjs [url]
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

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const waitSim = (seconds) => page.evaluate((s) => window.__paintball.stepSim(s), seconds);

// --- The catalogue --------------------------------------------------------
//
// Cheap, and it catches the authoring slip that is otherwise invisible until
// somebody watches a bot spend twenty seconds painting off the edge of its own
// slot: a design whose coordinates stray outside the unit square.
const catalogue = await page.evaluate(() => {
  const { designs, dotsFor, letterDesign } = window.__paintball.mural;
  const all = [...designs, ...'ABCDEFGH'.split('').map(letterDesign).filter(Boolean)];
  return all.map((design) => {
    // The same call a bot makes: one slot of an 11m board, 45cm marks.
    const dots = dotsFor(design, 4.73, 4.58, 0.476 * 0.7, 56);
    let outside = 0;
    for (const [x, y] of dots) if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) outside++;
    return { name: design.name, dots: dots.length, outside };
  });
});
const strays = catalogue.filter((d) => d.outside > 0);
check('every design stays inside its own square', strays.length === 0,
      strays.map((d) => `${d.name}: ${d.outside} marks outside`).join(', ') ||
      `${catalogue.length} designs checked`);
const budget = catalogue.filter((d) => d.dots < 14 || d.dots > 56);
check('every design fits the mark budget', budget.length === 0,
      budget.map((d) => `${d.name}: ${d.dots}`).join(', ') ||
      `${Math.min(...catalogue.map((d) => d.dots))}-${Math.max(...catalogue.map((d) => d.dots))} marks`);

// --- One bot, one board ---------------------------------------------------
//
// The park is put in an unnatural state on purpose: a bot only paints when it
// has nothing to shoot at, so everybody else is sent to the far side of the map
// and the player with them. Left alone, six bots within sight of each other
// fight for the whole round and nobody ever picks up a brush — which is the
// intended behaviour and useless for measuring the brush.
async function isolate() {
  await page.evaluate(() => {
    const { player, state, characters, paintScreen } = window.__paintball;
    const V = state.position.constructor;
    player.teleport(new V(20, 6, 80));
    const c = paintScreen.centre;
    paintScreen.clear();
    characters.allBots.forEach((bot, i) => {
      if (i === 0) bot.respawn(new V(c.x + 14, 0, c.z + 2));
      else bot.respawn(new V(30 + i * 8, 0, 70 + i * 3));
    });
  });
}
await isolate();

/** Runs the sim until the first bot has finished a drawing, or time is up. */
async function paintOnce(limitSeconds = 60) {
  let record = null;
  for (let t = 0; t < limitSeconds; t += 2) {
    await waitSim(2);
    const snap = await page.evaluate(() => {
      const bot = window.__paintball.characters.allBots[0];
      return {
        state: bot.state,
        design: bot.muralDesign,
        slot: bot.muralSlotIndex,
        progress: bot.muralProgress,
        marks: bot.muralMarks.map((m) => ({ x: m.x, y: m.y, z: m.z })),
      };
    });
    if (snap.design) record = snap;
    if (record && snap.state !== 'muralist') return { ...record, finished: true };
  }
  return record ? { ...record, finished: false } : null;
}

const drawing = await paintOnce();
check('a bot with nothing to shoot at paints something',
      drawing !== null && drawing.design !== null,
      drawing ? `${drawing.design}, ${drawing.marks.length} marks, slot ${drawing.slot}` : 'nobody painted');
check('it finishes what it started',
      drawing !== null && drawing.finished && drawing.progress > 0.85,
      drawing ? `progress ${(drawing.progress * 100).toFixed(0)}%` : 'no drawing');

/**
 * How much of the paint on the board landed on the drawing.
 *
 * Reads the mural's own canvas and asks, of every painted pixel, whether it is
 * within a splat's reach of one of the marks the design asked for. A drawing
 * scores near 1; a scatter aimed at the same place scores much lower, because
 * its paint is spread over ground the design never asked for.
 *
 * Sampled every fourth pixel in each direction. This is 2048x1152 against fifty
 * marks, and the answer does not change in the fourth decimal place.
 */
const scoreAgainst = (marks) => page.evaluate((worldMarks) => {
  const { paintScreen, state } = window.__paintball;
  const V = state.position.constructor;
  const [boardWidth, boardHeight] = paintScreen.size;
  // The marks are world points; the picture is uv. `worldToLocal` on the front
  // plane is the same mapping `PaintScreen.onHit` uses in the other direction.
  const targets = worldMarks.map((m) => {
    const local = paintScreen.canvasMesh.worldToLocal(new V(m.x, m.y, m.z));
    return [local.x / boardWidth + 0.5, 0.5 - local.y / boardHeight];
  });

  const dataUrl = paintScreen.toDataURL();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const probe = document.createElement('canvas');
      probe.width = img.width;
      probe.height = img.height;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const base = [data[0], data[1], data[2]];
      // A splat's radius in uv, with a little tolerance for the wet rim.
      const reach = 0.032;
      let painted = 0;
      let onDrawing = 0;
      let minU = 1, maxU = 0;
      // Whether each mark the design asked for actually has paint on it. This
      // is the figure that separates a drawing from a scatter: paint fired at
      // the same place with a loose cone still lands in the same square metres,
      // so "is the paint near the design" barely moves — but it stops being
      // *on* the marks, and half of them come out bare.
      const covered = new Array(targets.length).fill(false);
      for (let y = 0; y < img.height; y += 4) {
        for (let x = 0; x < img.width; x += 4) {
          const i = (y * img.width + x) * 4;
          if (Math.abs(data[i] - base[0]) + Math.abs(data[i + 1] - base[1]) +
              Math.abs(data[i + 2] - base[2]) < 40) continue;
          painted++;
          const u = x / img.width;
          const v = y / img.height;
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          let near = false;
          for (let t = 0; t < targets.length; t++) {
            // The board is 16:9, so uv distance has to be unsquashed before it
            // means anything in metres.
            const d = Math.hypot(targets[t][0] - u, (targets[t][1] - v) * (9 / 16));
            if (d <= reach) near = true;
            // Paint on the mark's own centre, within a few centimetres. A
            // splat is 24cm across, so a shot that landed where it was aimed
            // covers its mark's centre and a shot that went 75cm wide does not
            // — which is the whole difference between the two arms, and it is
            // measured tightly because the alternative is a threshold that
            // drifts with how many marks the design happened to have.
            if (d <= reach * 0.15) covered[t] = true;
          }
          if (near) onDrawing++;
        }
      }
      resolve({
        painted,
        onDrawing,
        share: painted === 0 ? 0 : onDrawing / painted,
        coverage: covered.filter(Boolean).length / Math.max(1, covered.length),
        span: painted === 0 ? 0 : maxU - minU,
      });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}, marks);

const painted = drawing ? await scoreAgainst(drawing.marks) : null;
check('the paint on the board is the drawing',
      painted !== null && painted.share > 0.9 && painted.coverage > 0.9,
      painted
        ? `${(painted.share * 100).toFixed(1)}% of ${painted.painted} sampled pixels on the design, ` +
          `${(painted.coverage * 100).toFixed(0)}% of its marks covered`
        : 'nothing to score');
check('and it fills its half of the board',
      painted !== null && painted.span > 0.2 && painted.span < 0.52,
      painted ? `spans ${(painted.span * 100).toFixed(0)}% of the board's width` : '');

// --- The same drawing, with the aim a bot fights with ----------------------
//
// This is the control, and without it the case above is decorative: paint fired
// anywhere near an eleven-metre board lands on the board, and "the paint is on
// the board" is not "the paint is a picture".
//
// The shots are aimed the way `Bot.aimAndFire` aims — straight line plus the
// drag-free `0.5*g*t²` lift — and scattered by a `wanderer`'s 7.5 degree cone.
// Both halves of the difference matter and both are being measured together:
// the cone puts the marks in the wrong place, and the approximation puts all of
// them low.
const loose = drawing ? await page.evaluate((worldMarks) => {
  const { ballistics, paintScreen, state, characters, game } = window.__paintball;
  const V = state.position.constructor;
  paintScreen.clear();

  // Fired from a painter's stance rather than from wherever that bot has since
  // wandered to: ten metres out along the board's normal, at marker height.
  // The comparison is between two ways of aiming, so everything else about the
  // shot has to be the same for both.
  const c = paintScreen.centre;
  const n = paintScreen.normal;
  const stand = new V(c.x + n.x * 10, 0, c.z + n.z * 10);
  const muzzle = new V(
    stand.x,
    characters.navGrid.groundAt(stand.x, stand.z) + 1.18,
    stand.z,
  );
  const dir = new V();
  const right = new V();
  const up = new V();
  for (const m of worldMarks) {
    const mark = new V(m.x, m.y, m.z);
    dir.subVectors(mark, muzzle);
    const range = dir.length();
    // The fighting lift: gravity over a drag-free flight time.
    dir.y += 0.5 * 22 * Math.pow(range / 63, 2);
    dir.normalize();
    const errorRad = (7.5 * Math.PI) / 180 * (0.6 + range / 40);
    const angle = Math.random() * Math.PI * 2;
    const spread = Math.tan(errorRad) * Math.sqrt(Math.random());
    right.set(-dir.z, 0, dir.x).normalize();
    up.crossVectors(right, dir).normalize();
    dir.addScaledVector(right, Math.cos(angle) * spread)
       .addScaledVector(up, Math.sin(angle) * spread)
       .normalize();
    ballistics.fire(muzzle, dir, 'probe', 0xff3d81);
  }
  void game;
  return worldMarks.length;
}, drawing.marks) : 0;
await waitSim(2.0);

const scattered = drawing ? await scoreAgainst(drawing.marks) : null;
check('the same marks fired with a fighting aim are not a drawing',
      painted !== null && scattered !== null && scattered.painted > 0 &&
      scattered.coverage < painted.coverage - 0.25,
      scattered
        ? `${loose} shots covered ${(scattered.coverage * 100).toFixed(0)}% of the marks, ` +
          `against ${(painted.coverage * 100).toFixed(0)}% painted properly`
        : 'nothing landed');

// --- The board's two halves -----------------------------------------------
//
// Asked of the registry rather than of two bots, deliberately. Two painters in
// front of the same board in an open meadow can see each other, and a bot that
// can see somebody stops painting and fights — so a scenario with two of them
// drawing at once is one this game will almost never produce. What the slots
// are actually for is *successive* drawings: without them every picture a round
// produces lands on the same half of the board, on top of the last one.
const slots = await page.evaluate(() => {
  const { paintScreen } = window.__paintball;
  const first = paintScreen.claimSlot('probe-a');
  const second = paintScreen.claimSlot('probe-b');
  const third = paintScreen.claimSlot('probe-c');
  const repeat = paintScreen.claimSlot('probe-a');
  paintScreen.releaseSlot('probe-a');
  const afterRelease = paintScreen.claimSlot('probe-c');
  // Put the board back the way it was found.
  for (const id of ['probe-a', 'probe-b', 'probe-c']) paintScreen.releaseSlot(id);
  return {
    first: first?.index ?? null,
    second: second?.index ?? null,
    third: third?.index ?? null,
    repeat: repeat?.index ?? null,
    afterRelease: afterRelease?.index ?? null,
  };
});
check('two painters never share a patch of board',
      slots.first !== null && slots.second !== null && slots.first !== slots.second &&
      slots.third === null,
      `slots ${slots.first} and ${slots.second}, a third painter got ${slots.third}`);
check('asking twice does not take the other half as well',
      slots.repeat === slots.first, `re-claimed ${slots.repeat}`);
check('a released slot goes back into circulation',
      slots.afterRelease === slots.first, `freed ${slots.first}, handed out ${slots.afterRelease}`);

// Successive drawings alternate, which is what stops a round's second picture
// landing on top of its first.
const rotation = await page.evaluate(() => {
  const { paintScreen } = window.__paintball;
  const order = [];
  for (let i = 0; i < 4; i++) {
    const slot = paintScreen.claimSlot('probe');
    order.push(slot?.index ?? null);
    paintScreen.releaseSlot('probe');
  }
  return order;
});
check('successive drawings go to opposite halves',
      new Set(rotation).size === 2 && rotation[0] !== rotation[1],
      rotation.join(' → '));

// --- Somebody to shoot at beats something to draw --------------------------
//
// A painter stands still in the open with its back to the park, which is the
// best thing about the whole feature — but it has to stop painting when the
// round comes to it, and it has to hand its slot back when it does.
await isolate();
let painter = null;
for (let t = 0; t < 40 && !painter; t += 2) {
  await waitSim(2);
  painter = await page.evaluate(() =>
    window.__paintball.characters.allBots.some((b) => b.state === 'muralist'));
}

const interrupted = await page.evaluate(() => {
  const { characters, state, player } = window.__paintball;
  const bot = characters.allBots.find((b) => b.state === 'muralist');
  if (!bot) return null;
  const V = state.position.constructor;
  // Stand the player right in front of them.
  player.teleport(new V(bot.position.x + 3, bot.position.y + 1, bot.position.z + 3));
  return { id: bot.id, slot: bot.muralSlotIndex };
});
if (interrupted) {
  await waitSim(2.5);
  const after = await page.evaluate((id) => {
    const bot = window.__paintball.characters.allBots.find((b) => b.id === id);
    return { state: bot.state, slot: bot.muralSlotIndex };
  }, interrupted.id);
  check('a painter drops it when somebody turns up, and gives the slot back',
        after.state !== 'muralist' && after.slot === null,
        `${interrupted.id}: slot ${interrupted.slot} -> ${after.slot}, state ${after.state}`);
} else {
  check('a painter drops it when somebody turns up, and gives the slot back',
        false, 'nobody was painting to interrupt');
}

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
