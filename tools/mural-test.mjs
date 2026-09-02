/**
 * Headless tests for bots painting the mural.
 *
 * The claim under test is a strong one — that an NPC shooting a paintball
 * marker twenty times can leave something on a wall that a person would call a
 * drawing — and it rests on three things that are easy to get quietly wrong:
 *
 *   - the aim. A bot's fighting cone is 4.5 to 12 degrees, which at ten metres
 *     is a group well over a metre across. Drawing needs the marks to land
 *     within a splat's width of where the design says, which took both a much
 *     tighter cone and an elevation solve that flies the real flight model
 *     rather than the drag-free approximation the fighting aim uses. It matters
 *     more now than it did: the slots are corners, a third the width.
 *   - the slots. Two painters on one patch of board is one illegible painting.
 *   - **whether it ever happens.** This suite passed for a whole iteration while
 *     the feature was invisible in play. Everything below the catalogue used to
 *     run inside `isolate()`, which teleports the park into a state where a bot
 *     has nothing to shoot at — and that turned out to be the only state in
 *     which anybody ever picked up a brush. A measured natural round left three
 *     splats on an eleven-metre board. So the first case here is now a full
 *     300-second match with nothing moved, and it is the only one that speaks
 *     to the complaint the feature was rebuilt for.
 *
 * The differential case is still here and still the one that keeps the aim
 * honest, in the way `NEXT_5.md` argues every test of this kind has to be: it
 * measures the same drawing painted twice, once by a bot and once with the
 * fighting aim, and asserts the gap. A test that only checked "paint landed on
 * the board" would pass against either.
 *
 * Usage: node tools/mural-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

/**
 * Two query flags, and between them they are what makes a run repeatable.
 *
 * `manual` freezes the simulation clock before the first frame — see `main.ts`.
 * Claiming it through `setManualSim` after the page loads is a race the loop
 * sometimes wins, and a run that starts a tenth of a second into the round is a
 * different round.
 *
 * `seed` pins the loot, which is seeded from the wall clock on purpose so that
 * crates hide somewhere new every game. Left free, a round diverges the moment
 * the first bot goes restocking — about two minutes in, which is exactly where
 * the natural-round case below spends its time.
 */
const base = process.argv[2] ?? 'http://localhost:4173/';
const url = base + (base.includes('?') ? '&' : '?') + 'manual&seed=1';
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

// No opening click, unlike the other suites. It is there to take pointer lock
// for the keyboard, which nothing here uses — and it also fires a paintball,
// aimed wherever the camera had settled to by the time the loop was frozen.
// That single shot is enough to change the round: it lands near the bot twenty
// metres from spawn, and a bot that has been shot at behaves differently for
// the next three hundred seconds. The natural-round case is the one thing in
// this file that reads the park as it plays, so it gets the park untouched.

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const waitSim = (seconds) => page.evaluate((s) => window.__paintball.stepSim(s), seconds);

/** The corner box every painter now gets, in metres. See `PaintScreen`. */
const CORNER = await page.evaluate(() => {
  const slot = window.__paintball.paintScreen.slotAt(0);
  return { width: slot.widthMetres, height: slot.heightMetres, count: window.__paintball.paintScreen.slotCount };
});

