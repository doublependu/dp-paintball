import type * as RapierNS from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { player as playerConfig } from '../core/Config';
import type { GameContext, System } from '../core/System';
import type { PlayerState } from '../gameplay/PlayerState';
import { SplatAtlas } from '../paint/SplatAtlas';
import { Character } from './Character';
import type { CharacterRegistry } from './CharacterRegistry';
import type { AnimationInput } from './CharacterAnimator';

export interface DummySpec {
  id: string;
  position: Vector3;
  yaw: number;
  colorIndex: number;
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
  private dummies: Character[] = [];
  private splatAtlas?: SplatAtlas;
  private dummyBodies: RapierNS.RigidBody[] = [];

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

  private readonly idleInput: AnimationInput = {
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
    private readonly dummySpecs: DummySpec[] = [],
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

    for (const spec of this.dummySpecs) {
      const dummy = new Character(
        { id: spec.id, colorIndex: spec.colorIndex, paintSize: 256 },
        ctx,
        this.splatAtlas,
      );
      dummy.setTransform(spec.position, spec.yaw);

      // A static capsule matching the rig, so paintballs can hit it.
      const half = playerConfig.height / 2 - playerConfig.radius;
      const body = ctx.physics.w.createRigidBody(
        ctx.physics.api.RigidBodyDesc.fixed().setTranslation(
          spec.position.x,
          spec.position.y + playerConfig.height / 2,
          spec.position.z,
        ),
      );
      const collider = ctx.physics.w.createCollider(
        ctx.physics.api.ColliderDesc.capsule(half, playerConfig.radius),
        body,
      );
      dummy.attachCollider(collider);
      this.characters.register(collider.handle, spec.id);
      this.dummyBodies.push(body);
      this.dummies.push(dummy);
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

    ctx.events.emit('score:changed', {
      characterId: target.id,
      hitsTaken: target.hitsTaken,
      hitsGiven: target.hitsGiven,
    });
  }

  private find(id: string): Character | undefined {
    if (id === 'player') return this.player;
    return this.dummies.find((d) => d.id === id);
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    // Taunt is an input, so it belongs on the fixed step with the rest.
    if (ctx.input.wasPressed('taunt')) this.player?.animator.triggerTaunt();

    // Grace windows tick in simulation time.
    this.player?.tickGameplay(dt);
    for (const dummy of this.dummies) dummy.tickGameplay(dt);
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

    for (const dummy of this.dummies) {
      dummy.update(dt, this.idleInput);
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
    return this.player ? [this.player, ...this.dummies] : [...this.dummies];
  }

  dispose(): void {
    this.player?.dispose();
    for (const dummy of this.dummies) dummy.dispose();
    this.dummies = [];
    this.dummyBodies = [];
    this.splatAtlas?.dispose();
  }
}
