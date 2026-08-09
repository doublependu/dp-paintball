import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Object3D,
  Vector3,
} from 'three';

/** Joint indices. Must match the uniform array size in the rig shader. */
export const JOINT = {
  ROOT: 0,
  PELVIS: 1,
  TORSO: 2,
  HEAD: 3,
  ARM_L: 4,
  ARM_R: 5,
  LEG_L: 6,
  LEG_R: 7,
} as const;

export const JOINT_COUNT = 8;

/** Paint atlas is a 4x4 grid of part cells; each cell holds a box's 6 faces. */
const CELLS_PER_ROW = 4;
const FACE_COLS = 3;
const FACE_ROWS = 2;

export interface RigPart {
  name: string;
  joint: number;
  /** Full extents in metres. */
  size: [number, number, number];
  /** Box centre, relative to its joint's pivot. */
  offset: [number, number, number];
  /** Base colour before paint. */
  color: number;
}

/**
 * Minecraft-ish proportions scaled to the 1.8m player capsule.
 *
 * Blocky is a gift here: hard silhouettes take ink outlines beautifully, and a
 * box is trivially unwrappable, which is what makes per-character paint cheap.
 */
export const HUMAN_PARTS: RigPart[] = [
  // Torso is narrower than the 0.52 first tried: at that width the arms sat
  // flush against it and the three merged into one slab from any distance.
  { name: 'torso', joint: JOINT.TORSO, size: [0.44, 0.66, 0.26], offset: [0, 0.33, 0], color: 0x3f8fd0 },
  { name: 'head', joint: JOINT.HEAD, size: [0.44, 0.44, 0.44], offset: [0, 0.22, 0], color: 0xf2c9a0 },
  { name: 'cap', joint: JOINT.HEAD, size: [0.48, 0.11, 0.48], offset: [0, 0.475, 0], color: 0xff3d81 },
  { name: 'brim', joint: JOINT.HEAD, size: [0.46, 0.07, 0.26], offset: [0, 0.42, -0.33], color: 0xff3d81 },
  // Eyes. Two dark blocks are the cheapest possible way to make facing
  // unambiguous, and a character whose facing you can't read is unreadable.
  { name: 'eyeL', joint: JOINT.HEAD, size: [0.09, 0.09, 0.03], offset: [-0.1, 0.27, -0.225], color: 0x2a2438 },
  { name: 'eyeR', joint: JOINT.HEAD, size: [0.09, 0.09, 0.03], offset: [0.1, 0.27, -0.225], color: 0x2a2438 },
  { name: 'armL', joint: JOINT.ARM_L, size: [0.17, 0.62, 0.22], offset: [0, -0.31, 0], color: 0x3f8fd0 },
  { name: 'armR', joint: JOINT.ARM_R, size: [0.17, 0.62, 0.22], offset: [0, -0.31, 0], color: 0x3f8fd0 },
  { name: 'legL', joint: JOINT.LEG_L, size: [0.2, 0.75, 0.24], offset: [0, -0.375, 0], color: 0x2f3f5e },
  { name: 'legR', joint: JOINT.LEG_R, size: [0.2, 0.75, 0.24], offset: [0, -0.375, 0], color: 0x2f3f5e },
];

/** Rest-pose pivot offsets, each relative to its parent joint. */
const JOINT_REST: Record<number, { parent: number; offset: Vector3 }> = {
  [JOINT.PELVIS]: { parent: JOINT.ROOT, offset: new Vector3(0, 0.75, 0) },
  [JOINT.TORSO]: { parent: JOINT.PELVIS, offset: new Vector3(0, 0, 0) },
  [JOINT.HEAD]: { parent: JOINT.TORSO, offset: new Vector3(0, 0.66, 0) },
  [JOINT.ARM_L]: { parent: JOINT.TORSO, offset: new Vector3(-0.315, 0.58, 0) },
  [JOINT.ARM_R]: { parent: JOINT.TORSO, offset: new Vector3(0.315, 0.58, 0) },
  [JOINT.LEG_L]: { parent: JOINT.PELVIS, offset: new Vector3(-0.11, 0, 0) },
  [JOINT.LEG_R]: { parent: JOINT.PELVIS, offset: new Vector3(0.11, 0, 0) },
};

