/**
 * Plays whole rounds with nobody watching and reports how they went.
 *
 * `record-match.mjs` makes one round worth looking at. This makes several worth
 * counting: the same autopilot, under the `play` policy by default — no
 * wallhack, no sightseeing schedule — so the numbers describe a player who has
 * to find the bots rather than one who is always walking straight at them.
 * Nothing is rendered on purpose; the sim is stepped as fast as it will go.
 *
 * It exists because every claim about how the game plays used to rest on one
 * round, played by an autopilot that cheats. A table over several seeds is the
 * least that should stand behind "fights never end" or "the bots barely paint".
 *
 * It is deliberately not part of `npm test`: a round takes minutes, and its
 * numbers move with the seed. It is what tuning is judged against.
 *
 * Usage: node tools/playtest.mjs [--seeds N] [--seed-list a,b,c] [--policy play|film]
 *          [--round SECONDS] [--label NAME] [--url URL]
 *
 *   --seeds       how many rounds, on seeds 1..N (default 5)
 *   --seed-list   exactly these seeds instead
 *   --label       output name: captures/playtest/<label>.json (default: latest)
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const POLICY = opt('policy', 'play');
const ROUND = opt('round', null) === null ? null : Number(opt('round'));
const URL = opt('url', 'http://localhost:4173/');
const LABEL = opt('label', 'latest');
const SEEDS = opt('seed-list', null)
  ? opt('seed-list').split(',').map(Number)
  : Array.from({ length: Number(opt('seeds', 5)) }, (_, i) => i + 1);
const OUT = resolve('captures/playtest');
const FPS = 30;
/** Simulated seconds per page round trip. Long enough that the trip is noise. */
const CHUNK = 10;

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
         '--disable-dev-shm-usage'],
});

async function playRound(seed) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${URL}?manual&seed=${seed}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                             { timeout: 120_000 });
  await page.evaluate(([policy, seed]) => {
    window.__autopilotConfig = { policy, seed };
  }, [POLICY, seed]);
  await page.addScriptTag({ path: 'tools/autopilot.js' });

  // The game-side half of the ledger: what everybody else did, which the
  // autopilot has no reason to track.
  await page.evaluate((round) => {
    const p = window.__paintball;
    const { match, stepSim, characters, game } = p;
    p.game.events.emit('input:lockChanged', { locked: true });
    // Settle the first frame, then put the clock back so the round is whole.
    const full = match.timeLeft;
    stepSim(0.25);
    match.timeLeft = round ?? full;

    const ledger = {
      shots: {},
      botStates: {},
      painterStall: {},
      painterWalk: {},
      painters: characters.allBots.filter((b) => b.isPainter).map((b) => b.id),
      boardSplats: 0,
    };
    for (const c of characters.allCharacters) ledger.shots[c.id] = 0;
    for (const b of characters.allBots) ledger.botStates[b.id] = {};
    game.events.on('shot:fired', (e) => { ledger.shots[e.shooterId] = (ledger.shots[e.shooterId] ?? 0) + 1; });
    const last = new Map(characters.allBots.map((b) => [b.id, b.position.clone()]));

    // Called once per autopilot frame.
    ledger.sample = (dt) => {
      for (const b of characters.allBots) {
        const s = ledger.botStates[b.id];
        s[b.state] = (s[b.state] ?? 0) + dt;
        if (b.state === 'muralist') {
          const stance = b.muralStance;
          const far = Math.hypot(b.position.x - stance.x, b.position.z - stance.z) > 2.5;
          const moved = b.position.distanceTo(last.get(b.id));
          if (far) ledger.painterWalk[b.id] = (ledger.painterWalk[b.id] ?? 0) + dt;
          // On the way to the board and not getting any closer: the stall
          // plan 8 found, where a painter stood a hundred metres out until its
          // timer ran down.
          if (far && moved < 0.02) ledger.painterStall[b.id] = (ledger.painterStall[b.id] ?? 0) + dt;
        }
        last.get(b.id).copy(b.position);
      }
      if (match.phase === 'playing') ledger.boardSplats = p.paintScreen.splatCount;
    };
    window.__ledger = ledger;
  }, ROUND);

  const started = Date.now();
  for (;;) {
    const phase = await page.evaluate(([seconds, fps]) => {
      const { match } = window.__paintball;
      const dt = 1 / fps;
      for (let i = 0; i < seconds * fps && match.phase !== 'ended'; i++) {
        window.__autopilot.frame(dt);
        window.__ledger.sample(dt);
      }
      return match.phase;
    }, [CHUNK, FPS]);
    if (phase === 'ended') break;
    if ((Date.now() - started) / 1000 > 1800) throw new Error(`seed ${seed}: round did not end`);
  }

  const result = await page.evaluate(() => {
    const { characters, match } = window.__paintball;
    const ap = window.__autopilot;
    const ledger = window.__ledger;
    const people = characters.allCharacters.map((c) => ({
      id: c.id,
      given: c.hitsGiven,
      taken: c.hitsTaken,
      shots: ledger.shots[c.id] ?? 0,
    }));
    const bots = characters.allBots.map((b) => ({
      id: b.id,
      painter: b.isPainter,
      drawings: b.muralsPainted,
      states: Object.fromEntries(Object.entries(ledger.botStates[b.id]).map(([k, v]) => [k, +v.toFixed(1)])),
      painterWalk: +(ledger.painterWalk[b.id] ?? 0).toFixed(1),
      painterStall: +(ledger.painterStall[b.id] ?? 0).toFixed(1),
    }));
    return {
      roundSeconds: +ap.t.toFixed(1),
      endedBy: match.endedBy,
      player: {
        ...ap.metrics,
        time: Object.fromEntries(Object.entries(ap.metrics.time).map(([k, v]) => [k, +v.toFixed(1)])),
        firstContact: ap.metrics.firstContact === null ? null : +ap.metrics.firstContact.toFixed(1),
        longestQuiet: +Math.max(ap.metrics.longestQuiet, ap.target ? 0 : ap.t - ap.quietSince).toFixed(1),
        wetCameraFrames: ap.wetCameraFrames,
        cameraInsideFrames: ap.cameraInsideFrames,
      },
      people,
      bots,
      painters: ledger.painters,
      boardSplats: ledger.boardSplats,
      log: ap.log,
    };
  });
  result.seed = seed;
  result.policy = POLICY;
  result.wallSeconds = Math.round((Date.now() - started) / 1000);
  result.errors = errors;
  await page.close();
  return result;
}