// --- The catalogue --------------------------------------------------------
//
// Cheap, and it catches the authoring slip that is otherwise invisible until
// somebody watches a bot spend twenty seconds painting off the edge of its own
// slot: a design whose coordinates stray outside the unit square.
const catalogue = await page.evaluate((box) => {
  const { designs, designsForBox, dotsFor, letterDesign } = window.__paintball.mural;
  const side = Math.min(box.width, box.height);
  const letters = 'ABCDEFGH'.split('').map(letterDesign).filter(Boolean);
  // What a bot may actually be handed for a corner: the pictures that clear the
  // box, plus the initials that do. `Bot.layOutDrawing` applies exactly these
  // two filters, and a letter is not exempt from the second one — a B is denser
  // at this size than any picture in the catalogue.
  const offered = [...designsForBox(side), ...letters.filter((d) => d.minBox <= side)];
  const spacing = 2 * 0.34 * 0.8 * 0.7;   // baseSplatRadius, screenSplatScale, dotSpacing

  /**
   * How much of a design's own bounding area ends up inked.
   *
   * The proxy for legibility this catalogue is filtered on. Every mark is a
   * 54cm blob whatever the box is, so a smaller box does not draw a smaller
   * picture — it closes the gaps, and past some point the drawing is a disc.
   * Rasterised at 2cm, which is far finer than the answer needs.
   */
  const fillOf = (design, w, h, maxDots) => {
    const dots = dotsFor(design, w, h, spacing, maxDots).map(([x, y]) => [x * w, y * h]);
    const r = spacing / 0.7 / 2;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of dots) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    let inked = 0;
    let total = 0;
    for (let x = x0 - r; x <= x1 + r; x += 0.02) {
      for (let y = y0 - r; y <= y1 + r; y += 0.02) {
        total++;
        for (const [px, py] of dots) {
          if ((px - x) ** 2 + (py - y) ** 2 <= r * r) { inked++; break; }
        }
      }
    }
    return { fill: inked / total, marks: dots.length };
  };

  return {
    offered: offered.map((d) => d.name),
    all: [...designs, ...letters].map((design) => {
      const dots = dotsFor(design, box.width, box.height, spacing, 26);
      let outside = 0;
      for (const [x, y] of dots) if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) outside++;
      return { name: design.name, minBox: design.minBox, dots: dots.length, outside };
    }),
    // The two ends of the measurement: what the shipped catalogue costs at the
    // slot size the bots used to get, and what the corner set costs now.
    ceiling: Math.max(...designs.map((d) => fillOf(d, 4.73, 4.58, 56).fill)),
    held: [...designs, ...letters].filter((d) => !offered.includes(d)).map((d) => d.name),
    corner: offered.map((d) => ({
      name: d.name,
      ...fillOf(d, box.width, box.height, 26),
    })),
  };
}, CORNER);

const strays = catalogue.all.filter((d) => d.outside > 0);
check('every design stays inside its own square', strays.length === 0,
      strays.map((d) => `${d.name}: ${d.outside} marks outside`).join(', ') ||
      `${catalogue.all.length} designs checked`);

// The filter itself: what a bot may be handed for a corner, and whether any of
// it closes up at that size. The bar is the densest design in the shipped
// catalogue at the old slot size — a fill already accepted as readable.
const tooDense = catalogue.corner.filter((d) => d.fill > catalogue.ceiling);
check('every design offered for a corner still reads at that size',
      tooDense.length === 0,
      tooDense.map((d) => `${d.name} ${(d.fill * 100) | 0}%`).join(', ') ||
      `${catalogue.corner.length} offered, worst fill ${(Math.max(...catalogue.corner.map((d) => d.fill)) * 100) | 0}% ` +
      `against a ${(catalogue.ceiling * 100) | 0}% ceiling`);
check('the dense half of the catalogue is held back from corners',
      catalogue.held.length >= 8 && catalogue.offered.length >= 5,
      `at ${CORNER.width}x${CORNER.height}m a painter may draw ${catalogue.offered.join(', ')}; ` +
      `held back: ${catalogue.held.join(', ')}`);

const cornerMarks = catalogue.all.filter((d) => catalogue.offered.includes(d.name));
const budget = cornerMarks.filter((d) => d.dots < 8 || d.dots > 26);
check('every corner design fits the mark budget', budget.length === 0,
      budget.map((d) => `${d.name}: ${d.dots}`).join(', ') ||
      `${Math.min(...cornerMarks.map((d) => d.dots))}-${Math.max(...cornerMarks.map((d) => d.dots))} marks, ` +
      `${(Math.max(...cornerMarks.map((d) => d.dots)) * 0.32).toFixed(1)}s of standing still`);

