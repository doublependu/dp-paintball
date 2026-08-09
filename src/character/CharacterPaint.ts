import { Color, Vector3 } from 'three';
import { paint as paintConfig } from '../core/Config';
import { JOINT_COUNT } from './VoxelRig';

/** Floats per splat in each of the three uniform buffers. */
const STRIDE = 4;

/**
 * Per-character paint, held as a list of splats rather than a texture.
 *
 * World paint uses decals, but a decal is baked against static geometry — on an
 * animated limb it would need reprojecting every frame. The obvious fix is to
 * give each character a paint texture and stamp into it, and that is what this
 * was: a render target, an orthographic camera, and a scissored quad per hit.
 *
 * It works, but it pays a texture, a render pass per hit and a whole UV atlas
 * to store something a body only ever holds a handful of. Splats are instead
 * kept as plain numbers here and evaluated by the rig's fragment shader, in the
 * one space where paint is free to sit still: the *joint's* own frame. Nothing
 * needs reprojecting, because in that frame an elbow never moves.
 *
 * Buffers are laid out for direct upload as `vec4[]` uniforms — see
 * `createRigMaterial`, which reads them in place.
 */
export class CharacterPaint {
  readonly max: number;
  /** centre.xyz, radius. Joint-local metres. */
  readonly bufferA: Float32Array;
  /** normal.xyz, rotation. The axis the splat is projected along. */
  readonly bufferB: Float32Array;
  /** colour.rgb, and joint + variant * JOINT_COUNT packed into one float. */
  readonly bufferC: Float32Array;

  private count = 0;

  constructor(max = paintConfig.characterMaxSplats) {
    this.max = max;
    this.bufferA = new Float32Array(max * STRIDE);
    this.bufferB = new Float32Array(max * STRIDE);
    this.bufferC = new Float32Array(max * STRIDE);
  }

  get splatCount(): number {
    return this.count;
  }

  /** Wipes all paint from this character. */
  clear(): void {
    this.count = 0;
  }

  /**
   * Records a splat.
   *
   * `centre` and `normal` are in the frame of `joint`; `radius` is in metres.
   * Once full, the oldest splat is dropped — splats are held in the order they
   * landed, because the shader lets later ones paint over earlier ones and that
   * only reads correctly if the order is the order they arrived in.
   */
  add(
    centre: Vector3,
    normal: Vector3,
    joint: number,
    radius: number,
    color: number,
    variant: number,
    rotation: number,
  ): void {
    if (this.count === this.max) {
      // Shifting beats a ring buffer here: it keeps the arrays in draw order,
      // so the shader needs no wrap-around, and it happens once per hit rather
      // than once per pixel.
      this.bufferA.copyWithin(0, STRIDE);
      this.bufferB.copyWithin(0, STRIDE);
      this.bufferC.copyWithin(0, STRIDE);
      this.count--;
    }

    const at = this.count * STRIDE;

    this.bufferA[at] = centre.x;
    this.bufferA[at + 1] = centre.y;
    this.bufferA[at + 2] = centre.z;
    this.bufferA[at + 3] = radius;

    this.bufferB[at] = normal.x;
    this.bufferB[at + 1] = normal.y;
    this.bufferB[at + 2] = normal.z;
    this.bufferB[at + 3] = rotation;

    SCRATCH_COLOR.setHex(color);
    this.bufferC[at] = SCRATCH_COLOR.r;
    this.bufferC[at + 1] = SCRATCH_COLOR.g;
    this.bufferC[at + 2] = SCRATCH_COLOR.b;
    // Both are small integers and float32 holds them exactly, so one slot does
    // for two fields and the splat stays within three vec4s.
    this.bufferC[at + 3] = joint + variant * JOINT_COUNT;

    this.count++;
  }
}

const SCRATCH_COLOR = new Color();
