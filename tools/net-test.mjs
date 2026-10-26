/**
 * Multiplayer tests: friends in the bots' places, through a real p3p2 server.
 *
 * Ported from the fifteen browser tests the multiplayer was built against,
 * which were archived with p3p2's games harness when p3p2 split. These are the
 * ones that need nothing but Chrome and a server; the case for a page on its
 * own (no room, no server asked anything) is in ui-test, so that it runs where
 * there is no server at all.
 *
 * Each case asks every page what it holds through
 * `window.__paintball.net.fingerprint()` and compares the pages. Whether it
 * looks and feels right is for a person.
 *
 * The server, in order of preference:
 *   - P3P2_DIR=<a p3p2 checkout>: that checkout's server, run with Node;
 *   - Docker, with the published image (P3P2_IMAGE, default p3p2/p3p2:0.2.0);
 *   - neither: the suite is skipped, and says so.
 * Each case gets a server of its own, in memory. p3p2's limits are per
 * address and every page here is on one, so cases sharing a server would eat
 * into each other's allowance.
 *
 * Usage: node tools/net-test.mjs [url]
 */
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join as path } from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173/';
const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const PORT = Number(process.env.P3P2_TEST_PORT ?? 18190);
const SERVER = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'net-test owner password';
const IMAGE = process.env.P3P2_IMAGE ?? 'p3p2/p3p2:0.2.0';
const CONTAINER = `dp-paintball-net-test-${PORT}`;
// Smaller than the other suites' 1024×576: up to three pages render at once
// here, and nothing in these cases reads the picture.
const VIEWPORT = { width: 800, height: 450 };

// --- The server ---------------------------------------------------------------

function serverKind() {
  if (process.env.P3P2_DIR) {
    const main = path(process.env.P3P2_DIR, 'server', 'src', 'main.ts');
    if (!existsSync(main)) throw new Error(`P3P2_DIR has no server/src/main.ts: ${process.env.P3P2_DIR}`);
    return { kind: 'checkout', main };
  }
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return { kind: 'image' };
  } catch {
    return null;
  }
}

const KIND = serverKind();
if (!KIND) {
  console.log('SKIP  net-test — no p3p2 server: set P3P2_DIR to a p3p2 checkout, or install Docker');
  process.exit(0);
}

const SETTINGS = {
  P3P2_PUBLIC_URL: SERVER,
  P3P2_DATA_DIR: ':memory:',
  P3P2_OWNER_PASSWORD: PASSWORD,
  P3P2_LOG_LEVEL: 'warn',
};

/** Whatever is running now, stopped at once: for a run that ends abruptly. */
let kill = () => {};
process.once('exit', () => kill());
process.once('SIGINT', () => process.exit(130));