// --- run -----------------------------------------------------------------------
const rounds = [];
console.log(`playtest: ${SEEDS.length} round(s), policy ${POLICY}, seeds ${SEEDS.join(',')}`);
for (const seed of SEEDS) {
  const r = await playRound(seed);
  rounds.push(r);
  const me = r.people.find((p) => p.id === 'player');
  console.log(`  seed ${seed}: ${r.roundSeconds}s in ${r.wallSeconds}s wall — player ${me.given}/${me.taken}, ` +
              `${r.player.fights} fights, board ${r.boardSplats} splats` +
              (r.errors.length ? `, ${r.errors.length} page errors` : ''));
}
await browser.close();

// --- the table ------------------------------------------------------------------
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const fmt = (x, d = 1) => (x === null || Number.isNaN(x) ? '-' : x.toFixed(d));
const rows = [];
const row = (label, per, digits = 1) => {
  const values = rounds.map(per);
  const numeric = values.filter((v) => v !== null);
  rows.push([label, ...values.map((v) => fmt(v, digits)), fmt(numeric.length ? mean(numeric) : null, digits)]);
};

const minutes = (r) => r.roundSeconds / 60;
const me = (r) => r.people.find((p) => p.id === 'player');
const botsOf = (r) => r.people.filter((p) => p.id !== 'player');

row('player tags given', (r) => me(r).given, 0);
row('player tagged', (r) => me(r).taken, 0);
row('player tagged / min', (r) => me(r).taken / minutes(r));
row('player accuracy %', (r) => (100 * me(r).given) / Math.max(1, r.player.shots));
row('player rank (1 = most tags)', (r) =>
  1 + r.people.filter((p) => p.id !== 'player' && p.given > me(r).given).length, 0);
row('bot accuracy %', (r) => (100 * botsOf(r).reduce((a, p) => a + p.given, 0)) /
  Math.max(1, botsOf(r).reduce((a, p) => a + p.shots, 0)));
row('bot tags on player %', (r) => (100 * me(r).taken) /
  Math.max(1, r.people.reduce((a, p) => a + p.taken, 0)));
row('first contact (s)', (r) => r.player.firstContact);
row('fights', (r) => r.player.fights, 0);
row('  ended: lost sight', (r) => r.player.fightEnds.lost, 0);
row('  ended: 16s limit', (r) => r.player.fightEnds.timeout, 0);
row('  ended: went for paint', (r) => r.player.fightEnds.paint, 0);
row('  ended: stuck / ammo', (r) => r.player.fightEnds.stuck + r.player.fightEnds.ammo, 0);
row('time fighting %', (r) => (100 * r.player.time.fight) / r.roundSeconds);
row('time travelling %', (r) => (100 * r.player.time.travel) / r.roundSeconds);
row('time restocking %', (r) => (100 * r.player.time.restock) / r.roundSeconds);
row('time idle %', (r) => (100 * r.player.time.idle) / r.roundSeconds);
row('longest without a fight (s)', (r) => r.player.longestQuiet);
row('crates taken by player', (r) => r.player.crates, 0);
row('player stuck events', (r) => r.player.stuck, 0);
row('rescue teleports', (r) => r.player.rescues, 0);
row('camera inside geometry (frames)', (r) => r.player.cameraInsideFrames, 0);
row('camera under water (frames)', (r) => r.player.wetCameraFrames, 0);
row('painters', (r) => r.painters.length, 0);
row('drawings finished', (r) => r.bots.reduce((a, b) => a + b.drawings, 0), 0);
row('board splats at whistle', (r) => r.boardSplats, 0);
row('painter walk-in stalled (s)', (r) => r.bots.reduce((a, b) => a + b.painterStall, 0));
row('page errors', (r) => r.errors.length, 0);

const header = ['', ...rounds.map((r) => `seed ${r.seed}`), 'mean'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
console.log('\n' + line(header));
for (const r of rows) console.log(line(r));

mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${LABEL}.json`);
writeFileSync(file, JSON.stringify({ policy: POLICY, seeds: SEEDS, table: { header, rows }, rounds }, null, 2));
console.log(`\n-> ${file}`);
