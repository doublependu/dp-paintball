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
  /**
   * The marker, held in the right hand.
   *
   * A joint of its own rather than boxes riding on the arm, so the gun can be
   * *aimed* — the animator counter-rotates this joint against the arm and the
   * torso so the barrel points along the player's line of sight whatever the
   * shoulder happens to be doing. Boxes on the arm can only ever point where
   * the arm points, which is what made the old marker read as a limb extension.
   */
  GUN: 8,
} as const;

export const JOINT_COUNT = 9;

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
  // Fists. Small, but they are what turns "a gun stuck to an arm" into "a gun
  // held in a hand": the marker hangs off the GUN joint at its own angle now,
  // so without a fist there is a visible kink where the arm stops and the
  // grip starts. The left one exists for the same reason in the aim pose,
  // where it comes across to brace the fore-end.
  { name: 'handR', joint: JOINT.ARM_R, size: [0.19, 0.15, 0.23], offset: [-0.04, -0.62, -0.01], color: 0x2b3140 },
  { name: 'handL', joint: JOINT.ARM_L, size: [0.19, 0.15, 0.23], offset: [0.02, -0.62, -0.01], color: 0x2b3140 },
  { name: 'legL', joint: JOINT.LEG_L, size: [0.2, 0.75, 0.24], offset: [0, -0.375, 0], color: 0x2f3f5e },
  { name: 'legR', joint: JOINT.LEG_R, size: [0.2, 0.75, 0.24], offset: [0, -0.375, 0], color: 0x2f3f5e },

  // --- the marker ---------------------------------------------------------
  //
  // Parts of the rig rather than a child mesh on a hand bone. The whole figure
  // is one merged geometry indexed by joint, so these boxes cost their own
  // vertices and *no* extra draw call — where a separate mesh would cost one
  // per character in each of the colour, prepass and hull passes. It also picks
  // up the inverted-hull ink and the animated pose for free.
  //
  // Laid out in the GUN joint's own frame: origin at the fist, -Z down the
  // barrel, +Y up. That frame is aimed by the animator rather than inherited
  // from the arm, so these numbers describe a marker lying on a bench and
  // nothing here has to compromise for the pose.
  //
  // Proportioned from a real marker: grip under the receiver, hopper standing
  // proud on top and set back, barrel a little over a third of the length, and
  // an air tank behind the grip — which is the silhouette that says "paintball"
  // rather than "rifle", and the whole reason the hopper is worth four boxes.
  { name: 'gunGrip', joint: JOINT.GUN, size: [0.07, 0.17, 0.09], offset: [0, -0.05, 0.03], color: 0x2f3542 },
  { name: 'gunBody', joint: JOINT.GUN, size: [0.085, 0.14, 0.28], offset: [0, 0.085, -0.09], color: 0x39404f },
  { name: 'gunNeck', joint: JOINT.GUN, size: [0.07, 0.05, 0.09], offset: [0, 0.175, -0.05], color: 0x2f3542 },
  { name: 'gunSight', joint: JOINT.GUN, size: [0.045, 0.035, 0.09], offset: [0, 0.175, -0.2], color: 0x2f3542 },
  { name: 'gunBarrel', joint: JOINT.GUN, size: [0.05, 0.05, 0.28], offset: [0, 0.09, -0.37], color: 0x2f3542 },
  { name: 'gunMuzzle', joint: JOINT.GUN, size: [0.066, 0.066, 0.05], offset: [0, 0.09, -0.53], color: 0x39404f },
  { name: 'gunTank', joint: JOINT.GUN, size: [0.075, 0.075, 0.2], offset: [0, -0.005, 0.15], color: 0x39404f },
  // Team colour, assigned in Character — the hopper is the one part of the
  // marker you can read from across the plaza.
  { name: 'gunHopper', joint: JOINT.GUN, size: [0.14, 0.13, 0.16], offset: [0, 0.23, -0.05], color: 0xff3d81 },
];