const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Starts a fresh server, and returns what stops it. */
async function startServer() {
  let gone;
  let stop;
  if (KIND.kind === 'checkout') {
    // Node itself rather than `npm run`, so that the process stopped is the server.
    const child = spawn(process.execPath, [KIND.main], {
      env: { ...process.env, ...SETTINGS, P3P2_PORT: String(PORT), P3P2_HOST: '127.0.0.1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    gone = () => (child.exitCode !== null || child.signalCode !== null ? 'it exited' : null);
    kill = () => child.kill('SIGKILL');
    stop = () =>
      new Promise((resolve) => {
        if (gone()) return resolve();
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
  } else {
    try { docker('rm', '-f', CONTAINER); } catch { /* nothing left behind */ }
    const args = ['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${PORT}:8080`];
    for (const [key, value] of Object.entries(SETTINGS)) args.push('-e', `${key}=${value}`);
    docker(...args, IMAGE);
    const remove = () => { try { docker('rm', '-f', CONTAINER); } catch { /* already gone */ } };
    gone = () => {
      try {
        return docker('inspect', '-f', '{{.State.Running}}', CONTAINER) === 'true' ? null : 'the container stopped';
      } catch {
        return 'the container is gone';
      }
    };
    kill = remove;
    stop = async () => remove();
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const why = gone();
    if (why) throw new Error(`the p3p2 server did not start: ${why}`);
    const ok = await fetch(`${SERVER}/healthz`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() > deadline) throw new Error(`${SERVER}/healthz did not answer in 30s`);
    await sleep(100);
  }
  return async () => {
    await stop();
    kill = () => {};
  };
}

// --- The pages ----------------------------------------------------------------

/**
 * The real GPU where Chrome can reach one, as tools/perf.mjs launches it.
 *
 * Unlike the other suites, nothing here can be stepped: a room runs on the
 * wall clock, on several pages at once. SwiftShader gives each page a frame
 * every second or two, and at that rate a guest's join, the paint it draws
 * from the log and Playwright's own actions all take longer than any sensible
 * timeout. Measured on one machine: three pages in SwiftShader at 0.4–2.5fps;
 * three on its GPU, vsync on, at 60fps each. NET_GL=software forces the
 * fallback, which runs but is not expected to pass reliably.
 */
const COMMON = ['--disable-dev-shm-usage',
                // Several pages, each its own player, all of them meant to be in front.
                '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows'];
const GPU = ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist',
             '--enable-gpu-rasterization'];
const SOFTWARE = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];

async function launch() {
  if (process.env.NET_GL !== 'software') {
    const gpu = await chromium.launch({ executablePath: EXECUTABLE, args: [...GPU, ...COMMON] });
    const probe = await gpu.newPage();
    const renderer = await probe.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : '';
    });
    await probe.close();
    if (renderer && !/swiftshader|llvmpipe|software/i.test(renderer)) return { browser: gpu, renderer };
    await gpu.close();
  }
  console.log('WARN  no GPU: these cases run on the wall clock and SwiftShader is too slow for most of them');
  return { browser: await chromium.launch({ executablePath: EXECUTABLE, args: [...SOFTWARE, ...COMMON] }), renderer: 'SwiftShader' };
}

const { browser, renderer } = await launch();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Asks `read` until `ok` says yes, and returns the last answer; throws with the
 * last answer in the message when `timeout` runs out.
 */
async function poll(what, read, ok, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) throw new Error(`${what} — last: ${JSON.stringify(last)}`);
    await sleep(200);
  }
}

function must(pass, what) {
  if (!pass) throw new Error(what);
}

/** The pages of the case under way, closed at its end, with their errors. */
let contexts = [];
let pageErrors = [];

/** What the page knows of the room and the park, as plain numbers. */
const print = (page) => page.evaluate(() => window.__paintball.net.fingerprint());

/**
 * A player with a browser profile of their own, in the park, before the first click.
 * `delay`: every message between the page and the server is held back that many ms,
 * each way, as on a slow connection. On one machine there is next to none.
 */
async function arrive(at = url, { delay = 0 } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  contexts.push(context);
  if (delay > 0) {
    await context.routeWebSocket(() => true, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => setTimeout(() => server.send(message), delay));
      server.onMessage((message) => setTimeout(() => ws.send(message), delay));
    });
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(at);
  await poll('the park boots', () => page.evaluate(
    () => window.__paintball?.bootTimings().some((t) => t.phase === 'TOTAL') ?? false,
  ), Boolean, 60_000);
  return page;
}

const locked = (page) => page.evaluate(() => document.pointerLockElement !== null);

/**
 * Into the game with a click, as a player would: the pointer is the game's. A
 * browser refuses a lock for a moment after one is let go, so it is asked again
 * until it takes. After a round, the click is on Play again, which waits for it
 * to arm.
 */
async function play(page) {
  const deadline = Date.now() + 10_000;
  while (!(await locked(page))) {
    if (Date.now() > deadline) throw new Error('the pointer never locked');
    if (await page.locator('.pause.is-visible').isVisible()) await page.click('[data-pause-resume]');
    else if (await page.locator('.results.is-visible').isVisible()) await page.click('[data-results-again]');
    else await page.locator('canvas').first().click();
    await sleep(400);
  }
}

/** The pause card, as Esc brings it: the pointer is given back. */
async function pause(page) {
  if (!(await locked(page))) await play(page);
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('.pause.is-visible').waitFor({ timeout: 5000 });
}

/** The owner's side: logs in to the server's portal, creates a room for the game, and returns its invite link. */
async function createRoom(name) {
  const context = await browser.newContext();
  contexts.push(context);
  const portal = await context.newPage();
  // Not the server's address: once a room is on its front page, that is the front page.
  await portal.goto(`${SERVER}/login`);
  await portal.getByLabel('Password').fill(PASSWORD);
  await portal.getByRole('button', { name: 'Log in' }).click();
  await portal.getByLabel('Game URL').fill(url);
  await portal.getByLabel('Room name').fill(name);
  await portal.getByRole('button', { name: 'Create room' }).click();
  await portal.getByRole('heading', { name }).waitFor();
  const link = portal.getByLabel('Invite link', { exact: true });
  // A server before 0.2 makes no invite with the room: the owner creates it.
  if (!(await link.isVisible())) await portal.getByRole('button', { name: 'Create invite' }).click();
  return link.inputValue();
}