// --- Natural rounds -------------------------------------------------------
//
// The case this suite did not have, and the one the whole rebuild is for.
// Nothing is teleported, nobody is isolated, the player stands at spawn and
// does nothing: full matches, exactly as they play.
//
// Three of them, because one is not an invariant. Whether a given round
// produces a drawing depends on which bots the whistle picked and where they
// spawned: a painter that starts in the plaza cluster is in contact for the
// whole five minutes and never gets the eight seconds of quiet the errand
// needs, while one that starts out west walks over and draws two. Measured
// across eight loot seeds after this was rebuilt, four rounds in eight produced
// a finished drawing and the board carried between 0 and 36 splats. Before it,
// the same measurement was three splats and no finished drawing at all — two
// bots started, neither got past the walk-in, and four of six never entered the
// state.
//
// So the bar is one finished drawing across three rounds, which the mechanism
// clears comfortably and a regression to anything like the old behaviour does
// not. Read this failing as "the errand is unreachable again".
const ROUNDS = 3;
const seasons = [];
for (let round = 0; round < ROUNDS; round++) {
  const cast = await page.evaluate(() =>
    window.__paintball.characters.allBots.filter((b) => b.isPainter).map((b) => b.id));
  check(`round ${round + 1}: one to three bots are designated painters at the whistle`,
        cast.length >= 1 && cast.length <= 3, `${cast.length}: ${cast.join(', ')}`);

  const rolls = new Set([cast.join(',')]);
  const designs = {};
  for (let t = 0; t < 292; t += 4) {
    await waitSim(4);
    const snap = await page.evaluate(() => {
      const { characters } = window.__paintball;
      return {
        roll: characters.allBots.filter((b) => b.isPainter).map((b) => b.id).join(','),
        bots: characters.allBots
          .filter((b) => b.isPainter)
          .map((b) => ({ id: b.id, design: b.muralDesign })),
      };
    });
    rolls.add(snap.roll);
    for (const b of snap.bots) if (b.design) (designs[b.id] ??= new Set()).add(b.design);
  }

  const tally = await page.evaluate(() => ({
    splats: window.__paintball.paintScreen.splatCount,
    done: Object.fromEntries(window.__paintball.characters.allBots
      .filter((b) => b.isPainter).map((b) => [b.id, b.muralsPainted])),
  }));
  seasons.push({ cast, rolls, designs, ...tally });
  check(`round ${round + 1}: the designation holds for the whole round`, rolls.size === 1,
        [...rolls].join(' -> '));

  // A fresh round in place, which re-rolls the painters — the same reset
  // `MatchSystem.restart` does, minus the game context it wants.
  if (round < ROUNDS - 1) {
    await page.evaluate(() => {
      const { match, characters, paintScreen } = window.__paintball;
      for (const id of match.ammo.keys()) match.ammo.set(id, 200);
      match.phase = 'playing';
      match.timeLeft = 300;
      match.endedBy = undefined;
      characters.resetScores();
      characters.respawnAll();
      paintScreen.clearFront();
    });
  }
}

const finished = seasons.reduce(
  (total, s) => total + Object.values(s.done).reduce((a, b) => a + b, 0), 0);
const report = seasons.map((s, i) =>
  `round ${i + 1} [${s.cast.join(', ')}] ` +
  `${Object.values(s.done).reduce((a, b) => a + b, 0)} finished, ${s.splats} splats` +
  (Object.values(s.designs).length
    ? ` (${[...new Set(Object.values(s.designs).flatMap((d) => [...d]))].join(', ')})`
    : '')).join('; ');

check('a designated painter finishes a drawing in rounds nobody interfered with',
      finished >= 1, report);
check('and the board carries the paint at the whistle',
      seasons.some((s) => s.splats >= 8), report);

// A fresh round from here: the matches above spend most of the park's paint,
// and a bot with nothing left cannot draw.
await page.evaluate(() => {
  const { match, paintScreen } = window.__paintball;
  for (const id of match.ammo.keys()) match.ammo.set(id, 200);
  match.phase = 'playing';
  match.timeLeft = 300;
  match.endedBy = undefined;
  paintScreen.clear();
});