/** Box face order, matching the order faces are emitted below. */
const FACE_AXES: Array<{ axis: 0 | 1 | 2; sign: 1 | -1 }> = [
  { axis: 0, sign: 1 }, // +X
  { axis: 0, sign: -1 }, // -X
  { axis: 1, sign: 1 }, // +Y
  { axis: 1, sign: -1 }, // -Y
  { axis: 2, sign: 1 }, // +Z
  { axis: 2, sign: -1 }, // -Z
];

/** UV rect for one face of one part inside the character's paint atlas. */
export function faceUvRect(
  partIndex: number,
  faceIndex: number,
): { u0: number; v0: number; u1: number; v1: number } {
  const cellX = partIndex % CELLS_PER_ROW;
  const cellY = Math.floor(partIndex / CELLS_PER_ROW);
  const cellW = 1 / CELLS_PER_ROW;
  const cellH = 1 / CELLS_PER_ROW;

  const faceX = faceIndex % FACE_COLS;
  const faceY = Math.floor(faceIndex / FACE_COLS);
  const faceW = cellW / FACE_COLS;
  const faceH = cellH / FACE_ROWS;

  // A small inset keeps bilinear filtering from bleeding between faces.
  const pad = faceW * 0.04;
  return {
    u0: cellX * cellW + faceX * faceW + pad,
    v0: cellY * cellH + faceY * faceH + pad,
    u1: cellX * cellW + (faceX + 1) * faceW - pad,
    v1: cellY * cellH + (faceY + 1) * faceH - pad,
  };
}

export interface PaintHitUv {
  u: number;
  v: number;
  partIndex: number;
  faceIndex: number;
  /** UV units per world metre on this face, for sizing the splat. */
  uvPerMeter: number;
  /** 1 for the struck face, less for faces the splat wraps onto. */
  weight: number;
}

/**
 * A blocky character.
 *
 * All parts merge into one geometry carrying a per-vertex joint index, and the
 * vertex shader applies that joint's matrix. One draw call animates the whole
 * figure — which matters once there are bots, where a mesh per limb would be
 * eight draw calls each across three render passes.
 */
export class VoxelRig {
  readonly root = new Group();
  readonly geometry: BufferGeometry;
  readonly joints: Object3D[] = [];
  /** Joint transforms relative to the rig root, uploaded to the shader. */
  readonly jointMatrices: Matrix4[] = [];

  private readonly parts: RigPart[];
  private readonly rootInverse = new Matrix4();

  constructor(parts: RigPart[] = HUMAN_PARTS) {
    this.parts = parts;

    for (let i = 0; i < JOINT_COUNT; i++) {
      this.joints.push(new Object3D());
      this.jointMatrices.push(new Matrix4());
    }

    // Wire the hierarchy from the rest-pose table.
    this.root.add(this.joints[JOINT.ROOT]!);
    for (const key of Object.keys(JOINT_REST)) {
      const index = Number(key);
      const rest = JOINT_REST[index]!;
      this.joints[index]!.position.copy(rest.offset);
      this.joints[rest.parent]!.add(this.joints[index]!);
    }

    this.geometry = this.buildGeometry();
  }

