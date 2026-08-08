/**
 * Every tunable in one place. Systems read from here rather than hardcoding, so
 * the polish loop in phase 9 has a single surface to turn dials on.
 */

export const WORLD_SEED = 0x5eed_c0de;

/** Fixed simulation rate. Physics and gameplay step at exactly this. */
export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;
/** Cap on catch-up steps per frame, so a stalled tab can't spiral. */
export const MAX_SUB_STEPS = 5;
/** Frame delta is clamped to this before it reaches the accumulator. */
export const MAX_FRAME_DT = 0.25;

export const physics = {
  gravity: -22,
  /** Rapier's penetration slop for the character controller. */
  characterOffset: 0.02,
} as const;

export const player = {
  height: 1.8,
  crouchHeight: 1.15,
  radius: 0.35,
  eyeHeight: 1.62,

  walkSpeed: 4.4,
  sprintSpeed: 7.2,
  crouchSpeed: 2.2,
  airControl: 0.35,

  /** Exponential-smoothing rates, not raw lerp alphas. */
  groundAccel: 14,
  airAccel: 4,
  groundFriction: 12,

  jumpHeight: 1.15,
  maxStepHeight: 0.45,
  maxSlopeClimb: 50,
  minSlopeSlide: 55,

  /** Grace window after a hit before you can be hit again. */
  hitInvulnSeconds: 1.0,
} as const;

export const camera = {
  fov: 62,
  /** Narrower while aiming — reads as a zoom without touching the arm alone. */
  fovAimed: 48,
  /** Wider at a sprint. Cheap, and it sells speed better than any particle. */
  fovSprint: 68,
  fovLambda: 8,
  near: 0.1,
  far: 400,

  /** Third-person spring arm. */
  armLength: 3.6,
  armLengthAimed: 2.2,
  shoulderOffset: 0.65,
  heightOffset: 1.55,
  /** Sphere-cast radius used to pull the camera in past geometry. */
  collisionRadius: 0.28,

  pitchMin: -70,
  pitchMax: 72,
  sensitivity: 0.0022,

  followLambda: 18,
  rotateLambda: 24,
  /** Pulling in past a wall is instant; easing back out is slow. */
  collisionInLambda: 60,
  collisionOutLambda: 6,
} as const;

export const ballistics = {
  muzzleSpeed: 42,
  /** Paintballs are light and draggy — this is what gives the readable arc. */
  drag: 0.42,
  gravityScale: 1.0,
  radius: 0.055,
  /** Fired projectiles never live longer than this. */
  maxLifetime: 4,
  /** Cone of inaccuracy in degrees, at rest. */
  baseSpread: 0.9,
  fireInterval: 0.14,
  /** Pool size; shots beyond this recycle the oldest. */
  maxActive: 256,
} as const;

export const paint = {
  /** Resolution of the shared world paint atlas. */
  worldAtlasSize: 4096,
  /** Per-character paint target. */
  characterTargetSize: 256,
  /** Number of procedurally generated splat shapes in the variant atlas. */
  splatVariants: 16,
  splatAtlasSize: 1024,
  /** World-space radius of a splat on world geometry, at nominal impact speed. */
  baseSplatRadius: 0.34,
  /**
   * Radius for splats on a character, much smaller than for world surfaces.
   * A torso face is only 0.44m across, so the world radius produced a splat
   * wider than the body part — scissored to the face, that renders as a solid
   * rectangle of colour rather than as a splat.
   */
  characterSplatRadius: 0.13,
  /** Splats scale up with impact speed, within these bounds. */
  minSplatScale: 0.7,
  maxSplatScale: 1.5,
} as const;

/**
 * Ghibli palette. Warm, slightly desaturated environment; shadows pushed toward
 * teal-violet rather than grey, which is the single biggest tell of the look.
 */
export const palette = {
  skyZenith: 0x4a9fd4,
  skyHorizon: 0xcfe9f2,
  sunWarm: 0xfff2d0,
  shadowCool: 0x5a6fa8,
  fogNear: 0xdceef5,

  grassLit: 0x8fbf5a,
  grassShade: 0x4a7a52,
  foliageLit: 0x7fb356,
  foliageShade: 0x3d6b4e,
  stoneLit: 0xd8cdb8,
  stoneShade: 0x8a8397,
  waterDeep: 0x3f7a91,
  waterShallow: 0x86c2c6,

  /** Ink is never pure black — it takes a tint from the surface beneath. */
  inkBase: 0x2a2438,
} as const;

/** Paint colors. Saturated and poppy, deliberately against the muted park. */
export const paintColors = [
  0xff3d81, // magenta
  0x00d4e8, // cyan
  0xa8e337, // lime
  0xff8c2b, // tangerine
  0x9b5de5, // violet
  0xffd23f, // sunshine
  0xff5757, // coral
  0x3fc98a, // mint
] as const;

export const render = {
  /** Device pixel ratio is clamped — 4K at DPR 3 is not worth the frame time. */
  maxPixelRatio: 2,
  shadowMapSize: 2048,
  /** Outline width in pixels, held roughly constant across distance. */
  outlineWidthPx: 3.0,
  /** Inverted-hull ink width on characters, in roughly screen pixels. */
  characterHullPx: 2.6,
  /** Cel ramp band count. */
  celBands: 3,
} as const;

export const debug = {
  /** F3 toggles the perf HUD; this is the initial state. */
  showPerfHud: import.meta.env.DEV,
  showPhysicsWireframes: false,
} as const;
