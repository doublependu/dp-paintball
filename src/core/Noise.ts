/**
 * Deterministic value noise, matching the shape of the GLSL noise used in the
 * sky shader so terrain and sky read as the same hand.
 *
 * Value rather than gradient noise: the difference is invisible at the
 * frequencies used here, and this needs no permutation table.
 */

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smootherstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1]. */
export function noise2D(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smootherstep(x - xi);
  const yf = smootherstep(y - yi);

  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);

  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

/** Fractal sum of value noise, in [0, 1]. */
export function fbm2D(x: number, y: number, octaves = 4, seed = 0): number {
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let normalisation = 0;

  for (let i = 0; i < octaves; i++) {
    total += noise2D(x * frequency, y * frequency, seed + i * 17) * amplitude;
    normalisation += amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }

  return total / normalisation;
}

/** Signed fractal noise in roughly [-1, 1]. */
export function fbmSigned(x: number, y: number, octaves = 4, seed = 0): number {
  return fbm2D(x, y, octaves, seed) * 2 - 1;
}