  /** Recomputes joint matrices for the current pose. Call after posing. */
  updateMatrices(): void {
    this.root.updateMatrixWorld(true);
    this.rootInverse.copy(this.root.matrixWorld).invert();
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.jointMatrices[i]!.multiplyMatrices(this.rootInverse, this.joints[i]!.matrixWorld);
    }
  }

  /**
   * Resolves an impact into every nearby face of the part it struck.
   *
   * A paintball does not stop at a box edge, and neither should its splat. More
   * practically: bots face you when they shoot, so hits land on a character's
   * front — which in third person is the side you never see. Without wrapping,
   * a player gets tagged repeatedly and sees no paint at all, which reads as
   * the feature being broken.
   *
   * Faces are weighted by how close the impact is to each, so a square hit
   * paints one face strongly and a corner hit paints two or three.
   */
  resolvePaintFaces(
    worldPoint: Vector3,
    worldMatrix: Matrix4,
    maxFaces = 3,
  ): PaintHitUv[] {
    // Owned here rather than shared with resolvePart's internals, so locating
    // the part cannot scribble over the position that locating it produced.
    const inPart = SCRATCH_IN_PART;
    const partIndex = this.resolvePart(worldPoint, worldMatrix, inPart);
    if (partIndex < 0) return [];

    const part = this.parts[partIndex]!;
    const half = [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2];

    // Distance from the impact to each face plane, as a fraction of the part's
    // size along that axis, so faces of very different sizes compare fairly.
    const scored = FACE_AXES.map((face, index) => {
      const h = half[face.axis]!;
      const distance = Math.abs(face.sign * h - inPart.getComponent(face.axis)) / (2 * h);
      return { index, distance };
    }).sort((a, b) => a.distance - b.distance);

    const results: PaintHitUv[] = [];
    for (const { index, distance } of scored.slice(0, maxFaces)) {
      // Only faces the impact is genuinely near; beyond a third of the part's
      // depth, paint on that face would look like it teleported there.
      if (results.length > 0 && distance > 0.34) break;
      const uv = this.faceUvFor(partIndex, index, inPart, half);
      // Wrapped faces get a smaller splat, tapering with distance.
      uv.weight = results.length === 0 ? 1 : Math.max(0.35, 1 - distance * 2.2);
      results.push(uv);
    }
    return results;
  }

  /** UV on a specific face of a part, for a point already in the part's frame. */
  private faceUvFor(
    partIndex: number,
    faceIndex: number,
    inPart: Vector3,
    half: number[],
  ): PaintHitUv {
    // The two axes that aren't the face normal become the face's own UV.
    const { axis } = FACE_AXES[faceIndex]!;
    const uAxis = axis === 0 ? 2 : 0;
    const vAxis = axis === 1 ? 2 : 1;
    const uLocal = (inPart.getComponent(uAxis) / half[uAxis]! + 1) / 2;
    const vLocal = (inPart.getComponent(vAxis) / half[vAxis]! + 1) / 2;

    const rect = faceUvRect(partIndex, faceIndex);
    return {
      u: rect.u0 + (rect.u1 - rect.u0) * Math.min(Math.max(uLocal, 0), 1),
      v: rect.v0 + (rect.v1 - rect.v0) * Math.min(Math.max(vLocal, 0), 1),
      partIndex,
      faceIndex,
      // The face spans `2 * half[uAxis]` metres across `rect.u1 - rect.u0` UV
      // units, which is what converts a world splat radius into a UV radius.
      uvPerMeter: (rect.u1 - rect.u0) / (2 * half[uAxis]!),
      weight: 1,
    };
  }

  /**
   * Locates a world-space impact on the rig: which part it struck, and where in
   * that part's own frame. Writes the position into `outInPart` and returns the
   * part index, or -1 if the point is clear of every part.
   *
   * Analytic rather than a raycast: the CPU-side geometry is in bind pose, so
   * raycasting it would place paint where the limb *used* to be. Instead the
   * point is pushed into each part's local space through that part's current
   * joint matrix, and the nearest box is solved directly.
   *
   * Which *face* the impact belongs to is deliberately not decided here — the
   * caller scores all six anyway, so choosing one would only be overruled.
   */
  private resolvePart(
    worldPoint: Vector3,
    worldMatrix: Matrix4,
    outInPart: Vector3,
  ): number {
    const local = SCRATCH_V.copy(worldPoint).applyMatrix4(
      SCRATCH_M.copy(worldMatrix).invert(),
    );

    let bestPart = -1;
    let bestDistance = Infinity;

    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p]!;
      // Into the joint's frame, then into the box's frame.
      const inJoint = SCRATCH_V2.copy(local).applyMatrix4(
        SCRATCH_M2.copy(this.jointMatrices[part.joint]!).invert(),
      );
      inJoint.x -= part.offset[0];
      inJoint.y -= part.offset[1];
      inJoint.z -= part.offset[2];

      const half = [part.size[0] / 2, part.size[1] / 2, part.size[2] / 2];
      // Distance to the box surface, clamped per axis.
      const dx = Math.max(Math.abs(inJoint.x) - half[0]!, 0);
      const dy = Math.max(Math.abs(inJoint.y) - half[1]!, 0);
      const dz = Math.max(Math.abs(inJoint.z) - half[2]!, 0);
      const distance = Math.hypot(dx, dy, dz);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestPart = p;
        outInPart.copy(inJoint);
      }
    }

    // Well clear of every part — a miss, or a hit on something else entirely.
    if (bestPart < 0 || bestDistance > 0.5) return -1;
    return bestPart;
  }

  private buildGeometry(): BufferGeometry {
    const partCount = this.parts.length;
    const vertexCount = partCount * 24;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3);
    const jointIndices = new Float32Array(vertexCount);
    const indices = new Uint16Array(partCount * 36);

    let v = 0;
    let t = 0;

    for (let p = 0; p < partCount; p++) {
      const part = this.parts[p]!;
      const [w, h, d] = part.size;
      const [ox, oy, oz] = part.offset;
      const half = [w / 2, h / 2, d / 2];
      const r = ((part.color >> 16) & 255) / 255;
      const g = ((part.color >> 8) & 255) / 255;
      const b = (part.color & 255) / 255;

      for (let f = 0; f < 6; f++) {
        const { axis, sign } = FACE_AXES[f]!;
        const uAxis = axis === 0 ? 2 : 0;
        const vAxis = axis === 1 ? 2 : 1;
        const rect = faceUvRect(p, f);
        const base = v;

        for (let corner = 0; corner < 4; corner++) {
          const su = corner === 1 || corner === 2 ? 1 : -1;
          const sv = corner >= 2 ? 1 : -1;

          const pos = [0, 0, 0];
          pos[axis] = sign * half[axis]!;
          pos[uAxis] = su * half[uAxis]!;
          pos[vAxis] = sv * half[vAxis]!;

          positions[v * 3] = pos[0]! + ox;
          positions[v * 3 + 1] = pos[1]! + oy;
          positions[v * 3 + 2] = pos[2]! + oz;

          normals[v * 3 + axis] = sign;

          uvs[v * 2] = rect.u0 + ((su + 1) / 2) * (rect.u1 - rect.u0);
          uvs[v * 2 + 1] = rect.v0 + ((sv + 1) / 2) * (rect.v1 - rect.v0);

          colors[v * 3] = r;
          colors[v * 3 + 1] = g;
          colors[v * 3 + 2] = b;

          jointIndices[v] = part.joint;
          v++;
        }

        // Wind so the face points along its own normal.
        //
        // The corners are emitted counter-clockwise in the face's own (u, v)
        // plane, so the standard order yields a normal along cross(u, v). For
        // axes 0 and 1 that cross product points along *minus* the face axis
        // (cross(z,y) = -x, cross(x,z) = -y); only for axis 2 does it point
        // along plus (cross(x,y) = +z). So the order must be reversed whenever
        // the face's sign disagrees with that.
        const reverse = sign > 0 !== (axis === 2);
        if (reverse) {
          indices[t++] = base; indices[t++] = base + 2; indices[t++] = base + 1;
          indices[t++] = base; indices[t++] = base + 3; indices[t++] = base + 2;
        } else {
          indices[t++] = base; indices[t++] = base + 1; indices[t++] = base + 2;
          indices[t++] = base; indices[t++] = base + 2; indices[t++] = base + 3;
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setAttribute('aJoint', new BufferAttribute(jointIndices, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    // The bounding sphere must cover the posed figure, not just bind pose.
    geometry.boundingSphere = null;
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius *= 1.6;
    return geometry;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

const SCRATCH_V = new Vector3();
const SCRATCH_V2 = new Vector3();
/** Kept apart from the two above, which resolvePart uses while filling it. */
const SCRATCH_IN_PART = new Vector3();
const SCRATCH_M = new Matrix4();
const SCRATCH_M2 = new Matrix4();
