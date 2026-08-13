import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshToonMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { Rng } from '../core/Random';
import { getCelGradient } from '../render/CelMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';

/**
 * Birds in the park.
 *
 * The soundscape has had birdsong since phase 7 and the trees have had nothing
 * in them, which is a specific kind of wrong: a sound with no source makes a
 * place feel like a recording of a park rather than a park. So these are placed
 * in the same crowns the canopy cards are built from, and they behave the way
 * birds in a park actually read from the ground — sitting still for a while,
 * then a short burst of flapping to another tree.
 *
 * One instanced draw call for the flock, with the flap in the vertex shader and
 * the flight path on the CPU. That split is the right one at this scale: thirty
 * birds is nothing to step per frame, while thirty *meshes* would be thirty
 * draw calls in each of the colour and shadow passes.
 */

/** How many birds live in the park. */
const FLOCK = 30;
/** Metres per second in level flight. Small birds are quick over short hops. */
const FLIGHT_SPEED = 7.5;
/** A hop longer than this is a journey; birds pick a nearer tree instead. */
const MAX_HOP = 38;

/** Sparrow, cardinal, jay, goldfinch — the park's ordinary company. */
const PLUMAGE = [0x8a6f4e, 0xc4432f, 0x4a72b0, 0xd8b23c, 0x5c5348] as const;

/** A tree a bird can sit in: the crown's centre, and how wide it is. */
export interface Perch {
  point: Vector3;
  /** Canopy radius. Birds sit near its edge, where they can be seen. */
  radius: number;
}

interface BirdState {
  /** Where it sits when perched. */
  perch: Vector3;
  from: Vector3;
  to: Vector3;
  /** Seconds until the current activity ends. */
  timer: number;
  flying: boolean;
  /** Seconds the current flight takes, and how far through it we are. */
  duration: number;
  elapsed: number;
  yaw: number;
  /** Smoothed wing amplitude, 0 perched to 1 in full flight. */
  flap: number;
  /** Wingbeat phase, so the flock is never in unison. */
  phase: number;
}

export class Birds {
  readonly mesh: InstancedMesh;

  private readonly birds: BirdState[] = [];
  private readonly perches: Perch[];
  private readonly rng: Rng;
  private readonly flaps: Float32Array;
  private readonly flapAttribute: InstancedBufferAttribute;

  private readonly position = new Vector3();
  private readonly quaternion = new Quaternion();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly matrix = new Matrix4();

  constructor(perches: Perch[], seedFrom: Rng) {
    // Its own generator, forked once at build time. Birds are stepped from the
    // render frame, so drawing from the shared sequence would make every bot
    // decision downstream depend on the frame rate — the exact hazard
    // `Character.takeHit` documents from the other direction.
    this.rng = seedFrom.fork();
    this.perches = perches.length > 0
      ? perches
      : [{ point: new Vector3(0, 6, 0), radius: 3 }];

    const geometry = buildBirdGeometry();
    const material = this.createMaterial();
    const count = Math.min(FLOCK, Math.max(4, this.perches.length));
    this.mesh = new InstancedMesh(geometry, material, count);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // No ink line: at this size an outline is thicker than the bird.
    this.mesh.layers.set(NO_OUTLINE_LAYER);
    this.mesh.frustumCulled = false;

    const tints = new Float32Array(count * 3);
    this.flaps = new Float32Array(count);
    const tint = new Color();

    for (let i = 0; i < count; i++) {
      const perch = this.pickPerch(this.perches[i % this.perches.length]!);
      this.birds.push({
        perch,
        from: perch.clone(),
        to: perch.clone(),
        timer: this.rng.range(1, 8),
        flying: false,
        duration: 1,
        elapsed: 0,
        yaw: this.rng.range(0, Math.PI * 2),
        flap: 0,
        phase: this.rng.range(0, Math.PI * 2),
      });

      tint.setHex(PLUMAGE[this.rng.int(0, PLUMAGE.length)]!);
      tints[i * 3] = tint.r;
      tints[i * 3 + 1] = tint.g;
      tints[i * 3 + 2] = tint.b;
    }

    geometry.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    this.flapAttribute = new InstancedBufferAttribute(this.flaps, 1);
    geometry.setAttribute('aFlap', this.flapAttribute);
  }

  /**
   * A spot near the crown's outer edge.
   *
   * Not near the trunk: an elm's crown is nine metres across and made of opaque
   * alpha cards, so a bird sitting a metre from the middle of one is inside a
   * solid green mass and can never be seen. On the outside of the canopy it
   * reads in silhouette against the sky, which is where you actually notice a
   * bird in a park.
   */
  private pickPerch(tree: Perch): Vector3 {
    const angle = this.rng.range(0, Math.PI * 2);
    const radius = tree.radius * this.rng.range(0.6, 1.0);
    return new Vector3(
      tree.point.x + Math.cos(angle) * radius,
      tree.point.y + this.rng.range(0, 0.4) * tree.radius,
      tree.point.z + Math.sin(angle) * radius,
    );
  }

  /**
   * Puts every bird within `radius` of a point to flight.
   *
   * Called on gunfire. It is the cheapest possible reactive detail and it does
   * a surprising amount: the park stops being scenery the moment something in
   * it reacts to you.
   */
  scatter(x: number, z: number, radius = 18): void {
    for (const bird of this.birds) {
      if (bird.flying) continue;
      if (Math.hypot(bird.perch.x - x, bird.perch.z - z) > radius) continue;
      this.launch(bird);
    }
  }