// --- One bot, one board ---------------------------------------------------
//
// Now the measuring rig. The park is put in an unnatural state on purpose: the
// bot under test is given the board to itself, because measuring the aim wants
// a drawing on demand rather than one that turns up when the round allows it.
// Everything this rig establishes is about the *quality* of a drawing; whether
// one ever happens is the case above.
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
      // Designation is rolled at the whistle and this rig needs a known
      // painter, so it is set here rather than waited for.
      bot.isPainter = i === 0;
    });
  });
}
await isolate();

/**
 * Runs the sim until a bot has carried a drawing to its last mark, or time is
 * up, and reports the last drawing seen in progress.
 *
 * Completion is read off `muralsPainted` rather than off the last sampled
 * `muralProgress`: a corner drawing is eight seconds of firing, so a poll from
 * out here lands in the middle of it and the marks are gone by the next one.
 */
async function paintOnce(index = 0, limitSeconds = 60) {
  const before = await page.evaluate(
    (i) => window.__paintball.characters.allBots[i].muralsPainted, index);
  let record = null;
  for (let t = 0; t < limitSeconds; t += 2) {
    await waitSim(2);
    const snap = await page.evaluate((i) => {
      const bot = window.__paintball.characters.allBots[i];
      return {
        finishedCount: bot.muralsPainted,
        design: bot.muralDesign,
        slot: bot.muralSlotIndex,
        progress: bot.muralProgress,
        marks: bot.muralMarks.map((m) => ({ x: m.x, y: m.y, z: m.z })),
      };
    }, index);
    if (snap.design) record = snap;
    if (record && snap.finishedCount > before) return { ...record, finished: true };
  }
  return record ? { ...record, finished: false } : null;
}

const drawing = await paintOnce();
check('a bot with nothing to shoot at paints something',
      drawing !== null && drawing.design !== null,
      drawing ? `${drawing.design}, ${drawing.marks.length} marks, slot ${drawing.slot}` : 'nobody painted');
check('it finishes what it started',
      drawing !== null && drawing.finished,
      drawing ? `${drawing.design}, last seen at ${(drawing.progress * 100).toFixed(0)}%` : 'no drawing');

// --- The corner it was given, and the middle it was left ------------------
//
// The prompt's actual ask: a small thing in a corner, the rest of the board
// left for the player. Checked against the board's own slot geometry rather
// than against restated numbers, so it follows `PaintScreen` if that changes.
const inSlot = drawing ? await page.evaluate((marks) => {
  const { paintScreen, state } = window.__paintball;
  const V = state.position.constructor;
  const [boardWidth, boardHeight] = paintScreen.size;
  const bot = window.__paintball.characters.allBots[0];
  void bot;
  const uv = marks.map((m) => {
    const local = paintScreen.canvasMesh.worldToLocal(new V(m.x, m.y, m.z));
    return [local.x / boardWidth + 0.5, 0.5 - local.y / boardHeight];
  });
  const slots = [0, 1, 2, 3].map((i) => paintScreen.slotAt(i));
  // Which corner every mark lies in, if any — a hair of tolerance for the
  // half-pixel the uv round trip costs.
  const boxes = uv.map(([u, v]) =>
    slots.findIndex((s) =>
      Math.abs(u - s.u) <= s.halfU + 0.002 && Math.abs(v - s.v) <= s.halfV + 0.002));
  // The band down the middle the player is being left: everything between the
  // two columns of corner boxes.
  const edge = slots[0].u + slots[0].halfU;
  const central = uv.filter(([u]) => u > edge && u < 1 - edge).length;
  return { boxes, central, edge, uv };
}, drawing.marks) : null;

check('every mark of a corner drawing lands in one corner',
      inSlot !== null && inSlot.boxes.every((b) => b === inSlot.boxes[0] && b >= 0),
      inSlot
        ? `${inSlot.boxes.length} marks, all in corner ${inSlot.boxes[0]}` +
          (inSlot.boxes.some((b) => b < 0) ? ` (${inSlot.boxes.filter((b) => b < 0).length} outside)` : '')
        : 'no drawing');
