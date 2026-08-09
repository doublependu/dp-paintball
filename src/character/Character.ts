import type * as RapierNS from '@dimforge/rapier3d';
import { Color, Matrix4, Mesh, Vector3 } from 'three';
import { paint as paintConfig, paintColors, player as playerConfig } from '../core/Config';
import { clamp, remap } from '../core/MathUtils';
import type { Rng } from '../core/Random';
import type { GameContext } from '../core/System';
import type { SplatAtlas } from '../paint/SplatAtlas';
import { CharacterAnimator, type AnimationInput } from './CharacterAnimator';
import { CharacterPaint } from './CharacterPaint';
import { createRigMaterial, type RigMaterialHandle } from './RigMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';
import { HUMAN_PARTS, VoxelRig, type RigPart } from './VoxelRig';

export interface CharacterOptions {
  id: string;
  /** Team colour, used for the shirt and this character's own paint. */
  colorIndex: number;
}

/**
 * One blocky figure: rig, animation, paint target and score.
 *
 * Characters do not move themselves. The player's is driven from PlayerState
 * and bots will be driven by the AI in phase 6 — this class is only responsible
 * for how a character *looks and reacts*, which keeps it usable by both.
 */
export class Character {
  readonly id: string;
  readonly rig: VoxelRig;
  readonly mesh: Mesh;
  /** Inverted-hull shell drawn behind the body to give it a confident ink line. */
  readonly hull: Mesh;
  readonly animator = new CharacterAnimator();
  readonly paint: CharacterPaint;
  readonly color: number;

  /** Score counters. Nobody dies; this is the whole scoreboard. */
  hitsTaken = 0;
  hitsGiven = 0;

  /** Grace period after being hit, in seconds. */
  private invulnTimer = 0;

  private readonly material: RigMaterialHandle;
  private readonly worldMatrix = new Matrix4();
  private readonly paintPoint = new Vector3();
  private readonly paintNormal = new Vector3();
  private collider?: RapierNS.Collider;

  constructor(
    options: CharacterOptions,
    ctx: GameContext,
    splatAtlas: SplatAtlas,
  ) {
    this.id = options.id;
    this.color = paintColors[options.colorIndex % paintColors.length]!;

    // Tint the shirt to the team colour so who's who is readable at a glance.
    // Shirt, cap and sleeves all take the team colour, but the sleeves are
    // darkened so the arms still read as separate limbs against the torso.
    const sleeve = new Color(this.color).multiplyScalar(0.78).getHex();
    const parts: RigPart[] = HUMAN_PARTS.map((part) => {
      if (part.name === 'torso' || part.name === 'cap' || part.name === 'brim') {
        return { ...part, color: this.color };
      }
      if (part.name === 'armL' || part.name === 'armR') {
        return { ...part, color: sleeve };
      }
      return part;
    });

    this.rig = new VoxelRig(parts);
    this.paint = new CharacterPaint();
    this.material = createRigMaterial(this.paint, splatAtlas);

    this.mesh = new Mesh(this.rig.geometry, this.material.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Picked up by the outline prepass in place of the generic normal material,
    // so the character appears in the normal buffer in its animated pose.
    this.mesh.userData.normalMaterial = this.material.normalMaterial;

    // The hull shares the rig's geometry — same vertices, expanded in its own
    // vertex shader. Excluded from the outline prepass, because a shell sitting
    // slightly proud of the body would otherwise register as a second edge and
    // double every line.
    this.hull = new Mesh(this.rig.geometry, this.material.hullMaterial);
    this.hull.castShadow = false;
    this.hull.receiveShadow = false;
    this.hull.layers.set(NO_OUTLINE_LAYER);
    // Drawn before the body so the body covers the shell's interior.
    this.hull.renderOrder = -1;

    this.rig.root.add(this.hull);
    this.rig.root.add(this.mesh);
    ctx.scene.add(this.rig.root);
  }

  /** Associates a physics collider so impacts can be routed to this character. */
  attachCollider(collider: RapierNS.Collider): void {
    this.collider = collider;
  }

  get colliderHandle(): number | undefined {
    return this.collider?.handle;
  }

  get isInvulnerable(): boolean {
    return this.invulnTimer > 0;
  }

  setTransform(position: Vector3, yaw: number): void {
    this.rig.root.position.copy(position);
    this.rig.root.rotation.y = yaw;
  }

  setOpacity(opacity: number): void {
    const visible = opacity > 0.01;
    this.mesh.visible = visible;
    this.hull.visible = visible;
    this.material.setOpacity(opacity);
  }

  /**
   * Gameplay timers. Must be driven from the fixed step, not from the render
   * frame: the grace window is a rule, and a rule that expires faster on a slow
   * machine is not a rule.
   */
  tickGameplay(dt: number): void {
    this.invulnTimer = Math.max(0, this.invulnTimer - dt);
  }

  /** Advances animation and uploads the posed skeleton. Render-rate. */
  update(dt: number, input: AnimationInput): void {
    this.animator.update(dt, input, this.rig);
    this.material.setJoints(this.rig.jointMatrices);
  }

  /**
   * Registers a hit: records paint where it landed, flinches, and scores.
   * Returns false if the hit was inside the grace window and ignored.
   */
  takeHit(
    point: Vector3,
    normal: Vector3,
    color: number,
    impactSpeed: number,
    rng: Rng,
    splatVariants: number,
  ): boolean {
    if (this.invulnTimer > 0) return false;
    this.invulnTimer = playerConfig.hitInvulnSeconds;
    this.hitsTaken++;
    this.animator.triggerFlinch();

    this.rig.root.updateMatrixWorld(true);
    this.worldMatrix.copy(this.rig.root.matrixWorld);

    // Drawn unconditionally, before anything that might bail. `rng` is the
    // match's shared sequence, so if the number of draws depended on where a
    // splat happened to land, one hit clipping the edge of a limb would shift
    // every bot decision that followed it.
    const variant = rng.int(0, splatVariants);
    const rotation = rng.range(0, Math.PI * 2);

    const joint = this.rig.resolvePaintAnchor(
      point,
      normal,
      this.worldMatrix,
      this.paintPoint,
      this.paintNormal,
    );
    // Landed on the collider but clear of every box — the capsule is a little
    // more generous than the figure inside it.
    if (joint < 0) return true;

    const speedScale = clamp(
      remap(impactSpeed, 12, 42, paintConfig.minSplatScale, paintConfig.maxSplatScale),
      paintConfig.minSplatScale,
      paintConfig.maxSplatScale,
    );

    this.paint.add(
      this.paintPoint,
      this.paintNormal,
      joint,
      paintConfig.characterSplatRadius * speedScale,
      color,
      variant,
      rotation,
    );
    return true;
  }

  dispose(): void {
    this.rig.root.removeFromParent();
    this.rig.dispose();
    // No paint.dispose(): paint is three Float32Arrays now, not a GPU resource.
    this.material.dispose();
  }
}