  private launch(bird: BirdState): void {
    // A nearby tree, or a short loop back to this one if there is nothing near.
    let destination = bird.perch;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.perches[this.rng.int(0, this.perches.length)]!;
      if (candidate.point.distanceTo(bird.perch) < MAX_HOP) {
        destination = this.pickPerch(candidate);
        break;
      }
    }

    bird.from.copy(bird.perch);
    bird.to.copy(destination);
    bird.flying = true;
    bird.elapsed = 0;
    bird.duration = Math.max(0.6, bird.from.distanceTo(bird.to) / FLIGHT_SPEED);
  }

  update(dt: number, elapsed: number): void {
    for (let i = 0; i < this.birds.length; i++) {
      const bird = this.birds[i]!;

      if (bird.flying) {
        bird.elapsed += dt;
        const t = Math.min(1, bird.elapsed / bird.duration);
        this.position.lerpVectors(bird.from, bird.to, t);
        // Arc over the gap rather than sliding between two branches. Height
        // scales with the hop, so a flit to the next limb stays low.
        this.position.y += Math.sin(t * Math.PI) * (1.2 + bird.duration * 0.9);
        bird.yaw = Math.atan2(bird.to.x - bird.from.x, bird.to.z - bird.from.z);
        bird.flap = Math.min(1, bird.flap + dt * 8);

        if (t >= 1) {
          bird.flying = false;
          bird.perch.copy(bird.to);
          bird.timer = this.rng.range(2.5, 10);
        }
      } else {
        this.position.copy(bird.perch);
        bird.flap = Math.max(0, bird.flap - dt * 5);
        bird.timer -= dt;
        if (bird.timer <= 0) this.launch(bird);
      }

      // A perched bird still shuffles its wings occasionally; the amplitude
      // never quite reaches zero, so nothing on screen is ever perfectly rigid.
      const beat = Math.sin(elapsed * 21 + bird.phase);
      this.flaps[i] = beat * (0.05 + bird.flap * 1.0);
      this.quaternion.setFromAxisAngle(UP, bird.yaw);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.flapAttribute.needsUpdate = true;
  }

  private createMaterial(): MeshToonMaterial {
    const material = new MeshToonMaterial({
      gradientMap: getCelGradient(),
      side: DoubleSide,
    });

    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aTint;
           attribute float aFlap;
           attribute float aWing;
           varying vec3 vTint;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTint = aTint;
           // Wings hinge about the body's long axis. aFlap is the wing angle
           // itself, solved per bird on the CPU, and aWing carries the side —
           // so one expression lifts both wings together rather than mirroring
           // by hand, and it is zero on the body, which never moves.
           if ( abs( aWing ) > 0.5 ) {
             float angle = aWing * aFlap;
             float c = cos( angle );
             float s = sin( angle );
             transformed.xy = vec2(
               transformed.x * c - transformed.y * s,
               transformed.x * s + transformed.y * c
             );
           }`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
           varying vec3 vTint;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
           diffuseColor.rgb *= vTint;`);
    };

    material.customProgramCacheKey = () => 'bird-v1';
    return material;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshToonMaterial).dispose();
  }
}

/**
 * One bird: a body, a tail and two wings, about 22cm nose to tail.
 *
 * Built by hand rather than merged from box helpers because the wings carry an
 * extra attribute — `aWing` — that the vertex shader hinges them on, and there
 * is no way to attach that to a BoxGeometry after the fact.
 */
function buildBirdGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const wings: number[] = [];
  const indices: number[] = [];

  const quad = (
    corners: Array<[number, number, number]>,
    normal: [number, number, number],
    wing: number,
  ): void => {
    const base = positions.length / 3;
    for (const [x, y, z] of corners) {
      positions.push(x, y, z);
      normals.push(...normal);
      wings.push(wing);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const box = (
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
  ): void => {
    quad([[cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
          [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]], [0, 0, 1], 0);
    quad([[cx + hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz - hz],
          [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz]], [0, 0, -1], 0);
    quad([[cx + hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz - hz],
          [cx + hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz + hz]], [1, 0, 0], 0);
    quad([[cx - hx, cy - hy, cz - hz], [cx - hx, cy - hy, cz + hz],
          [cx - hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz - hz]], [-1, 0, 0], 0);
    quad([[cx - hx, cy + hy, cz + hz], [cx + hx, cy + hy, cz + hz],
          [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz]], [0, 1, 0], 0);
    quad([[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
          [cx + hx, cy - hy, cz + hz], [cx - hx, cy - hy, cz + hz]], [0, -1, 0], 0);
  };

  // Body, nose toward -Z, and a tail behind it. Generous for a songbird —
  // about 45cm nose to tail with a 70cm span, which is a crow rather than a
  // sparrow. Life-sized, a bird perched 15m up in an elm is under two pixels
  // and there is no point drawing it at all.
  box(0, 0, 0, 0.065, 0.065, 0.14);
  box(0, 0.015, 0.21, 0.042, 0.017, 0.085);
  // A beak, so the thing has a front at close range.
  box(0, 0, -0.17, 0.017, 0.017, 0.042);

  // Wings, one quad each, hinged at the body.
  for (const side of [-1, 1] as const) {
    quad(
      [
        [side * 0.042, 0.028, -0.07],
        [side * 0.36, 0.028, -0.014],
        [side * 0.335, 0.028, 0.125],
        [side * 0.042, 0.028, 0.098],
      ],
      [0, 1, 0],
      side,
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('aWing', new BufferAttribute(new Float32Array(wings), 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const UP = new Vector3(0, 1, 0);