check('and none of it lands in the band left for the player',
      inSlot !== null && inSlot.central === 0,
      inSlot ? `${(1 - 2 * inSlot.edge) * 100 | 0}% of the width kept clear` : '');

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
      // Distance from each painted pixel to the nearest mark the design asked
      // for, in metres. The statistic that actually separates a drawing from a
      // scatter at a corner's size: `share` and `coverage` both saturate once
      // the marks are packed into 2.8m, because a splat's own reach is most of
      // the box, but how far the paint strays does not.
      let errorSum = 0;
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
          let nearest = Infinity;
          for (let t = 0; t < targets.length; t++) {
            // The board is 16:9, so uv distance has to be unsquashed before it
            // means anything in metres.
            const d = Math.hypot(targets[t][0] - u, (targets[t][1] - v) * (9 / 16));
            if (d < nearest) nearest = d;
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
          errorSum += nearest * boardWidth;
        }
      }
      resolve({
        painted,
        onDrawing,
        share: painted === 0 ? 0 : onDrawing / painted,
        coverage: covered.filter(Boolean).length / Math.max(1, covered.length),
        error: painted === 0 ? 0 : errorSum / painted,
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
check('and it stays inside its own corner',
      painted !== null && painted.span > 0.05 && painted.span < 0.30,
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

  // Clear the ground in front of the board first. The painter is still standing
  // at its firing stance, which is where these shots are fired from and along —
  // a bot in the way swallows the control burst and the case scores an empty
  // board rather than a scatter.
  for (const bot of characters.allBots) bot.respawn(new V(30 + bot.position.x * 0, 0, 90));

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
  // Seeded, not `Math.random`. A corner drawing is twenty-odd marks, so a
  // random control swings by twenty points of every statistic between runs and
  // the threshold below would be measuring the roll rather than the aim.
  let seed = 0x51c14;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

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
    const angle = random() * Math.PI * 2;
    const spread = Math.tan(errorRad) * Math.sqrt(random());
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
// Judged on how far the paint strays from the design, which is the change the
// smaller box forces. A 7.5 degree cone at ten metres is a group about 2.6m
// across — as wide as the whole drawing box — so a wild shot still lands within
// a splat's reach of *somebody's* mark, and both `share` and `coverage` stay
// deceptively high on twenty-odd densely packed marks. Mean distance to the
// nearest mark does not saturate: it is a length, and the cone is a length.
check('the same marks fired with a fighting aim are not a drawing',
      painted !== null && scattered !== null && scattered.painted > 0 &&
      scattered.error > painted.error * 2,
      scattered
        ? `${loose} shots strayed ${(scattered.error * 100).toFixed(0)}cm from the design on ` +
          `average against ${(painted.error * 100).toFixed(0)}cm painted properly, and covered ` +
          `${(scattered.coverage * 100).toFixed(0)}% of its marks against ` +
          `${(painted.coverage * 100).toFixed(0)}%`
        : 'nothing landed');

// --- The board's four corners ---------------------------------------------
//
// Asked of the registry as well as of two bots. What the slots are for is both
// at once — two painters must never share a corner — and *successive* drawings:
// without least-recently-used hand-out, every picture a round produces lands in
// the same corner, on top of the last one. There is one more corner than there
// can be painters, which is what keeps that hand-out meaningful.
const slots = await page.evaluate(() => {
  const { paintScreen, characters, state } = window.__paintball;
  // Nobody real holding a lease first. A designated painter left in front of
  // the board will have claimed a corner back during the two seconds the case
  // above spends waiting for its shots to land, and this case would then find
  // one corner short and read it as the registry over-handing.
  const V = state.position.constructor;
  for (const bot of characters.allBots) bot.respawn(new V(40, 0, 100));
  paintScreen.clearFront();

  const ids = ['probe-a', 'probe-b', 'probe-c', 'probe-d', 'probe-e'];
  const handed = ids.map((id) => paintScreen.claimSlot(id)?.index ?? null);
  const repeat = paintScreen.claimSlot('probe-a')?.index ?? null;
  paintScreen.releaseSlot('probe-a');
  const afterRelease = paintScreen.claimSlot('probe-e')?.index ?? null;
  for (const id of ids) paintScreen.releaseSlot(id);
  return { handed, repeat, afterRelease, count: paintScreen.slotCount };
});
const taken = slots.handed.slice(0, slots.count);
check('two painters never share a patch of board',
      taken.every((i) => i !== null) && new Set(taken).size === slots.count &&
      slots.handed[slots.count] === null,
      `${slots.count} corners handed out as ${taken.join(', ')}, ` +
      `the next painter got ${slots.handed[slots.count]}`);
check('asking twice does not take another corner as well',
      slots.repeat === slots.handed[0], `re-claimed ${slots.repeat}`);
check('a released slot goes back into circulation',
      slots.afterRelease === slots.handed[0],
      `freed ${slots.handed[0]}, handed out ${slots.afterRelease}`);

// Successive drawings work round the corners, which is what stops a round's
// second picture landing on top of its first.
const rotation = await page.evaluate(() => {
  const { paintScreen } = window.__paintball;
  const order = [];
  for (let i = 0; i < paintScreen.slotCount + 1; i++) {
    const slot = paintScreen.claimSlot('probe');
    order.push(slot?.index ?? null);
    paintScreen.releaseSlot('probe');
  }
  return order;
});
check('successive drawings work round the corners',
      new Set(rotation.slice(0, 4)).size === 4,
      rotation.join(' → '));

// --- Breaking off, and coming back ----------------------------------------
//
// A painter stands still in the open with its back to the park, which is the
// best thing about the whole feature — but it has to stop painting when the
// round comes to it. What it must *not* do is throw the picture away: a bot
// that breaks off to fight and then comes back to finish its heart is the side
// quest; a bot that restarts from nothing and then sits out three quarters of a
// minute of cooldown is what the old design did on every sighting, and it is
// why a measured round produced two four-second entries and three splats.
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
  // Stand the player right in front of them. Inside `mural.breakOffRange`,
  // which is the bar now — a sighting across the meadow no longer counts.
  player.teleport(new V(bot.position.x + 3, bot.position.y + 1, bot.position.z + 3));
  return { id: bot.id, slot: bot.muralSlotIndex, design: bot.muralDesign, progress: bot.muralProgress };
});
if (interrupted) {
  await waitSim(2.5);
  const during = await page.evaluate((id) => {
    const bot = window.__paintball.characters.allBots.find((b) => b.id === id);
    return { state: bot.state, slot: bot.muralSlotIndex, hold: bot.muralOnHold, design: bot.muralDesign };
  }, interrupted.id);
  check('a painter stops painting when somebody stands in front of it',
        during.state !== 'muralist',
        `${interrupted.id}: state ${during.state}`);
  check('and it keeps the picture rather than throwing it away',
        during.hold && during.slot === interrupted.slot && during.design === interrupted.design,
        `holding ${during.design} in corner ${during.slot}` +
        (during.hold ? '' : ' — dropped it'));

  // Take the threat away and it should go back to the same corner and the same
  // drawing, rather than starting a new one somewhere else.
  await page.evaluate(() => {
    const { player, state } = window.__paintball;
    player.teleport(new (state.position.constructor)(20, 6, 80));
  });
  let resumed = null;
  for (let t = 0; t < 30 && !resumed; t += 2) {
    await waitSim(2);
    resumed = await page.evaluate((id) => {
      const bot = window.__paintball.characters.allBots.find((b) => b.id === id);
      if (bot.state !== 'muralist') return null;
      return { slot: bot.muralSlotIndex, design: bot.muralDesign, progress: bot.muralProgress };
    }, interrupted.id);
  }
  check('and goes back to the same corner and the same drawing',
        resumed !== null && resumed.slot === interrupted.slot &&
        resumed.design === interrupted.design && resumed.progress >= interrupted.progress,
        resumed
          ? `${resumed.design} in corner ${resumed.slot}, resumed at ` +
            `${(interrupted.progress * 100) | 0}% -> ${(resumed.progress * 100) | 0}%`
          : 'never came back');
} else {
  for (const name of [
    'a painter stops painting when somebody stands in front of it',
    'and it keeps the picture rather than throwing it away',
    'and goes back to the same corner and the same drawing',
  ]) check(name, false, 'nobody was painting to interrupt');
}

// --- Two painters, two corners, two colours -------------------------------
//
// The prompt's actual ask, and cheap to read off the canvas: a couple of NPCs
// leaving different-coloured marks in different corners of the same board.
// Every bot already carries its own index into `paintColors`, so this needs
// nothing beyond letting two of them have a turn.
//
// A turn each, not both at once, because both at once is not a thing this game
// produces: two painters in front of an eleven-metre board stand about seven
// metres apart, well inside `mural.breakOffRange`, so they see each other and
// break off — which is correct, and it is what the four corners and the
// least-recently-used hand-out are for. Successive drawings are the case.
await page.evaluate(() => {
  const { paintScreen } = window.__paintball;
  paintScreen.clear();
});

const turns = [];
for (const index of [0, 1]) {
  await page.evaluate((i) => {
    const { player, state, characters, paintScreen } = window.__paintball;
    const V = state.position.constructor;
    player.teleport(new V(40, 6, 100));
    const c = paintScreen.centre;
    characters.allBots.forEach((bot, j) => {
      if (j === i) bot.respawn(new V(c.x + 14, 0, c.z + 2));
      else bot.respawn(new V(60 + j * 9, 0, 110 + j * 4));
      bot.isPainter = j === i;
    });
  }, index);
  const turn = await paintOnce(index);
  const who = await page.evaluate(
    (i) => ({ id: window.__paintball.characters.allBots[i].id,
              color: window.__paintball.characters.allBots[i].character.color }), index);
  turns.push({ ...who, slot: turn?.slot ?? null, design: turn?.design ?? null,
               finished: Boolean(turn?.finished) });
}

check('two painters in turn take different corners',
      turns.every((t) => t.finished) && turns[0].slot !== turns[1].slot,
      turns.map((t) => `${t.id} drew ${t.design} in corner ${t.slot}`).join(', '));

// Read straight off the canvas: how many of the roster's paint colours are on
// it. Matched against `paintColors` rather than counted as clusters, because a
// splat's wet rim is a darkened copy of itself and would count twice.
const colours = await page.evaluate((wanted) => {
  const { paintScreen } = window.__paintball;
  const url = paintScreen.toDataURL();
  const targets = wanted.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const probe = document.createElement('canvas');
      probe.width = img.width;
      probe.height = img.height;
      const ctx = probe.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      const hits = targets.map(() => 0);
      for (let y = 0; y < img.height; y += 4) {
        for (let x = 0; x < img.width; x += 4) {
          const i = (y * img.width + x) * 4;
          const px = [data[i], data[i + 1], data[i + 2]];
          // Nearest of the two painters' colours, if either is close. The rim
          // darkens by 0.74, so the test is on direction rather than distance.
          let best = -1;
          let bestError = 0.22;
          targets.forEach(([r, g, b], t) => {
            const scale = (px[0] * r + px[1] * g + px[2] * b) / (r * r + g * g + b * b);
            if (scale < 0.5) return;
            const error = Math.hypot(px[0] - r * scale, px[1] - g * scale, px[2] - b * scale) / 255;
            if (error < bestError) { bestError = error; best = t; }
          });
          if (best >= 0) hits[best]++;
        }
      }
      resolve(hits);
    };
    img.onerror = () => resolve([]);
    img.src = url;
  });
}, turns.map((t) => t.color));
check('and they leave different colours on it',
      colours.length === 2 && colours.every((n) => n > 40),
      turns.map((t, i) => `${t.id} ${colours[i] ?? 0} sampled pixels`).join(', '));

check('no console or page errors', consoleErrors.length === 0, consoleErrors[0] ?? 'clean');

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
