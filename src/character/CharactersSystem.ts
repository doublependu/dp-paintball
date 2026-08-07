import { Vector3 } from 'three';
import { player as playerConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import { Bot, type BotTarget } from '../ai/Bot';
import { NavGrid } from '../ai/NavGrid';
import { PERSONALITIES } from '../ai/Personality';
import type { BallisticsSystem } from '../gameplay/Ballistics';
import type { PlayerState } from '../gameplay/PlayerState';
import { SplatAtlas } from '../paint/SplatAtlas';
import { Character } from './Character';
import type { CharacterRegistry } from './CharacterRegistry';
import type { AnimationInput } from './CharacterAnimator';

export interface BotSpec {
  id: string;
  position: Vector3;
  colorIndex: number;
  /** Index into PERSONALITIES. */
  personality: number;
}

/**
 * Owns every character in the match and routes hits to them.
 *
 * The player's character is posed from PlayerState; standing dummies exist so
 * character paint and hit routing are exercisable before the bots arrive in
 * phase 6, and they become the bots' bodies when they do.
 */
export class CharactersSystem implements System {
  readonly name = 'characters';

  private player?: Character;
  private bots: Bot[] = [];
  private splatAtlas?: SplatAtlas;
  private nav?: NavGrid;
  /** Rebuilt each step; bots read it to find someone to shoot at. */
  private targets: BotTarget[] = [];

  private readonly input: AnimationInput = {
    speed: 0,
    runSpeed: playerConfig.sprintSpeed,
    grounded: true,
    crouching: false,
    aiming: false,
    verticalVelocity: 0,
    moveLocalX: 0,
    moveLocalY: 0,
    aimPitch: 0,
  };

  constructor(
    private readonly state: PlayerState,
    private readonly characters: CharacterRegistry,
    private readonly ballistics: BallisticsSystem,
    private readonly botSpecs: BotSpec[] = [],
  ) {}

  init(ctx: GameContext): void {
    // One atlas shared by every character's paint stamper — the splat shapes
    // are identical, only the tint differs.
    this.splatAtlas = new SplatAtlas();

    this.player = new Character(
      { id: 'player', colorIndex: 0, paintSize: 512 },
      ctx,
      this.splatAtlas,
    );
    // The player's collider is the character controller's capsule, created in
    // phase 1 and published on PlayerState.
    if (this.state.collider) {
      this.player.attachCollider(this.state.collider);
      this.characters.register(this.state.collider.handle, 'player');
    }

    // Built after the arena, so every prop collider is already in the world.
    // Existing is not enough, though: scene queries only see colliders that
    // were present at the last step, so the world must be stepped first or the
    // grid is computed against an empty park.
    ctx.physics.refreshQueries();
    this.nav = new NavGrid(ctx.physics);
    // Seeded from the player spawn, so "walkable" means "reachable from where
    // the player starts" — which is the only definition that helps a bot.
    this.nav.pruneUnreachable(this.state.position.x, this.state.position.z);

    for (const spec of this.botSpecs) {
      const character = new Character(
        { id: spec.id, colorIndex: spec.colorIndex, paintSize: 256 },
        ctx,
        this.splatAtlas,
      );
      // Drop the spawn onto the ground, and onto a cell that is actually
      // walkable — a bot spawned inside the fountain would never path anywhere.
      const grounded =
        this.nav.nearestWalkable(spec.position.x, spec.position.z) ??
        new Vector3(spec.position.x, this.nav.groundAt(spec.position.x, spec.position.z), spec.position.z);

      const bot = new Bot(spec.id, PERSONALITIES[spec.personality % PERSONALITIES.length]!,
                          character, grounded, ctx);
      this.characters.register(bot.collider.handle, spec.id);
      this.bots.push(bot);
    }

    ctx.events.on('hit:character', (event) => this.onHit(event, ctx));
  }

  private onHit(
    event: { targetId: string; shooterId: string; color: number; point: Vector3; impactSpeed: number },
    ctx: GameContext,
  ): void {
    const target = this.find(event.targetId);
    if (!target || !this.splatAtlas) return;

    const registered = target.takeHit(
      event.point,
      event.color,
      event.impactSpeed,
      ctx.rng,
      this.splatAtlas.variants,
    );
    if (!registered) return;

    const shooter = this.find(event.shooterId);
    if (shooter && shooter !== target) shooter.hitsGiven++;

    // Reactions: the target scurries, the shooter may celebrate.
    this.bots.find((b) => b.id === event.targetId)?.onHit(ctx.rng);
    this.bots.find((b) => b.id === event.shooterId)?.onScored(ctx.rng);

    ctx.events.emit('score:changed', {
      characterId: target.id,
      hitsTaken: target.hitsTaken,
      hitsGiven: target.hitsGiven,
    });
  }

  private find(id: string): Character | undefined {
    if (id === 'player') return this.player;
    return this.bots.find((b) => b.id === id)?.character;
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    // Taunt is an input, so it belongs on the fixed step with the rest.
    if (ctx.input.wasPressed('taunt')) this.player?.animator.triggerTaunt();

    // Grace windows tick in simulation time.
    this.player?.tickGameplay(dt);
    for (const bot of this.bots) bot.character.tickGameplay(dt);

    if (!this.nav) return;

    // One shared candidate list per step, rather than each bot rebuilding it.
    this.targets.length = 0;
    this.targets.push({
      id: 'player',
      position: PLAYER_CHEST.set(
        this.state.position.x,
        this.state.position.y + 1.25,
        this.state.position.z,
      ),
      collider: this.state.collider ?? undefined,
    });
    for (const bot of this.bots) {
      this.targets.push({ id: bot.id, position: bot.chest.clone(), collider: bot.collider });
    }

    for (const bot of this.bots) {
      bot.fixedUpdate(dt, ctx, this.nav, this.targets, this.bots, this.ballistics);
    }
  }

  update(dt: number, _alpha: number, ctx: GameContext): void {
    const player = this.player;
    if (!player) return;

    const { state } = this;
    player.setTransform(state.renderPosition, state.bodyYaw);
    player.setOpacity(state.avatarOpacity);

    // Movement direction expressed in the body's own frame, so the animator can
    // tell walking forward from sidestepping.
    const forwardX = -Math.sin(state.bodyYaw);
    const forwardZ = -Math.cos(state.bodyYaw);
    const rightX = Math.cos(state.bodyYaw);
    const rightZ = -Math.sin(state.bodyYaw);
    const vx = state.velocity.x;
    const vz = state.velocity.z;
    const speed = Math.hypot(vx, vz);
    const inv = speed > 0.001 ? 1 / speed : 0;

    this.input.speed = speed;
    this.input.grounded = state.grounded;
    this.input.crouching = state.crouching;
    this.input.aiming = state.aiming;
    this.input.verticalVelocity = state.velocity.y;
    this.input.moveLocalX = (vx * rightX + vz * rightZ) * inv;
    this.input.moveLocalY = (vx * forwardX + vz * forwardZ) * inv;
    this.input.aimPitch = state.pitch;

    player.update(dt, this.input);

    for (const bot of this.bots) {
      bot.character.update(dt, bot.animationInput);
    }

    void ctx;
  }

  /** Triggers the player's shooting pose. Called when a shot is fired. */
  onPlayerShot(): void {
    this.player?.animator.triggerShot();
  }

  get playerCharacter(): Character | undefined {
    return this.player;
  }

  get allCharacters(): Character[] {
    const bots = this.bots.map((b) => b.character);
    return this.player ? [this.player, ...bots] : bots;
  }

  get allBots(): Bot[] {
    return this.bots;
  }

  get navGrid(): NavGrid | undefined {
    return this.nav;
  }

  dispose(): void {
    this.player?.dispose();
    for (const bot of this.bots) bot.character.dispose();
    this.bots = [];
    this.splatAtlas?.dispose();
  }
}

const PLAYER_CHEST = new Vector3();
