/**
 * In-page autopilot for tools/record-match.mjs: plays one whole round as the
 * player, with nobody at the controls.
 *
 * Unlike tools/director.js, which stages each shot, nothing here is arranged.
 * The bots are left alone to do whatever they do, and the player has to find
 * them, fight them, run out of paint and go and get more — so the footage is an
 * honest five minutes of the game rather than a highlight reel.
 *
 * Controls go through the touch surfaces (`setTouchMove`, `setTouchAction`),
 * like the director's, so movement, recoil, spread and ballistics are all the
 * real thing. Look is written to the player state directly, because there is
 * no pointer lock to synthesise mouse deltas from.
 *
 * Two policies, set through `window.__autopilotConfig` before injection:
 *
 *   film — the default, and what `record-match.mjs` shoots. It cheats in one
 *          respect: it knows where every bot is, the way a spectator would,
 *          and it keeps a sightseeing schedule. That is what keeps five minutes
 *          from containing two minutes of wandering an empty meadow — and what
 *          makes it useless for asking how the game plays.
 *   play — what `playtest.mjs` measures with. No schedule and no wallhack: it
 *          only engages a bot it can see inside its view, and only knows where
 *          one is otherwise by hearing it — a shot fired nearby, or being hit.
 *          Between fights it walks between the park's named places, the way
 *          somebody new to the map would. Crates are fair game, because the
 *          HUD points at the nearest one for a person too.
 *
 * Everything random is drawn from a seeded generator, so a seed replays the
 * same round — the game's own randomness is seeded by `?seed` already, and
 * `Math.random` in here was the one thing that made two runs differ.
 */