/** Somebody who opens the link: asked over the park, and says yes. */
async function answer(invite, name, options) {
  const page = await arrive(invite, options);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  return page;
}

/**
 * The first one in, by the link like everybody: the host. FRIENDS on the pause
 * card then has the same link to pass on.
 */
async function open(invite, name, options) {
  const page = await answer(invite, name, options);
  await poll('the host is in the room',
    () => page.evaluate(() => window.__paintball.net.room?.status ?? null), (s) => s === 'open');
  await pause(page);
  await page.click('[data-pause-friends]');
  const link = page.getByLabel('Invite link', { exact: true });
  await link.waitFor();
  const room = (u) => new URL(u).searchParams.get('room');
  const passOn = await link.inputValue();
  must(room(passOn) === room(invite), `FRIENDS passes on ${passOn}, not the room's invite`);
  await page.locator('p3p2-panel').getByRole('button', { name: 'Close' }).click();
  return page;
}

/** Somebody after the first: in a place of their own. */
async function join(invite, name, options) {
  const page = await answer(invite, name, options);
  await poll(`${name} takes a place`, async () => (await print(page)).seat, (s) => s > 0, 30_000);
  return page;
}

/**
 * A room, opened by the first of `names` and joined by the others, every one of them
 * playing. `options` go to every page's `arrive`.
 */
async function park(roomName, names, options) {
  const invite = await createRoom(roomName);
  const first = await open(invite, names[0], options);
  const pages = [first];
  for (const name of names.slice(1)) pages.push(await join(invite, name, options));
  for (const page of pages) await play(page);
  for (const page of pages) {
    await poll('every page sees the friends', async () =>
      (await print(page)).places.filter((p) => p.who === 'friend').length,
      (n) => n === names.length - 1, 30_000);
    await poll('the room has a round', async () => (await print(page)).round, (r) => r > 0, 30_000);
  }
  return { invite, pages };
}

/**
 * How far apart two pages draw the same places, in metres: the worst of them,
 * over everybody but the empty places.
 */
async function drift(a, b) {
  const [pa, pb] = [await print(a), await print(b)];
  let worst = 0;
  pa.places.forEach((spot, p) => {
    const other = pb.places[p];
    if (spot.who === 'empty' || other.who === 'empty') return;
    worst = Math.max(worst, Math.hypot(spot.x - other.x, spot.z - other.z));
  });
  return worst;
}

/** The scores and the paint, as every page should have them. */
async function ledger(page) {
  const s = await print(page);
  return JSON.stringify([s.round, s.over, s.splats, s.paint, s.places.map((p) => [p.given, p.taken])]);
}

/** Whether these pages have the same scores and the same paint. */
async function agree(pages) {
  const all = await Promise.all(pages.map(ledger));
  return new Set(all).size === 1;
}

const agreeing = (pages, timeout = 10_000) =>
  poll('the pages agree on scores and paint', () => agree(pages), Boolean, timeout);
const close = (a, b, timeout = 10_000) =>
  poll('the pages draw everybody in the same places', () => drift(a, b), (d) => d < 1.5, timeout);

/** Puts this page's player somewhere, standing still, facing along `yaw`. */
const stand = (page, x, z, yaw = 0) =>
  page.evaluate(([x, z, yaw]) => {
    const p = window.__paintball;
    p.player.teleport(p.state.position.clone().set(x, 0.2 + p.layout.heightAt(x, z), z));
    p.state.yaw = yaw;
  }, [x, z, yaw]);

/**
 * Fires one ball from this page's player, as its marker does: from the chest
 * towards `at` (a point, or the place of a figure, whose chest it aims at).
 * Returns false if there was nobody at that place.
 */
const shoot = (page, at) =>
  page.evaluate((at) => {
    const p = window.__paintball;
    const me = p.state.position;
    let target;
    if (typeof at === 'number') {
      const id = p.net.idOf(at);
      const bot = p.characters.allBots.find((b) => b.id === id);
      if (!bot) return false;
      target = bot.position.clone().set(bot.position.x, bot.position.y + 1.25, bot.position.z);
    } else {
      target = me.clone().set(at[0], at[1], at[2]);
    }
    const origin = me.clone().set(me.x, me.y + 1.3, me.z);
    const direction = target.clone().sub(origin).normalize();
    const color = p.characters.find('player').color;
    p.ballistics.fire(origin, direction, 'player', color, p.state.collider);
    p.game.events.emit('shot:fired', { shooterId: 'player', color, origin, direction });
    return true;
  }, at);

