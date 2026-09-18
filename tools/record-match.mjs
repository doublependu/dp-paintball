/**
 * One whole round, recorded start to finish, with its own sound.
 *
 * `tools/record.mjs` shoots a choreographed montage. This shoots the other kind
 * of video: a title card, the full five-minute round played by
 * `tools/autopilot.js` against the bots as they are, and the results card at
 * the end. Nothing is staged and nothing is cut.
 *
 * Frames are stepped exactly as in record.mjs — manual sim, 1/fps per frame —
 * so the footage runs at a perfectly even rate however long a screenshot takes.
 *
 * Sound is the game's own synth, rendered offline. `AudioContext` is swapped
 * before the page loads for an `OfflineAudioContext` whose `currentTime` is the
 * *simulation* clock. Every sound the game schedules therefore lands at the sim
 * time it happened, and rendering the context once the round is over yields a
 * soundtrack that lines up with the frames sample for sample, which a real-time
 * capture of a browser that is taking 75ms per frame never could.
 *
 * Usage: node tools/record-match.mjs [--out DIR] [--fps N] [--seed N]
 *          [--round SECONDS] [--dry] [--no-encode] [--url URL]
 *
 *   --round   shorten the round, for test runs (default: the full 300s)
 *   --dry     simulate the round without screenshots and write the log only;
 *             sample stills every ten seconds so the play can be judged
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = resolve(opt('out', 'captures/match'));
const FPS = Number(opt('fps', 30));
const WIDTH = Number(opt('width', 1920));
const HEIGHT = Number(opt('height', 1080));
const SEED = Number(opt('seed', 20260917));
const ROUND = opt('round', null) === null ? null : Number(opt('round'));
const URL = opt('url', 'http://localhost:4173/');
const DRY = flag('dry');
const ENCODE = !flag('no-encode') && !DRY;

const PREROLL = 3.5;
const RESULTS = 14;
const DT = 1 / FPS;
const FRAMES = join(OUT, 'frames');
const SAMPLE_RATE = 48000;

const EXECUTABLE =
  process.env.CHROME_PATH ??
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!EXECUTABLE) throw new Error('No system Chrome found. Set CHROME_PATH.');

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist',
         '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// --- sound on the simulation clock -------------------------------------------
const audioSeconds = PREROLL + (ROUND ?? 300) + RESULTS + 5;
await page.addInitScript(([sampleRate, seconds]) => {
  window.__simAudio = { offset: 0, ctx: null };
  class SimAudioContext extends OfflineAudioContext {
    constructor() {
      super({ numberOfChannels: 2, length: Math.ceil(sampleRate * seconds), sampleRate });
      window.__simAudio.ctx = this;
    }
    get currentTime() {
      const p = window.__paintball;
      return p ? Math.max(0, p.simTime() - window.__simAudio.offset) : 0;
    }
    get state() { return 'running'; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    realSuspend(t) { return OfflineAudioContext.prototype.suspend.call(this, t); }
    realResume() { return OfflineAudioContext.prototype.resume.call(this); }
  }
  window.AudioContext = SimAudioContext;

  /**
   * Renders the soundtrack a few seconds behind the simulation, not all at the
   * end.
   *
   * Rendered in one go after the round, the context holds every voice the game
   * ever scheduled — tens of thousands of gains and panners, all pulled on
   * every quantum whether their sound has started yet or not — and five
   * minutes of it did not finish in ten. Rendering as the round goes lets
   * finished voices be collected, so the graph only ever holds the last few
   * seconds. The lag has to exceed nothing but scheduling jitter: every sound
   * is scheduled at the sim time it happens, which is always ahead of here.
   */
  const LAG = 2;
  const QUANTUM = 128 / sampleRate;
  const audio = window.__simAudio;
  audio.start = () => {
    const ctx = audio.ctx;
    audio.position = 0;
    audio.suspended = false;
    const stopAt = (t) => {
      audio.suspended = false;
      ctx.realSuspend(t).then(() => { audio.position = t; audio.suspended = true; });
    };
    audio.pump = (now) => {
      if (!audio.suspended) return;
      const target = Math.floor((now - LAG) / QUANTUM) * QUANTUM;
      if (target <= audio.position + 0.25) return;
      stopAt(target);
      ctx.realResume();
    };
    stopAt(Math.max(QUANTUM, Math.floor(0.5 / QUANTUM) * QUANTUM));
    audio.rendered = ctx.startRendering();
  };
  audio.finish = async () => {
    // Wait for the last suspend to land, then run to the end of the buffer.
    while (!audio.suspended) await new Promise((r) => setTimeout(r, 20));
    audio.ctx.realResume();
    return audio.rendered;
  };
}, [SAMPLE_RATE, audioSeconds]);

