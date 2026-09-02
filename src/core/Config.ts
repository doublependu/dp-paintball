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
  /**
   * Far plane.
   *
   * Sized by the deepest rank of the city ring seen from the far side of the
   * park — roughly 600m — with headroom, because the sky dome rides at half
   * this and has to stay outside everything it is behind.
   */
  far: 1500,

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

/** Phones and tablets. See `src/ui/TouchControls.ts` for the layout itself. */
export const touch = {
  /**
   * Drag pixels to mouse counts.
   *
   * The camera converts whatever `Input` hands it at `camera.sensitivity`
   * radians per count, so this is expressed in the same currency rather than in
   * radians: 4.6 counts per CSS pixel works out at about 0.010 rad/px, which
   * turns a thumb's comfortable ~120px drag into a little over a right angle.
   * Any less and looking behind you needs three swipes.
   */
  lookScale: 4.6,
  /**
   * How far the thumb travels from where it landed for full stick deflection,
   * in CSS pixels. Sized for a thumb pivoting at the base, not for the ring
   * drawn under it.
   */
  stickRadius: 58,
  /** Movement inside this fraction of the radius is treated as holding still. */
  stickDeadzone: 0.16,
  /** Past this fraction of full deflection, the stick also asks for a sprint. */
  sprintThreshold: 0.85,
  /**
   * Pixel-ratio cap on a touch device.
   *
   * A phone's DPR is 3 and its fill rate is not a desktop's. 1.5 keeps the ink
   * outlines crisp — they are measured in pixels, so they are what a low ratio
   * spoils first — while costing a quarter of the fragments DPR 3 would.
   */
  maxPixelRatio: 1.5,
  /** Halved from the desktop map: the shadow is a soft shape, not a texture. */
  shadowMapSize: 1024,
} as const;

export const ballistics = {
  /**
   * Muzzle speed.
   *
   * Was 42, which made the game feel like people lobbing paint at each other
   * rather than shooting it. At 63 the drop over a fighting distance falls by
   * about 2.25x — ~0.36m at 10m rather than ~0.80m — so a shot reads as a shot,
   * while linear drag keeps the arc an arc rather than a laser.
   *
   * Anything that scales with impact speed reads this rather than a literal.
   * See `paint.splatSpeedMin`/`splatSpeedMax`: when this number moved and those
   * were still hardcoded 12 and 42, every hit clamped to the maximum splat size
   * and speed stopped modulating the paint at all.
   */
  muzzleSpeed: 63,
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
 * The round: what you carry, and where more of it comes from.
 *
 * Paint is finite, which changes the game more than any single number here: an
 * unlimited marker rewards holding the trigger, and a counted one rewards
 * picking a shot.
 *
 * These numbers are the first in this file set by playing rather than by
 * arithmetic — see `CLAUDE/prompt_5.md`. The load doubled to 200, which is
 * about twenty-eight seconds of held trigger at `fireInterval` 0.14, and a
 * crate went from a rounding error to half a fresh load. With ~1400 rounds in
 * the park at the whistle, a round should now end on the clock rather than on
 * the ammo condition — which is what five-minute rounds were a fiction without.
 */
export const match = {
  /** Round length. Ends early if every last paintball is gone first. */
  durationSeconds: 300,
  /** A toast goes out when this much time is left. */
  warnAtSeconds: 60,
  /** The clock turns urgent below this. */
  urgentAtSeconds: 30,
  /** Paintballs everyone starts with. */
  startingAmmo: 200,
  /** Paint in one crate. */
  lootAmmo: 100,
  /**
   * Crates out at once.
   *
   * One was the brief, and one is a race rather than a fight: every bot reads
   * the crate's position the instant it spawns, so the nearest one wins it and
   * nobody else ever had a decision to make. Three gives the park somewhere to
   * go that is not wherever everyone else already is.
   */
  lootCrates: 3,
  /**
   * Seconds before a taken crate reappears somewhere new. 0 would be one crate
   * per round and nothing more, which is the brief; at 35 a crate is the
   * round's pacing mechanism instead of a one-off.
   */
  lootRespawnSeconds: 35,
  /** How close you have to get to take a crate. */
  lootPickupRadius: 1.4,
  /**
   * Below this, a bot would rather find paint than a fight.
   *
   * Scaled with `startingAmmo`, and it has to be: at 15 against a 200 load a
   * bot is down to 7.5% before it goes looking, which is to say it spends the
   * whole round not looking.
   */
  botSeekAmmo: 30,
  /**
   * How far a bot can notice a crate, scaling its own sight range.
   *
   * Range-gated deliberately. Bots know where the crate is the instant it
   * spawns — they read the same shared state the pickup check does — so without
   * a limit every one of them beelines for it at t=0 and the crate is gone
   * before the player has finished looking around.
   */
  botLootSightScale: 1.5,
  /** The HUD counter turns warm below this. Scaled with `startingAmmo`. */
  lowAmmo: 40,
} as const;

/**
 * The scene crosshair — the half of the aiming pair drawn in the world.
 *
 * The aiming pair is two crosshairs. The *viewport* crosshair is a DOM element
 * at screen centre (`.hud__viewport-crosshair`): where you are pointing, and
 * the direction the ball leaves the muzzle. The *scene* crosshair is this one,
 * drawn on the surface the ball will actually reach — 0.21 m lower at 8 m,
 * 0.80 m at 15 m. The gap between them is the arc, and showing it is the point:
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
   *
   * Trimmed from 0.2 when splats started landing where they were aimed.
   * `resolvePaintAnchor` used to hand the shader the raw capsule impact point,
   * about 0.2m clear of the torso it was meant to paint, so most of a splat's
   * radius was spent reaching the surface at all; on the corrected anchor the
   * same number covered a whole torso face and scissored into a rectangle.
   */
  characterSplatRadius: 0.15,
  /**
   * Splat radius on the paint screen, as a fraction of the world radius.
   *
   * `NEXT_5.md` flagged the board's splats as "3% of its width — right for
   * consistency with the park, possibly wrong for a thing whose purpose is to
   * be painted on". Painting bots settled it: at the full world radius a hit is
   * nearly a metre across on an eleven-metre board, and a drawing made of them
   * is four blobs wide whatever it was meant to be.
   *
   * Set by drawing with it. At 0.55 the marks were 30cm across and a bot's cat
   * came out as three dozen separate dots with daylight between them — the
   * strokes have to overlap or the picture is a constellation. At 0.8 a mark is
   * about 45cm, which joins up at the spacing `mural.dotSpacing` asks for and
   * still leaves an eleven-metre board worth filling by hand.
   */
  screenSplatScale: 0.8,
  /** Splats scale up with impact speed, within these bounds. */
  minSplatScale: 0.7,
  maxSplatScale: 1.5,
  /**
   * Impact speeds mapping to `minSplatScale`..`maxSplatScale`.
   *
   * Fractions of muzzle speed, not absolute m/s. They were literals — 12 and 42
   * — chosen when muzzle speed happened to be 42, so raising it to 63 pushed
   * every hit past the top of the range and pinned every splat at maximum size.
   * An always-maxed splat is also an always-scissored one on a 0.44m torso face,
   * which is the wrong end of the trade `characterSplatRadius` documents.
   *
   * The top of the range is muzzle speed itself, which only a square hit at
   * point-blank reaches: drag and the angle-of-incidence term in
   * `BallisticsSystem.emitImpact` mean everything else lands below it.
   */
  splatSpeedMin: ballistics.muzzleSpeed * 0.29,
  splatSpeedMax: ballistics.muzzleSpeed,
} as const;