/**
 * `page` fires at the player in `place` until `judge` counts a tag from it: a
 * ball that a bot's tag beat by less than the grace second does not count, so
 * one ball is not always enough.
 */
async function tag(page, place, judge = page) {
  const seat = (await print(page)).seat;
  const before = (await print(judge)).places[seat].given;
  for (let i = 0; i < 5; i++) {
    must(await shoot(page, place), `nobody in place ${place} to shoot at`);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if ((await print(judge)).places[seat].given > before) return;
      await sleep(100);
    }
  }
  throw new Error(`no ball from place ${seat} counted on place ${place}`);
}

/** Puts a page in the background, or brings it back, as a hidden tab. */
const background = (page, hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

/** Whether any bot, on the host's page, is after the player in this place. */
const hunted = async (host, place) => (await print(host)).places.some((p) => p.aim === place);

const decals = (pages) => Promise.all(pages.map((page) => page.evaluate(() => window.__paintball.paint.splatCount)));

/**
 * Puts this page's player somewhere with 30m of open air ahead and none overhead, and
 * returns where to aim to send a ball down it; null if the park has no such place.
 */
const lane = (page) =>
  page.evaluate(() => {
    const p = window.__paintball;
    const physics = p.game.context.physics;
    const V = p.state.position.constructor;
    const clear = (from, to) => {
      const way = to.clone().sub(from);
      return !physics.raycast(from, way.clone().normalize(), way.length());
    };
    for (let x = -40; x <= 40; x += 4) {
      for (let z = -40; z <= 40; z += 4) {
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const y = p.layout.heightAt(x, z);
          const chest = new V(x, y + 1.3, z);
          const aim = chest.clone().add(new V(-Math.sin(yaw) * 30, 3, -Math.cos(yaw) * 30));
          if (!clear(chest, aim) || !clear(new V(x, y + 0.3, z), new V(x, y + 3.3, z))) continue;
          p.player.teleport(p.state.position.clone().set(x, 0.2 + y, z));
          p.state.yaw = yaw;
          return { x, z, aim: aim.toArray() };
        }
      }
    }
    return null;
  });

/**
 * From now on, this page notes each ball it flies for the figure in `place`: where it
 * was fired, and where this page first drew it, or null if it never did. `balls` reads
 * them.
 *
 * Reaches into the ballistics' pool: the ball a remote `shot:fired` is about is the one
 * the pool handed out just before it, and where it is drawn is only known inside
 * `update`, which has the frame's interpolation.
 */
const watchBalls = (page, place) =>
  page.evaluate((place) => {
    const p = window.__paintball;
    const ballistics = p.ballistics;
    const id = p.net.idOf(place);
    const seen = (window.__balls = []);
    let last = null;
    const acquire = ballistics.acquire.bind(ballistics);
    ballistics.acquire = () => (last = acquire());
    p.game.events.on('shot:fired', ({ shooterId, origin, remote }) => {
      if (!remote || shooterId !== id) return;
      const ball = { origin: origin.toArray(), drawn: null, over: false };
      seen.push(ball);
      // A ball that landed as it was fired is over before it was ever drawn.
      if (last?.active) last.watched = ball;
      else ball.over = true;
      last = null;
    });
    const update = ballistics.update.bind(ballistics);
    ballistics.update = (dt, alpha, ctx) => {
      update(dt, alpha, ctx);
      for (const projectile of ballistics.pool) {
        const ball = projectile.watched;
        if (!ball) continue;
        if (!projectile.active) {
          ball.over = true;
          projectile.watched = undefined;
        } else if (!ball.drawn) {
          ball.drawn = projectile.renderFrom.clone().lerp(projectile.renderTo, alpha).toArray();
        }
      }
    };
  }, place);

const balls = (page) => page.evaluate(() => window.__balls);

/**
 * Sends one shot from this page's player as `Net.fired` writes it, dated `age` ms ago:
 * from the chest, towards `at`. Nothing is fired on this page.
 */