/**
 * Where the marker's muzzle sits in the GUN joint's frame — the end of
 * `gunBarrel` plus the muzzle block.
 *
 * `AimSolver` cannot read this: it spawns projectiles from `fixedUpdate`, a
 * frame before the rig is posed, so it carries its own analytic muzzle in the
 * *body's* frame instead. The two are therefore free to drift, and did when the
 * marker moved onto its own joint — so `character-test` fires a real shot and
 * asserts the ball leaves within 18cm of the axis this point defines.
 */
export const GUN_MUZZLE_LOCAL = new Vector3(0, 0.09, -0.56);

/** Rest-pose pivot offsets, each relative to its parent joint. */
const JOINT_REST: Record<number, { parent: number; offset: Vector3 }> = {
  [JOINT.PELVIS]: { parent: JOINT.ROOT, offset: new Vector3(0, 0.75, 0) },
  [JOINT.TORSO]: { parent: JOINT.PELVIS, offset: new Vector3(0, 0, 0) },
  [JOINT.HEAD]: { parent: JOINT.TORSO, offset: new Vector3(0, 0.66, 0) },
  [JOINT.ARM_L]: { parent: JOINT.TORSO, offset: new Vector3(-0.315, 0.58, 0) },
  [JOINT.ARM_R]: { parent: JOINT.TORSO, offset: new Vector3(0.315, 0.58, 0) },
  [JOINT.LEG_L]: { parent: JOINT.PELVIS, offset: new Vector3(-0.11, 0, 0) },
  [JOINT.LEG_R]: { parent: JOINT.PELVIS, offset: new Vector3(0.11, 0, 0) },
  // The fist. Set in a little from the arm's own axis so the marker carries on
  // the body's centre line rather than out at the shoulder — a gun held at
  // arm's length to the right of the chest cannot be aimed convincingly at
  // something the camera is looking at over the *left* shoulder.
  [JOINT.GUN]: { parent: JOINT.ARM_R, offset: new Vector3(-0.08, -0.6, 0) },
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
   * Locates a world-space impact in the frame of the joint it landed on, which
   * is the frame the rig shader evaluates paint in. Writes the point and the
   * projection axis into `outPoint` and `outNormal`, and returns the joint
   * index — or -1 if the impact is clear of every part.
   *
   * Analytic rather than a raycast: the CPU-side geometry is in bind pose, so
   * raycasting it would place paint where the limb *used* to be. Instead the
   * point is pushed into each part's local space through that part's current
   * joint matrix, and the nearest box is solved directly.
   *
   * The *joint* frame, not the part's box frame, because that is the space the
   * `position` attribute is already in — so the shader compares the two without
   * transforming anything. Which face was struck is not decided here at all:
   * the shader projects the splat along `outNormal` and lets it fall across
   * however many faces it reaches, which is what makes a splat wrap a corner
   * instead of being stamped onto each face separately.
   *
   * ## Why the point and the normal are both corrected
   *
   * Impacts arrive from the *capsule*, which is a good deal more generous than
   * the figure inside it: it is 0.35m in radius where the torso is 0.13m deep,
   * so an ordinary square hit on the chest lands about 0.2m clear of the body
   * it is supposed to paint. Handed to the shader raw, that splat fails the
   * `abs( along ) > radius` test against a 0.2m radius on every face and
   * silently disappears — score up, no paint, which is exactly the complaint.
   * The same geometry tilts the capsule's normal away from any box face near a
   * shoulder or the crown, where the grazing-angle guard then drops it.
   *
   * So the anchor is snapped onto the nearest box's surface, and the projection
   * axis is tipped back toward that surface's own face normal when the two
   * disagree. Neither changes where a splat lands to the eye; both are the
   * difference between a splat that draws and one that does not.
   */
  resolvePaintAnchor(
    worldPoint: Vector3,
    worldNormal: Vector3,
    worldMatrix: Matrix4,
    outPoint: Vector3,
    outNormal: Vector3,
  ): number {
    const local = SCRATCH_V.copy(worldPoint).applyMatrix4(
      SCRATCH_M.copy(worldMatrix).invert(),
    );

    let bestPart = -1;
    let bestDistance = Infinity;

    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p]!;
      const inJoint = SCRATCH_V2.copy(local).applyMatrix4(
        SCRATCH_M2.copy(this.jointMatrices[part.joint]!).invert(),
      );

      // Distance to the box surface, clamped per axis. The box sits at its
      // offset within the joint frame, so compare against that rather than
      // moving the point — the point is what gets kept.
      const dx = Math.max(Math.abs(inJoint.x - part.offset[0]) - part.size[0] / 2, 0);
      const dy = Math.max(Math.abs(inJoint.y - part.offset[1]) - part.size[1] / 2, 0);
      const dz = Math.max(Math.abs(inJoint.z - part.offset[2]) - part.size[2] / 2, 0);
      const distance = Math.hypot(dx, dy, dz);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestPart = p;
        outPoint.copy(inJoint);
      }
    }

    // Well clear of every part — a miss, or a hit on something else entirely.
    // The bound is a capsule radius plus slack: anything nearer than that is a
    // shot that struck this body, however awkwardly, and gets painted.
    if (bestPart < 0 || bestDistance > 0.5) return -1;

    const part = this.parts[bestPart]!;
    const joint = part.joint;

    // Snap onto the struck box, and work out which face that landed on.
    //
    // The winning axis is the one with the least room left between the point
    // and its face, measured as a fraction of the half-extent so a thin box's
    // broad faces win over its narrow ones. For a point outside the box that
    // slack is negative on whichever axis it overshot, and most negative on the
    // axis it overshot furthest — which is the face it is in front of.
    let faceAxis = 0;
    let faceSign = 1;
    let leastSlack = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const half = part.size[axis]! / 2;
      const centre = part.offset[axis]!;
      const value = axis === 0 ? outPoint.x : axis === 1 ? outPoint.y : outPoint.z;
      const relative = value - centre;
      const clamped = Math.min(half, Math.max(-half, relative));
      if (axis === 0) outPoint.x = centre + clamped;
      else if (axis === 1) outPoint.y = centre + clamped;
      else outPoint.z = centre + clamped;

      const slack = (half - Math.abs(relative)) / half;
      if (slack < leastSlack) {
        leastSlack = slack;
        faceAxis = axis;
        faceSign = relative >= 0 ? 1 : -1;
      }
    }
    FACE_NORMAL.set(0, 0, 0);
    if (faceAxis === 0) FACE_NORMAL.x = faceSign;
    else if (faceAxis === 1) FACE_NORMAL.y = faceSign;
    else FACE_NORMAL.z = faceSign;

    // A direction, so only the rotation applies — transformDirection uses the
    // upper 3x3, which is what the joint matrices carry.
    outNormal
      .copy(worldNormal)
      .transformDirection(SCRATCH_M.copy(worldMatrix).invert())
      .transformDirection(SCRATCH_M2.copy(this.jointMatrices[joint]!).invert())
      .normalize();

    // Tip a disagreeing axis back toward the face. Blended rather than
    // replaced: the residual tilt is what lets a splat wrap onto the
    // neighbouring face, and snapping to the face normal exactly would flatten
    // every splat onto one plane and undo that.
    if (outNormal.dot(FACE_NORMAL) < 0.55) {
      outNormal.multiplyScalar(0.4).add(FACE_NORMAL).normalize();
    }
    return joint;
  }

  private buildGeometry(): BufferGeometry {
    const partCount = this.parts.length;
    const vertexCount = partCount * 24;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
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
    // No uv attribute: nothing samples a texture by surface UV any more. Paint
    // is placed in the joint frame, from `position`, by the rig shader.
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
const FACE_NORMAL = new Vector3();
const SCRATCH_M = new Matrix4();
const SCRATCH_M2 = new Matrix4();
