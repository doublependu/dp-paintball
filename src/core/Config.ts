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

  // Trajectory prediction, driving the scene crosshair. These live here rather
  // than with the crosshair because they describe the flight model, not the
  // mark drawn at the end of it: `predict()` is a ballistics concern that the
  // crosshair merely happens to be the only caller of.
  /** Seconds of flight to trace before giving up. Beyond this you are lobbing. */
  predictMaxFlight: 1.2,
  /**
   * Fixed steps resolved per collision ray. The path is always integrated at
   * FIXED_DT; this only coarsens *collision*, trading a couple of cm of chord
   * sag for half the ray casts.
   */
  predictChordSteps: 2,
} as const;

/**
 * The scene crosshair — the half of the aiming pair drawn in the world.
 *
 * The aiming pair is two crosshairs. The *viewport* crosshair is a DOM element
 * at screen centre (`.hud__viewport-crosshair`): where you are pointing, and
 * the direction the ball leaves the muzzle. The *scene* crosshair is this one,
 * drawn on the surface the ball will actually reach — 0.46 m lower at 8 m,
 * 1.73 m at 15 m. The gap between them is the arc, and showing it is the point:
 * compensating the shot would hide the arc, and the lazy readable arc is the
 * thing this game is built around.
 */
export const sceneCrosshair = {
  /** Ring lift off the struck surface, against z-fighting. */
  surfaceOffset: 0.03,
  /**
   * Ring size, as an angle rather than a world radius, so it holds a roughly
   * constant size on screen at every range.
   *
   * Sizing it by the spread cone alone was the first idea and it does not
   * survive the numbers: `baseSpread` is 0.9 degrees, which at 15 m is a 24 cm
   * ring — two pixels of band, invisible. Spread is *added* to this instead, so
   * settling or aiming still visibly tightens the ring without it ever
   * shrinking below something you can see.
   */
  ringAngularSize: 0.026,
  /**
   * Angular size of the camera-facing dot.
   *
   * The ring alone is not enough. This camera sits 1.5 m up, so ground at
   * ordinary fighting range is seen at five degrees or less — a ring lying on
   * it compresses to a couple of pixels of height and disappears. The dot
   * always faces the viewer, so there is something readable at every angle,
   * while the ring keeps the mark feeling planted on the surface.
   */
  dotAngularSize: 0.013,
  /** Damping toward each freshly solved point. */
  lambda: 26,
  /** Spacing between arc droplets, in fixed steps. */
  arcStride: 2,
  /** Arc droplet radius in metres. */
  arcDotRadius: 0.05,
  /** Cap on drawn droplets; the trace is longer than it is useful to draw. */
  arcMaxDots: 40,
  /** The near end of the arc is behind the character — skip it. */
  arcSkipSteps: 4,
} as const;

export const paint = {
  /** Resolution of the shared world paint atlas. */
  worldAtlasSize: 4096,
  /**
   * Splats a character can carry before the oldest is dropped.
   *
   * Every live splat costs three vec4 uniforms and one iteration of the rig's
   * fragment loop, so this is a real budget rather than a nominal one. It is
   * also higher than it looks: a body is visually saturated well before 24
   * hits, so the cap is reached long after it stops being legible.
   */
  characterMaxSplats: 24,
  /** Number of procedurally generated splat shapes in the variant atlas. */
  splatVariants: 16,
  splatAtlasSize: 1024,
  /** World-space radius of a splat on world geometry, at nominal impact speed. */
  baseSplatRadius: 0.34,
  /**
   * Radius for splats on a character.
   *
   * Smaller than the world radius, because a torso face is only 0.44m across
   * and an oversized splat scissors into a solid rectangle of colour. But not
   * *much* smaller: at 0.13 a hit covered so little of a body that at ordinary
   * combat range — where a character is 40-80 pixels tall — landing three or
   * four shots left no visible mark at all, and the paint read as broken.
   * A hit should be obvious from across the plaza.
   */
  characterSplatRadius: 0.2,
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
