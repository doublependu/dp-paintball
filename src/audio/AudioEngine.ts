import type { Vector3 } from 'three';

export type Bus = 'sfx' | 'ambient' | 'music';

/**
 * Web Audio plumbing: one context, three buses, and cheap positional playback.
 *
 * Everything the game plays is synthesised at runtime rather than streamed from
 * files. That is partly the load budget — a decent ambience bed and sound set
 * would be megabytes, against a total budget of a few — and partly consistency:
 * the splats, canopies, characters and animation are all generated, so the
 * audio may as well be too. It also means a sound is retuned by changing a
 * number, not by re-recording.
 *
 * Positioning uses a distance curve and a stereo pan rather than a PannerNode.
 * HRTF panning is wasted on a game viewed from behind the shoulder, and this
 * costs two nodes instead of a convolution.
 */
export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;
  private buses = new Map<Bus, GainNode>();
  private noiseBuffer?: AudioBuffer;
  private muted = false;

  /** Sounds beyond this are inaudible. */
  private readonly maxDistance = 60;
  /** Distance at which a sound plays at full volume. */
  private readonly referenceDistance = 4;

  /**
   * Creates or resumes the context. Must be called from a user gesture —
   * browsers refuse to start audio otherwise, and a context created too early
   * stays permanently suspended.
   */
  async unlock(): Promise<void> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();

      this.master = this.context.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.context.destination);

      for (const [bus, level] of [['sfx', 0.9], ['ambient', 0.35], ['music', 0.22]] as const) {
        const gain = this.context.createGain();
        gain.gain.value = level;
        gain.connect(this.master);
        this.buses.set(bus, gain);
      }

      this.noiseBuffer = this.createNoiseBuffer();
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  get isReady(): boolean {
    return this.context !== undefined && this.context.state === 'running';
  }

  get ctx(): AudioContext | undefined {
    return this.context;
  }

  get now(): number {
    return this.context?.currentTime ?? 0;
  }

  busNode(bus: Bus): GainNode | undefined {
    return this.buses.get(bus);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.now, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Two seconds of white noise, reused by every noise-based sound. */
  private createNoiseBuffer(): AudioBuffer | undefined {
    if (!this.context) return undefined;
    const length = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** A looping noise source. Caller owns starting and stopping it. */
  createNoiseSource(): AudioBufferSourceNode | undefined {
    if (!this.context || !this.noiseBuffer) return undefined;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    return source;
  }

  /**
   * Gain and pan for a world position, relative to the listener.
   * Returns null when the sound is too far away to bother playing.
   */
  spatialise(
    soundPosition: Vector3,
    listenerPosition: Vector3,
    listenerRight: Vector3,
  ): { gain: number; pan: number } | null {
    const dx = soundPosition.x - listenerPosition.x;
    const dy = soundPosition.y - listenerPosition.y;
    const dz = soundPosition.z - listenerPosition.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > this.maxDistance) return null;

    // Inverse-distance rolloff, clamped so a sound at the listener's own
    // position doesn't blow out.
    const gain = this.referenceDistance / Math.max(distance, this.referenceDistance);
    const pan = distance < 0.01
      ? 0
      : Math.max(-1, Math.min(1, (dx * listenerRight.x + dz * listenerRight.z) / distance));

    return { gain, pan };
  }

  /** Builds a gain -> pan -> bus chain for a one-shot. */
  createVoice(bus: Bus, gain: number, pan: number): { input: AudioNode; gainNode: GainNode } | null {
    const context = this.context;
    const target = this.buses.get(bus);
    if (!context || !target) return null;

    const gainNode = context.createGain();
    gainNode.gain.value = gain;

    const panner = context.createStereoPanner();
    panner.pan.value = pan;

    gainNode.connect(panner);
    panner.connect(target);
    return { input: gainNode, gainNode };
  }

  dispose(): void {
    void this.context?.close();
    this.context = undefined;
    this.buses.clear();
  }
}