const sendShot = (page, at, age) =>
  page.evaluate(([at, age]) => {
    const p = window.__paintball;
    const room = p.net.room;
    const me = p.state.position;
    const origin = [me.x, me.y + 1.3, me.z];
    const way = at.map((v, i) => v - origin[i]);
    const length = Math.hypot(...way);
    const bytes = new Uint8Array(25);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 2);
    view.setFloat64(1, room.now() - age);
    view.setUint8(9, 1);
    view.setUint8(10, p.net.seat);
    view.setUint16(11, 0);
    origin.forEach((v, i) => view.setInt16(13 + i * 2, Math.round(v * 100)));
    way.forEach((v, i) => view.setInt16(19 + i * 2, Math.round((v / length) * 32767)));
    return room.send('sh', bytes);
  }, [at, age]);

// --- The cases ----------------------------------------------------------------

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** NET_ONLY=<words>: only the cases whose names contain them. */
const ONLY = process.env.NET_ONLY?.toLowerCase();

/** Where in this file a failure was thrown, so that a timeout names its step. */
function where(error) {
  const line = String(error?.stack ?? '').split('\n').find((l) => l.includes('net-test.mjs'));
  return line?.match(/net-test\.mjs:(\d+)/)?.[1];
}

async function test(name, body) {
  if (ONLY && !name.toLowerCase().includes(ONLY)) return;
  contexts = [];
  pageErrors = [];
  const started = Date.now();
  let stopServer;
  try {
    stopServer = await startServer();
    const detail = await body();
    must(pageErrors.length === 0, `page error: ${pageErrors[0]}`);
    check(name, true, `${detail ? `${detail}, ` : ''}${((Date.now() - started) / 1000).toFixed(0)}s`);
  } catch (error) {
    const line = where(error);
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    check(name, false, `${message}${line ? ` (net-test.mjs:${line})` : ''}`);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await stopServer?.();
  }
}

console.log(`net-test against ${url}, with a p3p2 server from ${KIND.kind === 'checkout' ? process.env.P3P2_DIR : IMAGE}, on ${renderer}`);

await test('a host and a guest: the guest takes a bot’s place, and both pages have the same park', async () => {
  const { pages } = await park('Two in the park', ['Ada', 'Grace']);
  const [ada, grace] = pages;
  const a = await print(ada);
  const g = await print(grace);
  must(JSON.stringify([a.seat, a.host, g.seat, g.host]) === '[0,true,1,false]',
       `seats and hosts ${JSON.stringify([a.seat, a.host, g.seat, g.host])}`);
  must(a.places.map((p) => p.who).join() === 'me,friend,bot,bot,bot,bot,bot', `Ada sees ${a.places.map((p) => p.who)}`);
  must(g.places.map((p) => p.who).join() === 'friend,me,bot,bot,bot,bot,bot', `Grace sees ${g.places.map((p) => p.who)}`);
  must(g.round === a.round, `rounds ${a.round} and ${g.round}`);

  // Grace wears the colour of the place she took, on both pages; Ada wears hers.
  const colors = (page) => page.evaluate(() => {
    const p = window.__paintball;
    return [0, 1, 2].map((place) => p.characters.find(p.net.idOf(place)).color);
  });
  const [ca, cg] = [await colors(ada), await colors(grace)];
  must(JSON.stringify(ca) === JSON.stringify(cg), `colours ${ca} and ${cg}`);

  // The bots are where the host has them, and each player is where they are.
  const d = await close(ada, grace);
  // The same clock, the same scores, the same paint on the park.
  const [ta, tg] = await Promise.all([ada, grace].map((page) => page.evaluate(() => window.__paintball.match.timeLeft)));
  must(Math.abs(ta - tg) < 1, `clocks ${ta.toFixed(1)}s and ${tg.toFixed(1)}s`);
  await agreeing(pages);
  return `drift ${d.toFixed(2)}m, clocks ${Math.abs(ta - tg).toFixed(2)}s apart`;
});

