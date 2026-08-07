import { BoxGeometry, Group, Mesh, type MeshToonMaterial } from 'three';
import { player as playerConfig } from '../core/Config';
import { dampAngle } from '../core/MathUtils';
import { createCelMaterial } from '../render/CelMaterial';
import type { GameContext, System } from '../core/System';
import type { PlayerState } from './PlayerState';

/**
 * Placeholder blocky avatar so movement and camera work are visible.
 *
 * Deliberately crude — phase 5 replaces this with the real procedural voxel rig
 * and its animation set. What it does establish is the contract: the avatar
 * reads PlayerState and nothing else, and it honours `avatarOpacity` so the
 * camera can dissolve it when pulled in close.
 */
export class PlayerAvatarSystem implements System {
  readonly name = 'player-avatar';

  private group = new Group();
  private materials: MeshToonMaterial[] = [];
  private geometries: BoxGeometry[] = [];
  private renderYaw = 0;

  constructor(private readonly state: PlayerState) {}

  init(ctx: GameContext): void {
    const skin = this.material(0xf2c9a0);
    const shirt = this.material(0x3f8fd0);
    const trousers = this.material(0x3a4b6d);

    // Proportions roughly match a Minecraft figure scaled to a 1.8m capsule.
    this.addPart(0.62, 0.9, 0.34, 0, 1.0, 0, shirt); // torso
    this.addPart(0.46, 0.46, 0.46, 0, 1.68, 0, skin); // head
    this.addPart(0.2, 0.85, 0.28, -0.42, 1.0, 0, shirt); // left arm
    this.addPart(0.2, 0.85, 0.28, 0.42, 1.0, 0, shirt); // right arm
    this.addPart(0.26, 0.55, 0.3, -0.17, 0.28, 0, trousers); // left leg
    this.addPart(0.26, 0.55, 0.3, 0.17, 0.28, 0, trousers); // right leg
    // Brim, so facing is unambiguous from any angle.
    this.addPart(0.5, 0.08, 0.22, 0, 1.5, -0.28, this.material(0xff3d81));

    ctx.scene.add(this.group);
  }

  update(dt: number, _alpha: number): void {
    const { state } = this;

    this.group.position.copy(state.renderPosition);

    // Smooth the visual turn a second time. The controller already eases
    // bodyYaw, but at the fixed rate; this removes the last of the stepping.
    this.renderYaw = dampAngle(this.renderYaw, state.bodyYaw, 20, dt);
    this.group.rotation.y = this.renderYaw;

    // Crude squash for crouch — the real rig gets a proper pose in phase 5.
    this.group.scale.y = state.height / playerConfig.height;

    const opacity = state.avatarOpacity;
    const transparent = opacity < 0.999;
    this.group.visible = opacity > 0.01;
    for (const material of this.materials) {
      material.opacity = opacity;
      material.transparent = transparent;
      material.depthWrite = !transparent;
    }
  }

  private material(color: number): MeshToonMaterial {
    // A stronger rim than world geometry: characters need to pop off the
    // background, which is exactly what a painted highlight does.
    const material = createCelMaterial({ color, rimStrength: 0.42 });
    this.materials.push(material);
    return material;
  }

  private addPart(
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    material: MeshToonMaterial,
  ): void {
    const geometry = new BoxGeometry(width, height, depth);
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
  }
}
