import type { AudioEngine, Bus } from './AudioEngine';

/**
 * The game's sound set, synthesised on demand.
 *
 * Each sound is a handful of oscillators and filtered noise with tight
 * envelopes. Paintball sounds suit this unusually well — a CO2 puff, a wet
 * slap, a footfall are all short broadband transients, which is exactly what
 * noise through a swept filter produces.
 */
export class Synth {
  constructor(private readonly engine: AudioEngine) {}

  /**
   * Firing: a compressed-gas puff plus a hollow body thump.
   * Deliberately soft — this is a park, not a warzone.
   */
  shoot(gain = 1, pan = 0): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.5, pan);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    // The gas escape.
    const noise = this.engine.createNoiseSource();
    if (noise) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2400, t);
      filter.frequency.exponentialRampToValueAtTime(700, t + 0.09);
      filter.Q.value = 1.2;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.9, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

      noise.connect(filter);
      filter.connect(env);
      env.connect(voice.input);
      noise.start(t);
      noise.stop(t + 0.12);
    }

    // The barrel's body: a fast downward chirp.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.07);
    const oscEnv = ctx.createGain();
    oscEnv.gain.setValueAtTime(0.5, t);
    oscEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(oscEnv);
    oscEnv.connect(voice.input);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  /**
   * Paint impact: the wet slap. A short noise burst through a rapidly closing
   * lowpass, plus a low thud for the mass behind it.
   */
  splat(gain = 1, pan = 0, pitch = 1): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.75, pan);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    const noise = this.engine.createNoiseSource();
    if (noise) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      // The downward sweep is what makes it read as wet rather than as a click.
      filter.frequency.setValueAtTime(5200 * pitch, t);
      filter.frequency.exponentialRampToValueAtTime(420 * pitch, t + 0.12);
      filter.Q.value = 2.2;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(1.0, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

      noise.connect(filter);
      filter.connect(env);
      env.connect(voice.input);
      noise.start(t);
      noise.stop(t + 0.18);
    }

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(180 * pitch, t);
    thud.frequency.exponentialRampToValueAtTime(58 * pitch, t + 0.1);
    const thudEnv = ctx.createGain();
    thudEnv.gain.setValueAtTime(0.6, t);
    thudEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    thud.connect(thudEnv);
    thudEnv.connect(voice.input);
    thud.start(t);
    thud.stop(t + 0.15);
  }

  /**
   * An empty marker: the click with none of the puff.
   *
   * Deliberately the inverse of `shoot()` — a hard, dry, high transient and no
   * gas escape at all, because what tells you you're empty is the *absence* of
   * the sound you expected.
   */
  dryFire(gain = 1, pan = 0): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.45, pan);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    const noise = this.engine.createNoiseSource();
    if (noise) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 2600;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.8, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);

      noise.connect(filter);
      filter.connect(env);
      env.connect(voice.input);
      noise.start(t);
      noise.stop(t + 0.05);
    }

    // The sear dropping — a tiny woody knock under the click.
    const knock = ctx.createOscillator();
    knock.type = 'square';
    knock.frequency.setValueAtTime(210, t);
    knock.frequency.exponentialRampToValueAtTime(120, t + 0.03);
    const knockEnv = ctx.createGain();
    knockEnv.gain.setValueAtTime(0.22, t);
    knockEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    knock.connect(knockEnv);
    knockEnv.connect(voice.input);
    knock.start(t);
    knock.stop(t + 0.05);
  }

  /** Footfall: a brief damped noise tap, pitched by surface. */
  footstep(gain = 1, pan = 0, pitch = 1): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.28, pan);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    const noise = this.engine.createNoiseSource();
    if (!noise) return;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620 * pitch;
    filter.Q.value = 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.7, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

    noise.connect(filter);
    filter.connect(env);
    env.connect(voice.input);
    noise.start(t);
    noise.stop(t + 0.09);
  }

  /**
   * Getting tagged: a soft descending "oof", so being hit reads as comic
   * rather than punishing.
   */
  tagged(gain = 1): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.5, 0);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(190, t + 0.22);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.55, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

    osc.connect(env);
    env.connect(voice.input);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  /** A rising three-note blip for landing a hit on someone else. */
  scored(gain = 1): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.32, 0);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;
    const notes = [660, 880, 1180];

    notes.forEach((frequency, i) => {
      const start = t + i * 0.055;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(0.5, start + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, start + 0.1);
      osc.connect(env);
      env.connect(voice.input);
      osc.start(start);
      osc.stop(start + 0.12);
    });
  }

  /**
   * A bird call: two or three chirps, each a fast frequency sweep.
   * Real birdsong is mostly rapid glissandi, which a single ramped oscillator
   * captures surprisingly convincingly.
   */
  birdCall(gain: number, pan: number, seedPitch: number, bus: Bus = 'ambient'): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice(bus, gain, pan);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;
    const chirps = 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < chirps; i++) {
      const start = t + i * (0.07 + Math.random() * 0.06);
      const base = seedPitch * (0.92 + Math.random() * 0.2);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base, start);
      osc.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.6), start + 0.03);
      osc.frequency.exponentialRampToValueAtTime(base * 0.85, start + 0.06);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(0.5, start + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);

      osc.connect(env);
      env.connect(voice.input);
      osc.start(start);
      osc.stop(start + 0.09);
    }
  }

  /**
   * The whistle that starts and ends a round.
   *
   * A pea whistle is two close tones beating against each other with a wide
   * band of breath noise underneath, and the warble is the trill of the pea
   * rattling. All three are needed: two clean oscillators sound like a toy
   * organ, and noise alone sounds like a leak.
   *
   * `rising` is the difference between "go" and "that's time" — the same
   * instrument, blown up or down, which is what a referee actually does.
   */
  whistle(gain = 1, rising = true, duration = 0.55): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('sfx', gain * 0.42, 0);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;
    const base = rising ? 1720 : 2100;
    const end = rising ? 2180 : 1560;

    // The pea: a fast tremolo on both tones at once.
    const warble = ctx.createOscillator();
    warble.type = 'sine';
    warble.frequency.value = 26;
    const warbleDepth = ctx.createGain();
    warbleDepth.gain.value = 90;
    warble.connect(warbleDepth);
    warble.start(t);
    warble.stop(t + duration + 0.1);

    for (const [ratio, level] of [[1, 1], [1.021, 0.7]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * ratio, t);
      osc.frequency.linearRampToValueAtTime(end * ratio, t + duration * 0.7);
      warbleDepth.connect(osc.frequency);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.03);
      env.gain.setValueAtTime(0.5 * level, t + duration * 0.75);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(env);
      env.connect(voice.input);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }

    const noise = this.engine.createNoiseSource();
    if (noise) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = base * 1.1;
      filter.Q.value = 3;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      noise.connect(filter);
      filter.connect(env);
      env.connect(voice.input);
      noise.start(t);
      noise.stop(t + duration + 0.05);
    }
  }

  /**
   * Running water: a wide noise bed, for standing near the fountain.
   *
   * Filtered high and gently, because what makes water read as water rather
   * than as static is that it has no pitch and a lot of top end.
   */
  water(gain: number, pan: number): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('ambient', gain, pan);
    if (!ctx || !voice) return;
    const noise = this.engine.createNoiseSource();
    if (!noise) return;
    const t = ctx.currentTime;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.linearRampToValueAtTime(1700, t + 1.4);
    filter.Q.value = 0.6;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);

    noise.connect(filter);
    filter.connect(env);
    env.connect(voice.input);
    noise.start(t);
    noise.stop(t + 1.7);
  }

  /** A single soft bell tone, used by the sparse ambient music. */
  bell(frequency: number, gain: number, duration = 2.4): void {
    const ctx = this.engine.ctx;
    const voice = this.engine.createVoice('music', gain, (Math.random() - 0.5) * 0.5);
    if (!ctx || !voice) return;
    const t = ctx.currentTime;

    // Fundamental plus a quiet fifth: enough partials to read as an
    // instrument, few enough to stay soft.
    for (const [ratio, level] of [[1, 1], [1.5, 0.28], [2, 0.16]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency * ratio;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.4 * level, t + 0.04);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(env);
      env.connect(voice.input);
      osc.start(t);
      osc.stop(t + duration + 0.1);
    }
  }
}