await test('a guest’s ball that reaches the host counts on both pages, and so does the paint a ball leaves', async () => {
  const { pages } = await park('Shots in the park', ['Ada', 'Grace']);
  const [ada, grace] = pages;

  // Five metres apart on the plaza, Grace facing Ada.
  await stand(ada, 0, 6);
  await stand(grace, 0, 11);
  await poll('Grace sees Ada where she stands', async () => {
    const at = (await print(grace)).places[0];
    return Math.hypot(at.x, at.z - 6);
  }, (d) => d < 0.3);

  // Balls at Ada's chest: Grace judges them, and the room counts them, on Ada's page too.
  await tag(grace, 0, ada);
  await agreeing(pages);

  // Paint on the ground around Ada, from her own marker: on her page at once, on Grace's from the log.
  const splats = (await print(ada)).splats;
  for (let i = 0; i < 8; i++) await shoot(ada, [Math.sin(i) * 3, 0, 6 + Math.cos(i) * 3]);
  await poll('Ada’s paint reaches Grace', async () => (await print(grace)).splats, (n) => n >= splats + 8);
  await agreeing(pages);
  // Each page painted them: as decals on the park, not only as numbers. Paint
  // from the log goes on over a few frames, and the bots go on painting
  // meanwhile, so the two counts are compared until they meet.
  const counts = await poll('both pages paint the same decals', () => decals(pages),
    ([x, y]) => Math.abs(x - y) <= 2);
  return `${counts[0]} and ${counts[1]} decals`;
});

await test('over a slow connection, a friend’s ball leaves their marker on the other page; a shot that comes half a second late is not flown', async () => {
  // 50ms each way between each page and the server: a shot is a tenth of a second old
  // when it reaches the other page, and at 63 m/s a ball flies 6m in that time.
  const { pages } = await park('A slow connection', ['Ada', 'Grace'], { delay: 50 });
  const [ada, grace] = pages;
  const spot = await lane(ada);
  must(spot, 'no clear lane in the park for Ada to shoot down');
  await poll('Grace sees Ada where she stands', async () => {
    const at = (await print(grace)).places[0];
    return Math.hypot(at.x - spot.x, at.z - spot.z);
  }, (d) => d < 0.3);

  // Ten balls down the lane. Grace's page draws each from Ada's marker, as Ada's own
  // page does: a ball flies about a metre a frame, so its first frame is a metre or two out.
  await watchBalls(grace, 0);
  for (let i = 0; i < 10; i++) {
    await shoot(ada, spot.aim);
    await sleep(300);
  }
  const seen = await poll('Grace’s page flies Ada’s ten balls', () => balls(grace),
    (all) => all.length === 10 && all.every((b) => b.drawn || b.over));
  const out = seen.map((b) => (b.drawn ? Math.hypot(...b.drawn.map((v, i) => v - b.origin[i])) : Infinity));
  const never = out.filter((d) => d === Infinity).length;
  must(never === 0, `${never} of Ada’s balls were never drawn on Grace’s page`);
  must(Math.max(...out) < 3.5,
       `Grace’s page first drew Ada’s balls ${out.map((d) => d.toFixed(1)).join(', ')}m from where they were fired`);

  // A shot that comes over half a second late is not flown: what it did comes in the log.
  await sendShot(ada, spot.aim, 2000);
  await sleep(1500);
  must((await balls(grace)).length === 10, 'Grace’s page flew a shot fired two seconds ago');
  await sendShot(ada, spot.aim, 0);
  await poll('Grace’s page flies a shot that comes in time', async () => (await balls(grace)).length, (n) => n === 11);
  return `first drawn ${Math.min(...out).toFixed(1)}–${Math.max(...out).toFixed(1)}m out`;
});

await test('whoever comes later gets the park’s paint and the scores, from the room’s log', async () => {
  const { invite, pages } = await park('Paint that stays', ['Ada', 'Grace']);
  const [ada] = pages;
  await stand(ada, 0, 6);
  for (let i = 0; i < 40; i++) await shoot(ada, [Math.sin(i) * 4, 0, 6 + Math.cos(i) * 4]);
  await poll('Ada’s 40 balls are in the log', async () => (await print(ada)).splats, (n) => n >= 40);

  const edsger = await join(invite, 'Edsger');
  await play(edsger);
  pages.push(edsger);
  await agreeing(pages, 15_000);
  // A newcomer paints the park over a few frames, from the log; then each page has as many splats.
  await poll('Edsger paints the log’s splats', () => decals(pages), (all) => Math.min(...all) >= 40, 15_000);
  const all = await poll('every page has as many decals', () => decals(pages),
    (all) => Math.max(...all) - Math.min(...all) <= 4, 15_000);
  // Edsger took the next bot's place.
  const seat = (await print(edsger)).seat;
  must(seat === 2, `Edsger is in place ${seat}`);
  return `decals ${all.join(' / ')}`;
});