(() => {
  const { game, state, characters, match, loot, signs, layout } = window.__paintball;
  const config = window.__autopilotConfig ?? {};
  const POLICY = config.policy ?? 'film';
  /**
   * The round's length, read on the first frame rather than at injection:
   * `record-match.mjs --round` shortens the clock after this script is in.
   */
  let ROUND = null;
  /** mulberry32 — small, fast and plenty for footwork. */
  const rand = (() => {
    let a = (config.seed ?? 1) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const input = game.input;
  const physics = game.physics;
  const V = state.position.constructor;

  const MUZZLE_SPEED = 63;
  const GRAVITY = 9.81;
  /** Beyond this the player does not open fire. */
  const ENGAGE_RANGE = 34;
  /** Keep a fight going at up to this range once it has started. */
  const HOLD_RANGE = 42;
  const IDEAL_RANGE = [9, 19];
  const WAYPOINT_RADIUS = 1.6;
  const REPATH_SECONDS = 1.5;
  /** The longest one fight is allowed to run before looking for another. */
  const FIGHT_SECONDS = 16;
  /** `play` only: half-angle of what counts as in view, either side of the camera. */
  const VIEW_HALF_ANGLE = 75 * Math.PI / 180;
  /** `play` only: how far away a shot can be heard and placed. */
  const HEARING_RANGE = 38;
  /** `play` only: how long a heard position is worth walking toward. */
  const HEARD_SECONDS = 10;

  const dampTo = (current, target, lambda, dt) =>
    target + (current - target) * Math.exp(-lambda * dt);
  const angleDelta = (from, to) =>
    ((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const dampAngle = (current, target, lambda, dt) =>
    current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
  const yawToward = (dx, dz) => Math.atan2(-dx, -dz);

  const WATER_Y = -0.8;
  /**
   * Ground the bots may walk and the player's camera may not.
   *
   * The navgrid allows anything a hair above the water, which is right for a
   * bot and wrong for a camera that trails three metres behind and below the
   * player: along the lake's western arm, under Bow Bridge, it sank beneath the
   * water plane for eighteen seconds of the first full take. Low ground inside
   * the lake's outline is treated as off limits. The bridge deck is inside the
   * outline too, and is not low.
   */
  const wet = (x, z) => layout.lakeMask(x, z) > 0.01 &&
    (characters.navGrid?.groundAt(x, z) ?? 0) < WATER_Y + 1.8;
  /**
   * Standing on something built over the grid's ground — Bow Bridge's deck,
   * the terrace — where the grid, which only knows the ground, has nothing
   * useful to say. Measured from the player's feet, not the map: on the bridge
   * the ground under the player is the lake bed, and asking `wet` about it had
   * the player trying to walk sideways off the deck to dry land, into the
   * parapet, until the rescue teleport — twice a round on two seeds of five.
   */
  const elevated = () =>
    state.position.y > (characters.navGrid?.groundAt(state.position.x, state.position.z) ?? 0) + 1.2;
  const playerWet = () => !elevated() && wet(state.position.x, state.position.z);

  const place = (name) => signs.places.find((s) => s.name === name);
  /** Somewhere to stand in front of a sign, looking the way it faces. */
  const signStop = (name, back = 4) => {
    const s = place(name);
    const dx = s.faceX - s.x;
    const dz = s.faceZ - s.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: s.x + (dx / len) * back, z: s.z + (dz / len) * back, lookX: s.faceX, lookZ: s.faceZ };
  };

  /**
   * The round's shape: where the player heads between fights, and when.
   *
   * Hunting is the default and the rest are sightseeing, scheduled on the
   * round clock. Left to fight whatever is nearest, the player spends five
   * minutes under the terrace arcade, because that is where the bots spawn —
   * which is the game, but it is not a video of the park. A stop starts at its
   * `at` second and lasts until the player has stood there for `linger`.
   */
  const ITINERARY = POLICY === 'play' ? [{ kind: 'hunt', at: 0 }] : [
    { kind: 'hunt', at: 0 },
    { kind: 'visit', at: 40, label: 'The Mall', ...signStop('The Mall', 6), linger: 2 },
    { kind: 'visit', at: 0, label: 'Sheep Meadow', ...signStop('Sheep Meadow', 10), linger: 1.5 },
    { kind: 'mural', at: 0, label: 'the painting wall', x: -46, z: 41, lookX: -64, lookZ: 42, linger: 6 },
    { kind: 'hunt', at: 0 },
    // From the west bank, where record.mjs frames it too. The sign's own spot
    // is on low shore ground the camera would sink into.
    { kind: 'visit', at: 150, label: 'Bow Bridge', x: -55, z: -14, lookX: -44, lookZ: -30, linger: 3 },
    { kind: 'hunt', at: 0 },
    { kind: 'mural', at: 235, label: 'the painting wall', x: -46, z: 41, lookX: -64, lookZ: 42, linger: 6 },
    { kind: 'hunt', at: 0 },
  ];
  /**
   * On the way to a stop, only somebody properly in the way starts a fight,
   * and it is kept short, or the walk never arrives.
   */
  const ENGAGE_RANGE_ERRAND = 13;
  const FIGHT_SECONDS_ERRAND = 7;

  const ap = {
    t: 0,
    log: [],
    errandIndex: 0,
    /** Seconds spent on the current errand, not counting fights and paint runs. */
    errandClock: 0,
    lingerLeft: null,
    path: [],
    pathIndex: 0,
    pathGoal: null,
    repathIn: 0,
    target: null,
    targetLostFor: 0,
    lastSeen: new Map(),
    velocities: new Map(),
    stuckClock: 0,
    stuckFrom: new V(),
    jumpFrames: 0,
    burstClock: 0,
    strafeSeed: 0,
    engagedTime: 0,
    ignoreUntil: new Map(),
    crateBlocked: new Map(),
    crate: null,

    /** Frames the camera spent at or below the lake's surface — should stay 0. */
    wetCameraFrames: 0,
    /** Frames the camera spent inside a collider — should stay 0. */
    cameraInsideFrames: 0,
    /** `play`: the last place a bot gave itself away, and the bot that last hit us. */
    heard: null,
    hitBy: null,
    searchSpot: null,
    /** What `playtest.mjs` reads. All times in simulated seconds. */
    metrics: {
      time: { fight: 0, restock: 0, travel: 0, idle: 0 },
      firstContact: null,
      fights: 0,
      fightEnds: { lost: 0, timeout: 0, paint: 0, stuck: 0, ammo: 0 },
      longestQuiet: 0,
      shots: 0,
      stuck: 0,
      rescues: 0,
      crates: 0,
    },
    quietSince: 0,
    huntIgnore: new Map(),

    note(message) {
      const stamp = ((ROUND ?? match.timeLeft) - match.timeLeft).toFixed(1);
      this.log.push(`${stamp}s ${message}`);
    },

    get errand() {
      return ITINERARY[Math.min(this.errandIndex, ITINERARY.length - 1)];
    },

    nextErrand(why) {
      this.errandIndex++;
      this.errandClock = 0;
      this.lingerLeft = null;
      this.path = [];
      this.note(`errand -> ${this.errand.kind} ${this.errand.label ?? ''} (${why})`);
    },

    chest(out = new V()) {
      return out.set(state.position.x, state.position.y + 1.4, state.position.z);
    },

    canSee(bot) {
      const eye = this.chest();
      const to = new V(bot.position.x, bot.position.y + 1.1, bot.position.z).sub(eye);
      const range = to.length();
      if (range < 0.01) return true;
      to.divideScalar(range);
      const hit = physics.raycast(eye, to, range - 0.4, state.collider ?? undefined);
      return !hit || hit.collider.handle === bot.collider.handle;
    },

    trackVelocities(dt) {
      for (const bot of characters.allBots) {
        const last = this.lastSeen.get(bot.id);
        const v = this.velocities.get(bot.id) ?? new V();
        if (last) {
          const raw = new V().subVectors(bot.position, last).divideScalar(dt);
          if (raw.length() > 12) raw.set(0, 0, 0); // a respawn, not a sprint
          v.lerp(raw, 0.35);
        }
        this.velocities.set(bot.id, v);
        this.lastSeen.set(bot.id, bot.position.clone());
      }
    },

    pickTarget() {
      let best = null;
      let bestRange = Infinity;
      const reach = this.errand.kind === 'hunt' ? ENGAGE_RANGE : ENGAGE_RANGE_ERRAND;
      for (const bot of characters.allBots) {
        const range = bot.position.distanceTo(state.position);
        if (range > reach || range >= bestRange) continue;
        if ((this.ignoreUntil.get(bot.id) ?? 0) > this.t) continue;
        if (POLICY === 'play' && !this.inView(bot)) continue;
        if (!this.canSee(bot)) continue;
        best = bot;
        bestRange = range;
      }
      return best;
    },

    /**
     * Inside the camera's view, or the one that just hit us — a person turns
     * toward being shot, and that is the one thing they learn from behind.
     */
    inView(bot) {
      if (this.hitBy && this.hitBy.id === bot.id && this.t - this.hitBy.at < 2) return true;
      const dx = bot.position.x - state.position.x;
      const dz = bot.position.z - state.position.z;
      return Math.abs(angleDelta(state.yaw, yawToward(dx, dz))) < VIEW_HALF_ANGLE;
    },

    /** `play`: where to look for a fight, from what could be heard or read off a sign. */
    searchGoal() {
      const px = state.position.x, pz = state.position.z;
      if (this.heard && this.t - this.heard.at < HEARD_SECONDS) {
        if (Math.hypot(this.heard.x - px, this.heard.z - pz) > 4) return this.heard;
        this.heard = null;
      }
      if (!this.searchSpot || Math.hypot(this.searchSpot.x - px, this.searchSpot.z - pz) < 5) {
        this.searchSpot = this.pickSearchSpot();
        if (this.searchSpot) this.note(`exploring toward ${this.searchSpot.name}`);
      }
      return this.searchSpot;
    },

    pickSearchSpot() {
      const nav = characters.navGrid;
      const px = state.position.x, pz = state.position.z;
      const options = [];
      for (const s of signs.places) {
        const spot = nav.nearestWalkable(s.faceX, s.faceZ, 6);
        if (!spot || wet(spot.x, spot.z)) continue;
        if (Math.hypot(spot.x - px, spot.z - pz) < 15) continue;
        options.push({ name: s.name, x: spot.x, z: spot.z });
      }
      return options.length ? options[Math.floor(rand() * options.length)] : null;
    },

    /** `play`: what a person could hear. Wired once, below. */
    listen() {
      game.events.on('shot:fired', (e) => {
        if (e.shooterId === 'player') {
          this.metrics.shots++;
          return;
        }
        if (POLICY !== 'play') return;
        const d = Math.hypot(e.origin.x - state.position.x, e.origin.z - state.position.z);
        if (d > HEARING_RANGE) return;
        // Placed by ear: roughly, and worse the further off it is.
        const slop = d * 0.12;
        this.heard = {
          x: e.origin.x + (rand() - 0.5) * 2 * slop,
          z: e.origin.z + (rand() - 0.5) * 2 * slop,
          at: this.t,
        };
      });
      game.events.on('hit:character', (e) => {
        if (e.targetId !== 'player') return;
        this.hitBy = { id: e.shooterId, at: this.t };
        const bot = characters.allBots.find((b) => b.id === e.shooterId);
        if (POLICY === 'play' && bot) this.heard = { x: bot.position.x, z: bot.position.z, at: this.t };
      });
      game.events.on('loot:taken', (e) => {
        if (e.characterId === 'player') this.metrics.crates++;
      });
    },

    endFight(reason) {
      this.metrics.fightEnds[reason]++;
      this.quietSince = this.t;
      this.target = null;
    },

    nearestBot() {
      let best = null;
      let bestRange = Infinity;
      for (const bot of characters.allBots) {
        if ((this.huntIgnore.get(bot.id) ?? 0) > this.t) continue;
        const range = bot.position.distanceTo(state.position);
        if (range < bestRange) { best = bot; bestRange = range; }
      }
      return best;
    },

    nearestCrate() {
      let best = null;
      let bestRange = Infinity;
      for (const crate of loot.crates) {
        if (crate.rounds <= 0) continue;
        if ((this.crateBlocked.get(crate) ?? 0) > this.t) continue;
        const range = crate.position.distanceTo(state.position);
        if (range < bestRange) { best = crate; bestRange = range; }
      }
      return best;
    },

    /** Paths toward (x, z), refreshing the route every so often. */
    routeTo(x, z, dt, force = false) {
      const nav = characters.navGrid;
      this.repathIn -= dt;
      const goalMoved = !this.pathGoal || Math.hypot(this.pathGoal.x - x, this.pathGoal.z - z) > 3;
      if (force || goalMoved || this.repathIn <= 0 || this.pathIndex >= this.path.length) {
        const from = state.position.clone();
        // Knocked off the grid — into the shallows, onto a bank — the route
        // starts from the nearest ground the grid knows about, or A* has
        // nowhere to start from and the player stands there for good.
        const onGrid = nav.isWalkable(from.x, from.z);
        const start = onGrid ? from : nav.nearestWalkable(from.x, from.z, 20);
        const path = start ? nav.findPath(start, new V(x, state.position.y, z)) : null;
        this.path = path ? (onGrid ? path : [start, ...path]) : [];
        this.pathIndex = 0;
        if (this.path.some((p, i) => i > 0 && wet(p.x, p.z)) && !playerWet() && !elevated()) {
          this.note(`route to (${x.toFixed(0)}, ${z.toFixed(0)}) runs along the shore, not taking it`);
          this.path = [];
          this.giveUp();
        }
        this.pathGoal = { x, z };
        this.repathIn = REPATH_SECONDS;
        if (!path) this.noPath = (this.noPath ?? 0) + 1;
      }
      while (this.pathIndex < this.path.length - 1) {
        const p = this.path[this.pathIndex];
        if (Math.hypot(p.x - state.position.x, p.z - state.position.z) > WAYPOINT_RADIUS) break;
        this.pathIndex++;
      }
      const p = this.path[this.pathIndex] ?? { x, z };
      const ahead = this.path[Math.min(this.pathIndex + 1, this.path.length - 1)] ?? p;
      return {
        dx: p.x - state.position.x,
        dz: p.z - state.position.z,
        // Look a little further along than the next corner, so the camera
        // turns into a bend rather than snapping at it.
        lookX: (p.x + ahead.x) / 2 - state.position.x,
        lookZ: (p.z + ahead.z) / 2 - state.position.z,
        remaining: Math.hypot(x - state.position.x, z - state.position.z),
      };
    },

    nearestDry() {
      const nav = characters.navGrid;
      const px = state.position.x, pz = state.position.z;
      for (let r = 2; r <= 24; r += 2) {
        let best = null;
        let bestD = Infinity;
        for (let a = 0; a < 16; a++) {
          const x = px + Math.cos(a / 16 * Math.PI * 2) * r;
          const z = pz + Math.sin(a / 16 * Math.PI * 2) * r;
          if (!nav.isWalkable(x, z) || wet(x, z)) continue;
          const d = Math.hypot(x - px, z - pz);
          if (d < bestD) { bestD = d; best = { x, z }; }
        }
        if (best) return best;
      }
      return null;
    },

    /** Walks a route, facing along it. */
    travel(cmd, x, z, dt, sprintOver) {
      const step = this.routeTo(x, z, dt);
      cmd.move = this.stickFor(step.dx, step.dz, 1);
      cmd.sprint = step.remaining > sprintOver;
      return { step, yaw: yawToward(step.lookX, step.lookZ) };
    },

    /** World-space travel direction to stick deflection, relative to the camera. */
    stickFor(dx, dz, magnitude) {
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) return [0, 0];
      const ux = dx / len;
      const uz = dz / len;
      const yaw = state.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      return [(ux * rx + uz * rz) * magnitude, (ux * fx + uz * fz) * magnitude];
    },

    /**
     * Keeps a stick deflection on walkable ground.
     *
     * Routes are made of walkable cells already; what is not is footwork. A
     * strafe on the lakeside walk carried the player into the shallows in the
     * first test round, and they spent the last ninety seconds of it there
     * with the camera inside the bank. So every deflection is checked a stride
     * ahead and swung round until it points at ground, or dropped.
     */
    safeStick(move) {
      const nav = characters.navGrid;
      const mag = Math.hypot(move[0], move[1]);
      if (mag < 0.05) return move;
      const px = state.position.x, pz = state.position.z;
      if (elevated() || !nav.isWalkable(px, pz) || wet(px, pz)) return move;
      const yaw = state.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const wx = (rx * move[0] + fx * move[1]) / mag;
      const wz = (rz * move[0] + fz * move[1]) / mag;
      for (const turn of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
        const c = Math.cos(turn), s = Math.sin(turn);
        const dx = wx * c - wz * s;
        const dz = wx * s + wz * c;
        const ok = (d) => nav.isWalkable(px + dx * d, pz + dz * d) && !wet(px + dx * d, pz + dz * d);
        if (ok(1.4) && ok(2.6) && ok(4)) {
          return [(dx * rx + dz * rz) * mag, (dx * fx + dz * fz) * mag];
        }
      }
      return [0, 0];
    },

    /**
     * Jumps over whatever is in the way, gives up on the errand if that does
     * not help, and as a last resort puts the player back on the grid.
     */
    unstick(wantsToMove, dt) {
      if (!wantsToMove) {
        this.stuckClock = 0;
        this.stuckStrikes = 0;
        this.stuckFrom.copy(state.position);
        return;
      }
      this.stuckClock += dt;
      if (this.stuckClock < 0.8) return;
      const moved = Math.hypot(state.position.x - this.stuckFrom.x, state.position.z - this.stuckFrom.z);
      this.stuckClock = 0;
      this.stuckFrom.copy(state.position);
      if (moved >= 0.9) {
        this.stuckStrikes = 0;
        return;
      }
      this.stuckStrikes = (this.stuckStrikes ?? 0) + 1;
      if (this.stuckStrikes === 1) this.metrics.stuck++;
      this.jumpFrames = 3;
      this.path = [];
      if (this.stuckStrikes === 4) {
        this.note(`stuck at (${state.position.x.toFixed(0)}, ${state.position.z.toFixed(0)}), dropping what I was doing`);
        this.giveUp();
      } else if (this.stuckStrikes >= 9) {
        const nav = characters.navGrid;
        const spot = nav.nearestWalkable(state.position.x, state.position.z, 20);
        if (spot) window.__paintball.player.teleport(new V(spot.x, spot.y + 0.1, spot.z));
        this.metrics.rescues++;
        this.note(`RESCUE teleport to (${spot?.x.toFixed(0)}, ${spot?.z.toFixed(0)})`);
        this.stuckStrikes = 0;
      }
    },

    giveUp() {
      if (this.target) {
        this.ignoreUntil.set(this.target.id, this.t + 20);
        this.endFight('stuck');
      } else if (this.crate) {
        this.crateBlocked.set(this.crate, this.t + 25);
        this.crate = null;
      } else if (this.errand.kind !== 'hunt') {
        this.nextErrand('stuck');
      } else if (POLICY === 'play') {
        this.heard = null;
        this.searchSpot = null;
      } else if (this.huntTarget) {
        this.huntIgnore.set(this.huntTarget.id, this.t + 25);
        this.huntTarget = null;
      } else {
        this.huntBlocked = this.t + 8;
      }
    },

    frame(dt) {
      ROUND ??= match.timeLeft;
      this.t += dt;
      this.trackVelocities(dt);

      const cmd = { move: [0, 0], fire: false, aim: false, sprint: false, jump: false };
      let wantYaw = null;
      let wantPitch = -0.06;
      let lookLambda = 3.2;
      let moving = false;

      // --- the opening beat: hold on the fountain as the whistle goes ---
      if (this.t < 1.6) {
        this.metrics.time.idle += dt;
        return this.apply(cmd, dt, state.yaw, -0.04, 2);
      }

      const ammo = match.ammo.get('player') ?? 0;

      // A scheduled stop comes due even mid-fight; the fight gets the errand's
      // shorter leash from here.
      const due = ITINERARY[this.errandIndex + 1];
      if (this.errand.kind === 'hunt' && due && ROUND - match.timeLeft >= due.at) {
        this.nextErrand('time for the next stop');
      }

      // --- paint first: a hopper running low ends the fight ---
      const crate = this.nearestCrate();
      const crateRange = crate ? crate.position.distanceTo(state.position) : Infinity;
      const needPaint = ammo < 30 || (ammo < 90 && !this.target);
      this.crate = needPaint && crate && crateRange < 140 ? crate : null;
      if (this.crate && this.target) {
        this.note(`breaking off ${this.target.id} for paint (${ammo} left)`);
        this.ignoreUntil.set(this.target.id, this.t + 8);
        this.endFight('paint');
      }

      // --- is there a fight? ---
      if (this.target) {
        const range = this.target.position.distanceTo(state.position);
        const visible = range < HOLD_RANGE && this.canSee(this.target);
        this.targetLostFor = visible ? 0 : this.targetLostFor + dt;
        if (this.targetLostFor > 1.4 || range > HOLD_RANGE || ammo <= 0) {
          this.note(`lost ${this.target.id}`);
          this.endFight(ammo <= 0 ? 'ammo' : 'lost');
          this.path = [];
        } else if (this.engagedTime > (this.errand.kind === 'hunt' ? FIGHT_SECONDS : FIGHT_SECONDS_ERRAND)) {
          // Long enough. A minute spent on one bot is a minute of the same shot.
          this.note(`done with ${this.target.id} after ${this.engagedTime.toFixed(0)}s`);
          this.ignoreUntil.set(this.target.id, this.t + 18);
          this.endFight('timeout');
          this.path = [];
        }
      }
      if (!this.target && !this.crate && ammo > 0) {
        const seen = this.pickTarget();
        if (seen) {
          this.target = seen;
          this.targetLostFor = 0;
          this.burstClock = 0;
          this.engagedTime = 0;
          this.strafeSeed = rand() * 10;
          this.metrics.fights++;
          this.metrics.firstContact ??= this.t;
          this.metrics.longestQuiet = Math.max(this.metrics.longestQuiet, this.t - this.quietSince);
          this.note(`engage ${seen.id} @ ${seen.position.distanceTo(state.position).toFixed(1)}m (${ammo} paint)`);
        }
      }

      if (this.target) {
        this.engagedTime += dt;
        const bot = this.target;
        const cam = game.render.camera.position;
        const flat = Math.hypot(bot.position.x - state.position.x, bot.position.z - state.position.z);

        // Lead and drop, from the flight time.
        const flight = flat / MUZZLE_SPEED;
        const v = this.velocities.get(bot.id) ?? new V();
        const aimX = bot.position.x + v.x * flight;
        const aimZ = bot.position.z + v.z * flight;
        const drop = 0.5 * GRAVITY * flight * flight * 1.25;
        const aimY = bot.position.y + 1.05 + drop;
        const dx = aimX - cam.x;
        const dz = aimZ - cam.z;
        wantYaw = yawToward(dx, dz);
        wantPitch = Math.atan2(aimY - cam.y, Math.hypot(dx, dz));
        lookLambda = 7;

        const yawError = Math.abs(angleDelta(state.yaw, wantYaw));
        const pitchError = Math.abs(wantPitch - state.pitch);
        cmd.aim = flat > 7 && this.engagedTime > 0.25;

        // Bursts: a short pull, a breath, another. A held trigger empties the
        // hopper in thirty seconds and looks like a machine; this looks like
        // somebody picking their shots.
        this.burstClock += dt;
        const cycle = this.burstClock % 1.6;
        const onTarget = yawError < 0.045 && pitchError < 0.05;
        cmd.fire = this.engagedTime > 0.45 && cycle < 0.7 && onTarget;

        // Footwork: strafe on a slow wave, and close or open the range.
        const s = Math.sin(this.t * 1.15 + this.strafeSeed);
        let forward = 0;
        if (flat > IDEAL_RANGE[1]) forward = 0.7;
        else if (flat < IDEAL_RANGE[0]) forward = -0.55;
        cmd.move = [s * 0.75, forward];
        moving = forward !== 0;

        const errand = this.errand;
        if (errand.kind !== 'hunt' && this.lingerLeft === null) {
          // On the way somewhere: keep walking the route and shoot on the move.
          const step = this.routeTo(errand.x, errand.z, dt);
          cmd.move = this.stickFor(step.dx, step.dz, 0.85);
          moving = true;
          this.errandClock += dt * 0.5;
        } else if (flat > IDEAL_RANGE[1] + 4) {
          // Far enough to need a route rather than a straight line.
          const step = this.routeTo(bot.position.x, bot.position.z, dt);
          const stick = this.stickFor(step.dx, step.dz, 0.7);
          cmd.move = [stick[0] + s * 0.3, stick[1]];
        }
      } else if (this.crate) {
        const crate = this.crate;
        if (this.lastCrateNote !== crate) {
          this.lastCrateNote = crate;
          this.note(`restock at ${crate.where}, ${crateRange.toFixed(0)}m (${ammo} left)`);
        }
        // May give the crate up on the way — `routeTo` refuses a shoreline
        // route by calling `giveUp`, which clears `this.crate` under us.
        const { yaw } = this.travel(cmd, crate.position.x, crate.position.z, dt, 6);
        wantYaw = yaw;
        moving = true;
      } else {
        const errand = this.errand;
        this.errandClock += dt;
        const upcoming = ITINERARY[this.errandIndex + 1];
        if (errand.kind === 'hunt') {
          if (upcoming && ROUND - match.timeLeft >= upcoming.at) {
            this.nextErrand('time for the next stop');
          } else if (POLICY === 'play') {
            const goal = this.searchGoal();
            if (goal) {
              wantYaw = this.travel(cmd, goal.x, goal.z, dt, 30).yaw;
              moving = true;
            }
          } else if (this.t > (this.huntBlocked ?? 0)) {
            const bot = this.nearestBot();
            this.huntTarget = bot;
            if (bot) {
              wantYaw = this.travel(cmd, bot.position.x, bot.position.z, dt, 30).yaw;
              moving = true;
            }
          }
        } else {
          // visit / mural: walk there, then stand and look.
          const remaining = Math.hypot(errand.x - state.position.x, errand.z - state.position.z);
          if (this.lingerLeft === null && remaining > 2.2) {
            wantYaw = this.travel(cmd, errand.x, errand.z, dt, 18).yaw;
            moving = true;
            if (this.errandClock > 50) this.nextErrand('could not get there');
          } else {
            if (this.lingerLeft === null) {
              this.lingerLeft = errand.linger;
              this.note(`arrived ${errand.kind} ${errand.label ?? ''}`);
            }
            this.lingerLeft -= dt;
            wantYaw = yawToward(errand.lookX - state.position.x, errand.lookZ - state.position.z);
            wantPitch = errand.kind === 'mural' ? 0.02 : -0.03;
            lookLambda = 2.2;
            if (this.lingerLeft <= 0) this.nextErrand('seen it');
          }
        }
      }

      // Standing on the shore anyway — knocked there, or strafed there before
      // the check could stop it: walk straight to the nearest dry ground.
      if (playerWet()) {
        if (!this.wasWet) this.note(`on the shore at (${state.position.x.toFixed(0)}, ${state.position.z.toFixed(0)}), getting off it`);
        this.wasWet = true;
        const dry = this.nearestDry();
        if (dry) {
          cmd.move = this.stickFor(dry.x - state.position.x, dry.z - state.position.z, 1);
          if (!this.target) wantYaw = yawToward(dry.x - state.position.x, dry.z - state.position.z);
          moving = true;
        }
      } else {
        this.wasWet = false;
      }
      const cam = game.render.camera.position;
      if (cam.y < WATER_Y + 0.25 && layout.lakeMask(cam.x, cam.z) > 0.01) this.wetCameraFrames++;
      if (this.cameraInside(cam)) {
        if (!this.wasCameraInside) {
          this.note(`camera inside geometry at (${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, ${cam.z.toFixed(1)}), ` +
                    `player at (${state.position.x.toFixed(1)}, ${state.position.y.toFixed(1)}, ${state.position.z.toFixed(1)})`);
        }
        this.wasCameraInside = true;
        this.cameraInsideFrames++;
      } else {
        this.wasCameraInside = false;
      }

      const mode = this.target ? 'fight'
        : this.crate ? 'restock'
        : this.lingerLeft === null && moving ? 'travel'
        : 'idle';
      this.metrics.time[mode] += dt;

      cmd.move = this.safeStick(cmd.move);
      this.unstick(moving, dt);
      if (this.jumpFrames > 0) {
        cmd.jump = true;
        this.jumpFrames--;
      }

      // A slow hand on the mouse, so the camera is never perfectly still.
      const sway = Math.sin(this.t * 0.47) * 0.012 + Math.sin(this.t * 0.83 + 1) * 0.006;
      return this.apply(cmd, dt, wantYaw ?? state.yaw, wantPitch + sway * 0.5, lookLambda, sway);
    },

    /** Whether the camera is inside something solid. Sensors, like crates, do not count. */
    cameraInside(cam) {
      let inside = false;
      physics.w.intersectionsWithPoint({ x: cam.x, y: cam.y, z: cam.z }, (collider) => {
        if (collider.isSensor() || collider.handle === state.collider?.handle) return true;
        inside = true;
        return false;
      });
      return inside;
    },

    apply(cmd, dt, wantYaw, wantPitch, lambda, sway = 0) {
      state.yaw = dampAngle(state.yaw, wantYaw + sway, lambda, dt);
      state.pitch = dampTo(state.pitch, wantPitch, lambda, dt);

      input.setTouchMove(cmd.move[0], cmd.move[1]);
      input.setTouchAction('sprint', !!cmd.sprint);
      input.setTouchAction('fire', !!cmd.fire);
      input.setTouchAction('aim', !!cmd.aim);
      input.setTouchAction('jump', !!cmd.jump);
      game.stepSim(dt);
      return cmd;
    },

    release() {
      input.clearTouchMove();
      for (const action of ['fire', 'aim', 'jump', 'crouch', 'sprint']) {
        input.setTouchAction(action, false);
      }
    },
  };

  ap.listen();
  window.__autopilot = ap;
})();