// `manual` from the first frame, so the round has not moved a step before the
// recording owns the clock; `seed` so the crates and muralists are this run's.
const url = `${URL}?manual&seed=${SEED}`;
console.log(`${DRY ? 'dry run' : `recording ${WIDTH}x${HEIGHT} @ ${FPS}fps`} -> ${OUT}  (${url})`);
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__paintball && !document.querySelector('#loader'),
                           { timeout: 120_000 });
// The loader fades out on wall clock.
await page.waitForTimeout(900);

// CSS transitions run on wall clock while everything else runs on the stepped
// sim. At ~75ms a frame they would play at twice speed in the video; slowing
// the document's animation clock by the same ratio keeps them honest.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Animation.enable');
const setAnimationRate = (rate) => cdp.send('Animation.setPlaybackRate', { playbackRate: rate });

await page.addScriptTag({ path: 'tools/autopilot.js' });
if (ROUND !== null) await page.evaluate((r) => { window.__paintball.match.timeLeft = r; }, ROUND);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

let frameIndex = 0;
let lastShotAt = Date.now();
const wallPerFrame = [];
async function shoot() {
  if (DRY) { frameIndex++; return; }
  await page.screenshot({
    path: join(FRAMES, `${String(frameIndex).padStart(6, '0')}.jpg`),
    type: 'jpeg',
    quality: 93,
  });
  frameIndex++;
  const now = Date.now();
  wallPerFrame.push(now - lastShotAt);
  lastShotAt = now;
  // Re-fit the animation clock to the pace actually being achieved.
  if (frameIndex % 60 === 0) {
    const recent = wallPerFrame.slice(-60).reduce((a, b) => a + b, 0) / 60;
    await setAnimationRate(Math.min(1, (1000 / FPS) / recent));
  }
}

// --- title card ----------------------------------------------------------------
await page.evaluate(() => {
  const card = document.createElement('div');
  card.id = 'video-title';
  card.innerHTML = `
    <div class="t1">Central Park Paintball</div>
    <div class="t2">one full round &middot; five minutes &middot; unedited</div>`;
  Object.assign(card.style, {
    position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: '18px', zIndex: '9999',
    pointerEvents: 'none', background: 'rgba(12, 20, 38, 0.38)',
    fontFamily: 'ui-rounded, "Nunito", "Segoe UI Rounded", system-ui, sans-serif',
    color: '#fff8ea', textShadow: '0 4px 0 rgba(20,24,48,0.55), 0 0 28px rgba(0,0,0,0.35)',
  });
  const style = document.createElement('style');
  style.textContent = `
    #video-title .t1 { font-size: 118px; font-weight: 900; letter-spacing: -1px; }
    #video-title .t2 { font-size: 40px; font-weight: 700; opacity: 0.92; }`;
  document.head.appendChild(style);
  document.body.appendChild(card);
  // Engage the round: the same event a click that takes pointer lock sends.
  window.__paintball.game.events.emit('input:lockChanged', { locked: true });
});
// Before its first step the page draws a placeholder: a night sky and a camera
// that is not yet behind the player. A quarter second of sim settles both, and
// the clock goes back to the full round so the video still opens on 5:00.
await page.evaluate((round) => {
  const { match, stepSim } = window.__paintball;
  const full = match.timeLeft;
  stepSim(0.25);
  match.timeLeft = round ?? full;
}, ROUND);
await setAnimationRate(0.45);
// Let the lock's HUD transition settle before the first kept frame.
await page.waitForTimeout(700);

const prerollFrames = Math.round(PREROLL * FPS);
const started = Date.now();
for (let f = 0; f < prerollFrames; f++) {
  // Hold, then fade over the last second, as the whistle goes.
  const fade = Math.min(1, Math.max(0, (PREROLL - f * DT) / 1.0));
  await page.evaluate((o) => { document.getElementById('video-title').style.opacity = String(o); }, fade);
  await shoot();
}
await page.evaluate(() => {
  document.getElementById('video-title').remove();
  window.__simAudio.offset = window.__paintball.simTime();
  if (window.__simAudio.ctx) window.__simAudio.start();
});
const matchFirstFrame = frameIndex;

// --- the round -----------------------------------------------------------------
const timeline = [];
const snapshot = () => page.evaluate(() => {
  const { match, characters, state } = window.__paintball;
  return {
    left: +match.timeLeft.toFixed(1),
    phase: match.phase,
    ammo: match.ammo.get('player'),
    pos: [+state.position.x.toFixed(1), +state.position.z.toFixed(1)],
    target: window.__autopilot.target?.id ?? null,
    wetCamera: window.__autopilot.wetCameraFrames,
    scores: characters.allCharacters.map((c) => `${c.hitsGiven}/${c.hitsTaken}`).join(' '),
    bots: characters.allBots.map((b) => b.state[0]).join(''),
  };
});