await test('the bots go for a guest, and their balls are judged on the guest’s page; not while the guest is away; a frozen host hands the bots on', async () => {
  const { pages } = await park('Bots', ['Ada', 'Grace', 'Edsger']);
  const [ada, grace, edsger] = pages;

  // Grace by the nearest bot to the plaza; Ada and Edsger far off in the north woods.
  const bot = (await print(ada)).places.find((p, i) => i > 2 && p.who === 'bot');
  await stand(grace, bot.x + 6, bot.z);
  for (const page of [ada, edsger]) await stand(page, -60, -110);
  await poll('a bot goes for Grace', () => hunted(ada, 1), Boolean, 30_000);
  // A bot's ball that reaches her is hers to judge, and the room counts it.
  await poll('a bot’s ball tags Grace', async () => (await print(ada)).places[1].taken, (n) => n > 0, 30_000);
  await agreeing(pages);

  // Her tab goes to the background: no bot is after her any more. Back, and they are again.
  await background(grace, true);
  await poll('no bot goes for Grace while she is away', () => hunted(ada, 1), (h) => !h);
  await sleep(2000);
  must(!(await hunted(ada, 1)), 'a bot went back for Grace while her tab was in the background');
  await background(grace, false);
  await poll('the bots go for Grace again when she is back', () => hunted(ada, 1), Boolean, 30_000);

  // Ada's page stops for six seconds, connected and in front. Within five the bots are Grace's to run.
  const before = (await print(grace)).places.map((p) => [p.x, p.z]);
  const stopped = Date.now();
  const frozen = ada.evaluate(() => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      // nothing, as a page stuck in a long task does nothing
    }
  });
  await poll('Grace becomes the host', async () => (await print(grace)).host, Boolean);
  const handover = Date.now() - stopped;
  must(handover < 5500, `the bots were handed on after ${handover}ms`);
  // Grace runs them from where they stood, and they move.
  await poll('the bots move on Grace’s page', async () =>
    (await print(grace)).places.filter((p, i) =>
      p.who === 'bot' && Math.hypot(p.x - before[i][0], p.z - before[i][1]) > 1).length,
    (n) => n > 0, 15_000);
  await frozen;
  await poll('Ada is no longer the host', async () => (await print(ada)).host, (h) => !h);
  await close(grace, edsger);
  await close(grace, ada);
  await agreeing(pages);
  return `handed on in ${(handover / 1000).toFixed(1)}s`;
});

await test('the round is the room’s: it ends for everybody, a guest’s Play again starts the next, and the park’s paint stays', async () => {
  const { pages } = await park('Rounds', ['Ada', 'Grace']);
  const [ada, grace] = pages;
  const board = (page) => page.evaluate(() => window.__paintball.paintScreen.splatCount);
  const phase = (page) => page.evaluate(() => window.__paintball.match.phase);

  // Ada paints the board, from six metres in front of it, and the ground.
  await ada.evaluate(() => {
    const p = window.__paintball;
    const { centre, normal } = p.paintScreen;
    const at = centre.clone().set(centre.x + normal.x * 6, 0, centre.z + normal.z * 6);
    p.player.teleport(at.set(at.x, 0.2 + p.layout.heightAt(at.x, at.z), at.z));
  });
  const centre = await ada.evaluate(() => {
    const c = window.__paintball.paintScreen.centre;
    return [c.x, c.y, c.z];
  });
  for (let i = 0; i < 4; i++) await shoot(ada, [centre[0] + (i - 1.5) * 0.6, centre[1], centre[2]]);
  await poll('four balls on the board, on both pages', () => Promise.all(pages.map(board)),
    (n) => n.join() === '4,4');
  await agreeing(pages);
  const splats = (await print(ada)).splats;
  const adaDecals = (await decals([ada]))[0];
  const round = (await print(ada)).round;

  // The clock runs out (the host says so; here, a little early). The whistle is everybody's.
  await ada.evaluate(() => window.__paintball.net.over('time'));
  for (const page of pages) {
    await poll('the round ends', () => phase(page), (p) => p === 'ended');
    await page.locator('.results.is-visible').waitFor({ timeout: 10_000 });
  }
  const over = (await print(grace)).over;
  must(over === 'time', `Grace's round ended for "${over}"`);

  // A click on the park is not Play again: a guest still shooting at the whistle
  // must not skip everybody's results.
  for (let i = 0; i < 4; i++) {
    await grace.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await sleep(150);
  }
  await sleep(1000);
  for (const page of pages) {
    must((await phase(page)) === 'ended' && (await print(page)).round === round,
         'a click on the park started the next round');
  }
  const label = (await grace.locator('[data-results-again]').textContent()).trim();
  must(label === 'Next round, for everyone', `Play again reads "${label}" in a room`);

  // Grace presses it: a new round for both, with clean scores and a clean board front.
  await play(grace);
  for (const page of pages) {
    await poll('the next round starts', async () => (await print(page)).round, (r) => r === round + 1);
    await poll('it is played', () => phase(page), (p) => p === 'playing');
    await poll('the board’s front is wiped', () => board(page), (n) => n === 0);
    const places = (await print(page)).places;
    must(places.every((p) => (p.given === 0 && p.taken === 0) || p.who === 'bot'),
         `scores carried over: ${JSON.stringify(places.map((p) => [p.who, p.given, p.taken]))}`);
  }
  // The park keeps its paint (and the bots go on adding to it).
  must((await print(grace)).splats >= splats, 'the park lost paint at the new round');
  must((await decals([ada]))[0] >= adaDecals, 'Ada’s page lost decals at the new round');
  await agreeing(pages);
});