/**
 * Bots painting the board.
 *
 * A designated painter with paint to spare and nobody to shoot at walks to the
 * board and draws something in a corner of it. The numbers here are all about
 * making that a *side quest* rather than either a mode or a coincidence.
 *
 * It used to be neither. Every bot was eligible, on a gate that needed no
 * target, three seconds of quiet, eighty rounds, no cooldown and sixty metres
 * to the board simultaneously — and the median bot spent the round 80m away. A
 * measured 300-second match produced three splats on the board: two bots
 * started, neither got past the walk-in, and four never entered the state at
 * all. Every clause below that changed, changed because of that measurement.
 */
export const mural = {
  /**
   * How many bots are designated as painters at the whistle, inclusive.
   *
   * The prompt asked for one to three, and the reason it is a roll at the
   * whistle rather than a gate every bot re-asks is that a plan produces
   * different behaviour from a coincidence: a designated painter will cross the
   * whole park for the errand, which is what makes it visible.
   *
   * The colours come free. Every bot carries its own index into `paintColors`,
   * so three painters are three colours on the board with no further work.
   */
  minPainters: 1,
  maxPainters: 3,
  /**
   * A bot needs this much paint before art is a reasonable use of it.
   *
   * Halved from 80 with `maxDots`, since a corner drawing costs a quarter of
   * what a half-board one did. Not lower: a bot that spends its last rounds on
   * a heart and then walks the park looking for a crate has made the round
   * worse, which is what the restock clause in `wantsToPaint` is there for.
   */
  minAmmo: 40,
  /** Seconds of nobody in sight before a bot's mind wanders to the wall. */
  quietSeconds: 3,
  /** Where it stands to paint, in metres out from the board. */
  standoffMin: 8,
  standoffMax: 11,
  /** How far off the board's normal that stance may sit, in degrees. */
  offAxisDeg: 20,
  /**
   * Aim cone while painting, in degrees.
   *
   * An order of magnitude tighter than a bot's fighting aim, which is 4.5 to 12
   * degrees and would put a metre-and-a-half group on the board at this range.
   * Not zero: a perfectly rasterised drawing looks printed, and this game is
   * drawn by hand everywhere else. It matters more at a corner's size than it
   * did at twice it — the same cone, over a box a third the width.
   */
  aimErrorDeg: 0.4,
  /** Seconds between marks. Slower than a fight — this is deliberate work. */
  fireInterval: 0.32,
  /** Give up on a drawing after this long, wherever it got to. */
  timeoutSeconds: 45,
  /**
   * Having finished one, do not start another for this long.
   *
   * The cooldown exists so that one painter does not fill the board with its
   * own work while everyone else fights — which is a reason about *finished*
   * drawings, and only about those.
   */
  cooldownSeconds: 45,
  /**
   * And having failed to finish one — timed out, or held a lease past
   * `resumeSeconds` — wait only this long before trying again.
   *
   * The same 45 seconds used to apply to both, and against a round where a
   * painter gets a handful of quiet windows it was most of the reason nothing
   * ever appeared: a bot that painted nothing has monopolised nothing, and
   * making it sit out three quarters of a minute for having been shot at spends
   * the round's remaining chances on a punishment for bad luck.
   */
  retrySeconds: 12,
  /**
   * A target this close breaks a painter off. Further away, it keeps painting.
   *
   * The old rule was any target at all, and it is the single most expensive
   * line in the old design: a painter would walk twenty seconds to the board,
   * catch sight of somebody through the trees at fifty metres, and throw away
   * the errand and three quarters of a minute of cooldown with it. Two entries
   * in the measured round averaged four seconds each for exactly this.
   */
  breakOffRange: 26,
  /**
   * How long a broken-off drawing is held before the slot goes back.
   *
   * A bot that breaks off to fight and comes back to finish its heart is the
   * side quest the prompt describes. A bot that restarts from nothing and then
   * sits out `cooldownSeconds` is what the measurement found.
   */
  resumeSeconds: 30,
  /**
   * Marks per drawing. A budget: see `dotsFor`.
   *
   * Twenty-six at `fireInterval` is eight seconds of standing still, which is
   * what the corner designs come to at that box size anyway (11 to 25 marks).
   * The old 56 was eighteen seconds plus a walk that could be twenty more, and
   * against the measured quiet runs — 11 to 97 seconds, one bot in six with a
   * gap that long — it only ever fitted one bot's afternoon.
   */
  maxDots: 26,
  /**
   * Spacing between marks, as a fraction of a splat's diameter.
   *
   * Under 1 by necessity — the marks have to overlap to read as a line rather
   * than as a row of dots — and not far under, because every mark is a shot and
   * a drawing that costs eighty rounds is a bot that has stopped playing.
   */
  dotSpacing: 0.7,
  /**
   * Odds that a painter signs with its own initial instead of drawing.
   *
   * Up from 0.22 with the move to corners. An initial in the corner of a mural
   * is exactly the thing the prompt describes, and a letter is the sparsest
   * mark in the catalogue at that size — see `letterDesign`.
   */
  letterChance: 0.35,
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
  waterDeep: 0x35688f,
  waterShallow: 0x7fb6c8,
  /** The green margin under the treeline, where the water reflects leaves. */
  waterAlgae: 0x74864e,

  /** Pre-war limestone and brick, the Manhattan wall around the park. */
  cityStone: 0xbfae96,
  cityBrick: 0x9c6f5c,
  cityGlass: 0x6d8296,
  /** Roadway outside the park wall. */
  asphalt: 0x585560,

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
  /**
   * The floor the adaptive resolution will drop to, and the frame times it
   * moves between.
   *
   * A cap alone is a bet that every machine can afford the same number, and on
   * a high-DPI laptop that bet is what "the mouse feels laggy" is: the look
   * itself has no smoothing in it, so what a player feels when panning is
   * simply how long a frame takes. The renderer now walks the ratio down when
   * frames run long and back up when they do not.
   *
   * The window between the two thresholds is wide on purpose. Anything
   * narrower oscillates, and every step reallocates the render targets — a
   * change that costs a hitch of its own.
   */
  minPixelRatio: 1,
  pixelRatioStep: 0.25,
  /** Above this median frame time, give up resolution. 20ms is 50fps. */
  slowFrameMs: 20,
  /** Below this, ask for it back. 12ms is 83fps. */
  fastFrameMs: 12,
  /** Seconds between resolution changes, so it settles rather than hunts. */
  resolutionSettleSeconds: 2.5,
  /**
   * Fixed steps between shadow-map redraws.
   *
   * The sun does not move; only seven characters and the ball do. A full second
   * scene render into a 2048 map every frame buys a shadow edge that is one
   * frame fresher, which nobody has ever seen.
   */
  shadowUpdateInterval: 2,
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