let lastReport = -1;
for (;;) {
  const phase = await page.evaluate((dt) => {
    window.__autopilot.frame(dt);
    window.__simAudio.pump?.(window.__simAudio.ctx.currentTime);
    return window.__paintball.match.phase;
  }, DT);
  await shoot();

  const elapsed = (frameIndex - matchFirstFrame) / FPS;
  if (Math.floor(elapsed / 10) !== lastReport) {
    lastReport = Math.floor(elapsed / 10);
    const s = await snapshot();
    timeline.push(s);
    if (DRY) await page.screenshot({ path: join(OUT, `sample-${String(Math.round(elapsed)).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 80 });
    const wall = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`  t=${elapsed.toFixed(0).padStart(3)}s left=${String(s.left).padStart(5)} ammo=${String(s.ammo).padStart(3)} ` +
                `target=${(s.target ?? '-').padEnd(5)} wet=${s.wetCamera} scores=[${s.scores}] bots=${s.bots}  (${wall}s wall)`);
  }
  if (phase === 'ended') break;
  if (elapsed > (ROUND ?? 300) + 10) throw new Error('round did not end');
}
const matchFrames = frameIndex - matchFirstFrame;
console.log(`round over after ${(matchFrames / FPS).toFixed(1)}s of footage`);

// --- the results card ------------------------------------------------------------
await page.evaluate(() => window.__autopilot.release());
const resultsFrames = Math.round(RESULTS * FPS);
for (let f = 0; f < resultsFrames; f++) {
  await page.evaluate((dt) => {
    window.__paintball.stepSim(dt);
    window.__simAudio.pump?.(window.__simAudio.ctx.currentTime);
  }, DT);
  await shoot();
  if (DRY && f % 90 === 0) await page.screenshot({ path: join(OUT, `results-${f}.jpg`), type: 'jpeg', quality: 80 });
}

const final = await snapshot();
const log = await page.evaluate(() => window.__autopilot.log);
writeFileSync(join(OUT, 'match.json'), JSON.stringify({
  fps: FPS, width: WIDTH, height: HEIGHT, seed: SEED, preroll: PREROLL,
  matchFirstFrame, matchFrames, frames: frameIndex, final, timeline, log, errors,
}, null, 2));
console.log(`final scores (player first, given/taken): ${final.scores}`);

// --- render the soundtrack -------------------------------------------------------
if (!DRY) {
  console.log('rendering audio...');
  const t0 = Date.now();
  const download = page.waitForEvent('download', { timeout: 600_000 });
  await page.evaluate(async (seconds) => {
    const buffer = await window.__simAudio.finish();
    const length = Math.min(buffer.length, Math.ceil(buffer.sampleRate * seconds));
    const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const bytes = new ArrayBuffer(44 + length * 4);
    const view = new DataView(bytes);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + length * 4, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 2, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 4, true); view.setUint16(32, 4, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * 4, true);
    let at = 44;
    let peak = 0;
    for (let i = 0; i < length; i++) {
      for (const data of channels) {
        const v = Math.max(-1, Math.min(1, data[i]));
        peak = Math.max(peak, Math.abs(v));
        view.setInt16(at, v * 0x7fff, true);
        at += 2;
      }
    }
    window.__audioPeak = peak;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    link.download = 'match.wav';
    link.click();
  }, (matchFrames + resultsFrames) / FPS + 1);
  await (await download).saveAs(join(OUT, 'match.wav'));
  const peak = await page.evaluate(() => window.__audioPeak);
  console.log(`audio: ${((Date.now() - t0) / 1000).toFixed(0)}s to render, peak ${peak.toFixed(2)}`);
}

await browser.close();
console.log(`${frameIndex} frames in ${((Date.now() - started) / 1000).toFixed(0)}s wall`);
if (errors.length) console.log(`page errors: ${errors.length}\n  ${errors.slice(0, 5).join('\n  ')}`);

// --- encode ------------------------------------------------------------------------
if (ENCODE) {
  const FFMPEG = process.env.FFMPEG_PATH ??
    ['/usr/bin/ffmpeg', 'node_modules/ffmpeg-static/ffmpeg'].find(existsSync);
  const outPath = join(OUT, 'central-park-paintball-full-round.mp4');
  console.log('encoding...');
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'warning',
    '-framerate', String(FPS), '-i', join(FRAMES, '%06d.jpg'),
    '-i', join(OUT, 'match.wav'),
    // The soundtrack's zero is the whistle, which is the first frame after the
    // title card.
    // Loudness to YouTube's reference, so it is not turned up or down on upload.
    '-filter_complex', `[1:a]adelay=${Math.round(PREROLL * 1000)}:all=1,loudnorm=I=-15:TP=-1.5:LRA=11,aresample=48000,apad[a]`,
    '-map', '0:v', '-map', '[a]', '-shortest',
    // Capped: the renderer lays paper grain over every frame and unconstrained
    // x264 spends 27Mbps describing it.
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-maxrate', '16M', '-bufsize', '32M',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', String(FPS / 2), '-bf', '2',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
    '-movflags', '+faststart',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  // Frames and stems stay behind for a re-cut; the mp4 is the deliverable.
  console.log(`-> ${outPath}`);
}