await test('the host closes the page: the next player runs the bots, the round goes on, and the first place is empty', async () => {
  const { pages } = await park('Host leaves', ['Ada', 'Grace', 'Edsger']);
  const [ada, grace, edsger] = pages;
  await close(ada, grace);
  const round = (await print(grace)).round;
  const left = await grace.evaluate(() => window.__paintball.match.timeLeft);

  await ada.context().close();
  await poll('Grace becomes the host', async () => (await print(grace)).host, Boolean, 15_000);
  await poll('the first place empties on Grace’s page', async () => (await print(grace)).places[0].who,
    (w) => w === 'empty', 40_000);
  await poll('and on Edsger’s', async () => (await print(edsger)).places[0].who, (w) => w === 'empty');
  // The same round, its clock still running.
  must((await print(grace)).round === round, 'the round changed when the host left');
  const now = await grace.evaluate(() => window.__paintball.match.timeLeft);
  must(now < left, `the clock stopped at ${now.toFixed(1)}s`);
  await close(grace, edsger);
  await agreeing([grace, edsger]);
});

await test('a reload, of a guest and of the host: back in the same place, with the same park', async () => {
  const { pages } = await park('Reloads', ['Ada', 'Grace']);
  const [ada, grace] = pages;
  await stand(ada, 0, 6);
  for (let i = 0; i < 6; i++) await shoot(ada, [Math.sin(i) * 3, 0, 6 + Math.cos(i) * 3]);
  await agreeing(pages);

  for (const page of [grace, ada]) {
    const seat = (await print(page)).seat;
    await page.reload();
    await poll('back in the same place after a reload',
      () => page.evaluate(() => window.__paintball?.net?.seat ?? -2), (s) => s === seat, 60_000);
    await play(page);
    await agreeing(pages, 15_000);
    await close(ada, grace);
  }
  // A host that reloads hands the role on at once; one of the two has it.
  const hosts = [(await print(ada)).host, (await print(grace)).host].filter(Boolean).length;
  must(hosts === 1, `${hosts} hosts after the reloads`);
});

await test('a crate goes to the guest who walks onto it first, and is gone for everybody', async () => {
  const { pages } = await park('Crates', ['Ada', 'Grace']);
  const [ada, grace] = pages;
  const crates = (page) => page.evaluate(() => window.__paintball.loot.crates.map((c) => [c.position.x, c.position.z]));
  // The same crates on both pages, in whatever order each placed them. Not
  // "three": a bot out of paint may already have taken one, which stays gone
  // for its respawn time.
  const sorted = async (page) => JSON.stringify((await crates(page)).sort());
  await poll('the same crates on both pages', async () =>
    (await crates(grace)).length > 0 && (await sorted(grace)) === (await sorted(ada)), Boolean);

  const [x, z] = (await crates(grace))[0];
  const ammo = await grace.evaluate(() => window.__paintball.match.ammo.get('player'));
  await stand(grace, x, z);
  await poll('Grace gets the crate’s paint', () => grace.evaluate(() => window.__paintball.match.ammo.get('player')),
    (n) => n === ammo + 100);
  for (const page of pages) {
    await poll('the crate is gone', async () => (await crates(page)).some(([cx, cz]) => cx === x && cz === z), (h) => !h);
  }
});

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
