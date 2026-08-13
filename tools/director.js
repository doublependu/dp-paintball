/**
 * In-page director, shared by tools/record.mjs and tools/stills.mjs.
 *
 * Injected into the running game with `addScriptTag`, and called once per
 * captured frame. It lives in the page because the two things it needs — the
 * input surfaces and the characters' live positions — are both in there, and
 * shipping them out to node and back for every frame would double the cost of
 * a recording.
 *
 * Controls are driven through `setTouchMove` and `setTouchAction`, the same
 * surfaces the on-screen thumb controls write into, so a capture exercises the
 * real controller, physics and weapon rather than a camera flown through the
 * scene on rails. Look is set on the player state directly, because the
 * alternative is synthesising mouse deltas and the capture has no pointer lock
 * to generate them from.
 */
(() => {
  const { game, state, player, characters } = window.__paintball;
  const input = game.input;

  /** Exponential approach, frame-rate independent. Matches src/core/MathUtils. */
  const dampTo = (current, target, lambda, dt) =>
    target + (current - target) * Math.exp(-lambda * dt);

  const dampAngle = (current, target, lambda, dt) => {
    const delta =
      ((target - current + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return current + delta * (1 - Math.exp(-lambda * dt));
  };

  /**
   * Where the rest of the cast gets sent. Corners of the play area, snapped to
   * walkable ground when they are asked for — several of these land in the lake
   * or the woodland belt as written.
   */
  const CORNERS = [[-72, -66], [70, -64], [-74, 70], [66, 72], [-80, 6], [78, 12]];

  window.__director = {
    /** Id of the bot the camera is currently following, if any. */
    target: null,

    /**
     * Sends every bot but `exceptId` to the far side of the park.
     *
     * Pinning holds the bot being fought; it does nothing about the other five,
     * and they roam the whole map. One standing *behind* the player is the
     * worst case, and it happened repeatedly: the camera's spring arm collides
     * with it, collapses, fades the player's own avatar out, and the frame
     * becomes a close-up of a stranger's back. A duel is a two-hander, so the
     * rest of the cast is walked off set.
     */
    clearField(exceptId = null, from = null) {
      const nav = characters.navGrid;
      const V = state.position.constructor;
      if (!nav) return;
      const ref = from ?? state.position;
      const ranked = CORNERS
        .map((c) => nav.nearestWalkable(c[0], c[1]) ?? new V(c[0], nav.groundAt(c[0], c[1]), c[1]))
        .sort((a, b) =>
          Math.hypot(b.x - ref.x, b.z - ref.z) - Math.hypot(a.x - ref.x, a.z - ref.z));
      let next = 0;
      for (const bot of characters.allBots) {
        if (bot.id === exceptId) continue;
        bot.respawn(ranked[next % ranked.length].clone());
        next++;
      }
    },

    /**
     * Places a fight: both fighters on chosen ground, facing each other, with
     * the rest of the cast cleared away.
     *
     * Both spots go through `nearestWalkable`, the navgrid's own answer to "may
     * somebody stand here" — the same one the bots' spawns are snapped through
     * at init. Asking it rather than trusting the coordinates written in the
     * shot list is what stops a staged fight ending up in the lake or inside
     * the fountain basin when the terrain shifts.
     *
     * Whichever bot is already closest to the mark gets the part, so nobody is
     * dragged across the park.
     *
     * The player is also topped back up to a full load. Three fights of three
     * bursts is most of a hundred rounds, and a marker that dry-clicks in the
     * last shot of the film is not the note to end on.
     */
    stage(px, pz, bx, bz) {
      const nav = characters.navGrid;
      const V = state.position.constructor;
      if (!nav) return null;

      const spot = nav.nearestWalkable(px, pz) ?? new V(px, nav.groundAt(px, pz), pz);
      const mark = nav.nearestWalkable(bx, bz) ?? new V(bx, nav.groundAt(bx, bz), bz);

      let best = null;
      let bestDistance = Infinity;
      for (const bot of characters.allBots) {
        const d = Math.hypot(bot.position.x - mark.x, bot.position.z - mark.z);
        if (d < bestDistance) { bestDistance = d; best = bot; }
      }
      if (!best) return null;

      best.respawn(mark.clone());
      this.clearField(best.id, spot);

      // Clear of the ground by a hair, so the drop settles rather than starting
      // with the capsule interpenetrating the terrain.
      player.teleport(new V(spot.x, spot.y + 0.1, spot.z));

      const dx = mark.x - spot.x;
      const dz = mark.z - spot.z;
      const length = Math.hypot(dx, dz) || 1;
      state.yaw = Math.atan2(-dx / length, -dz / length);
      state.pitch = 0.02;
      this.target = best.id;

      window.__paintball.match.ammo.set('player', 100);
      return { id: best.id, range: +length.toFixed(1) };
    },

    /**
     * Holds a bot where it stands, so a shot framed on it stays framed.
     *
     * Invisible: it respawns the bot at the position it is already at. What it
     * actually does is drop the path, which is what stops a charging
     * personality closing to arm's length mid-shot. It does not touch paint —
     * splats already landed stay on the body.
     */
    pin(id) {
      const bot = characters.allBots.find((b) => b.id === id);
      if (bot) bot.respawn(bot.position.clone());
    },

    /**
     * Covers the tracked target in paint, from the side the camera is on.
     *
     * Hits are synthesised rather than fired. A burst from a real marker lands
     * a different number of splats every run and spends most of them on the
     * grass, and this is the one shot whose entire subject is a body with paint
     * on it. They are placed on the capsule surface, which is where real
     * impacts come from, so what the shader receives is what it would receive
     * in a game.
     */
    paintTarget(splats = 14) {
      const { game } = window.__paintball;
      const V = state.position.constructor;
      const bot = characters.allBots.find((b) => b.id === this.target);
      if (!bot) return 0;

      const facing = Math.atan2(state.position.x - bot.position.x,
                                state.position.z - bot.position.z);
      const colors = [0xff3d81, 0xa8e337, 0x00d4e8, 0xffa63d];
      for (let i = 0; i < splats; i++) {
        const angle = facing + ((i % 5) - 2) * 0.38;
        const height = 0.75 + Math.floor(i / 5) * 0.38;
        bot.character.tickGameplay(5);
        game.events.emit('hit:character', {
          targetId: bot.id,
          shooterId: 'player',
          color: colors[i % colors.length],
          point: new V(bot.position.x + Math.sin(angle) * 0.35,
                       bot.position.y + height,
                       bot.position.z + Math.cos(angle) * 0.35),
          normal: new V(Math.sin(angle), 0, Math.cos(angle)),
          impactSpeed: 38,
        });
      }
      return bot.character.paint.splatCount;
    },

    teleport(x, y, z, yaw, pitch) {
      const V = state.position.constructor;
      player.teleport(new V(x, y, z));
      state.yaw = yaw;
      state.pitch = pitch;
    },

    /** Applies one frame of control input, then advances the sim by `dt`. */
    frame(cmd, dt) {
      if (cmd.move) input.setTouchMove(cmd.move[0], cmd.move[1]);
      else input.clearTouchMove();
      // setTouchMove infers sprint from stick deflection; the shot has the
      // final say, so this is set after it rather than before.
      input.setTouchAction('sprint', !!cmd.sprint);
      input.setTouchAction('fire', !!cmd.fire);
      input.setTouchAction('aim', !!cmd.aim);
      input.setTouchAction('jump', !!cmd.jump);
      input.setTouchAction('crouch', !!cmd.crouch);

      if (cmd.track && this.target) {
        const bot = characters.allBots.find((b) => b.id === this.target);
        if (bot) {
          const dx = bot.position.x - state.position.x;
          const dz = bot.position.z - state.position.z;
          const flat = Math.hypot(dx, dz) || 1;
          // The bias pushes the target off the centre of the frame.
          //
          // Increasing yaw turns the camera left, which slides the world right
          // — and right is where there is room, because the over-the-shoulder
          // rig parks the player's own body just left of centre. Tracked
          // dead-on, a target sits exactly behind their head.
          const wantYaw = Math.atan2(-dx / flat, -dz / flat) + (cmd.track.bias ?? 0);
          const eye = state.position.y + 1.5;
          const wantPitch = Math.atan2((bot.position.y + cmd.track.aimHeight) - eye, flat);
          state.yaw = dampAngle(state.yaw, wantYaw, cmd.track.damping, dt);
          state.pitch = dampTo(state.pitch, wantPitch, cmd.track.damping, dt);
        }
      } else {
        if (cmd.yaw !== undefined) state.yaw = cmd.yaw;
        if (cmd.pitch !== undefined) state.pitch = cmd.pitch;
      }

      game.stepSim(dt);
    },

    /** Releases everything, so a shot cannot leak a held trigger into the next. */
    release() {
      input.clearTouchMove();
      for (const action of ['fire', 'aim', 'jump', 'crouch', 'sprint']) {
        input.setTouchAction(action, false);
      }
    },
  };
})();
