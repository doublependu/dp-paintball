/** Small math helpers used across systems. Kept dependency-free and inlinable. */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function saturate(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inA: number, inB: number, outA: number, outB: number): number {
  return lerp(outA, outB, inverseLerp(inA, inB, v));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = saturate(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Framerate-independent exponential smoothing. `lambda` is the decay rate:
 * higher converges faster. Unlike a raw lerp with a fixed alpha, this gives the
 * same feel at 30fps and 240fps.
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed angular difference, in radians, wrapped to [-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveTowards(a: number, b: number, maxDelta: number): number {
  const d = b - a;
  return Math.abs(d) <= maxDelta ? b : a + Math.sign(d) * maxDelta;
}
