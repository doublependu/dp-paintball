/**
 * Seeded PRNG (mulberry32). Deterministic generation matters here: the splat
 * atlas, foliage scatter and map dressing are all procedural, and we want the
 * same seed to produce the same park every load.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max));
  }

  /** Float in [-spread, spread). */
  spread(spread: number): number {
    return this.range(-spread, spread);
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)]!;
  }

  /** Roughly gaussian via the sum of two uniforms; cheap and good enough. */
  gaussian(): number {
    return this.next() + this.next() - 1;
  }

  /** A fresh generator whose seed is derived from this one. */
  fork(): Rng {
    return new Rng(this.int(0, 0xffffffff));
  }
}

/** Shared instance for anything that doesn't need its own reproducible stream. */
export const rng = new Rng();
