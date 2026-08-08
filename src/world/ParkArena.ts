import {
  BoxGeometry,
  type BufferGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { palette, render as renderConfig } from '../core/Config';
import type { Rng } from '../core/Random';
import type { GameContext, System } from '../core/System';
import type { SurfaceRegistry } from '../paint/SurfaceRegistry';
import { createCelMaterial } from '../render/CelMaterial';
import { Sky } from '../render/Sky';
import { Foliage, type TreeSpec } from './Foliage';
import {
  ARCADE,
  ARENA_HALF,
  BRIDGE,
  BRIDGE_APPROACH_Y,
  TERRACE,
  heightAt,
  lakeMask,
  plazaMask,
  rambleMask,
} from './ParkLayout';
import { Terrain } from './Terrain';
import { Water } from './Water';

/**
 * Built from `BASE_URL` rather than written as a root-absolute path: on GitHub
 * Pages the app lives under `/dp-paintball/`, where a bare `/models/...` would
 * miss the deployment entirely. `BASE_URL` always carries a trailing slash.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/park-props.glb`;

/** Mid-afternoon sun, low enough for long shadows down the Mall. */
const SUN_DIRECTION = new Vector3(0.42, 0.58, 0.36).normalize();

/** Perimeter wall height. Flat and vertical — the only reliable containment. */
const WALL_HEIGHT = 6;

interface Placement {
  position: Vector3;
  rotationY: number;
  scale: number;
}

/**
 * The Central Park arena.
 *
 * Assembles the ground, the lake, the Blender prop set and the foliage into a
 * playable map, and registers every collider with the paint system so anything
 * you can shoot, you can paint.
 *
 * Props authored in Blender are placed here rather than baked into a single
 * scene file, so layout is data in one readable place and repeated props can be
 * instanced.
 */
export class ParkArenaSystem implements System {
  readonly name = 'park-arena';

  private terrain?: Terrain;
  private water?: Water;
  private foliage?: Foliage;
  private sky?: Sky;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly group = new Group();

  /** Prop geometries keyed by their Blender object name. */
  private props = new Map<string, BufferGeometry>();

  constructor(private readonly surfaces: SurfaceRegistry) {}

  async init(ctx: GameContext): Promise<void> {
    const { scene, rng } = ctx;

    scene.fog = new Fog(palette.fogNear, 55, 240);
    this.sky = new Sky(SUN_DIRECTION);
    scene.add(this.sky.mesh);
    this.addLights(ctx);

    this.terrain = new Terrain(ctx.physics);
    scene.add(this.terrain.mesh);
    this.surfaces.registerMesh(this.terrain.collider.handle, this.terrain.mesh);

    this.water = new Water();
    scene.add(this.water.mesh);

    await this.loadProps(ctx);

    scene.add(this.group);
    this.placeArchitecture(ctx);
    this.placeFurniture(ctx, rng);
    this.placeNature(ctx, rng);
    this.buildContainment(ctx);
  }

  private addLights(ctx: GameContext): void {
    // Warm key, cool fill — the pairing that produces warm light and
    // blue-violet shadow without any shader involvement.
    const hemi = new HemisphereLight(0x8fb4e8, 0xc7a878, 1.0);
    ctx.scene.add(hemi);

    const sun = new DirectionalLight(palette.sunWarm, 2.4);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(110);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(renderConfig.shadowMapSize);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 260;
    // Sized to the arena; any larger and shadow texels get too coarse to read.
    const extent = ARENA_HALF + 10;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.03;
    ctx.scene.add(sun);
    this.disposables.push(sun);
  }

  private async loadProps(ctx: GameContext): Promise<void> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL, (event) => {
      if (event.total > 0) {
        ctx.events.emit('load:progress', {
          phase: 'park',
          progress: 0.4 + 0.4 * (event.loaded / event.total),
        });
      }
    });

    gltf.scene.traverse((child) => {
      if ((child as Mesh).isMesh) {
        const mesh = child as Mesh;
        this.props.set(mesh.name, mesh.geometry);
      }
    });

    const missing = [
      'arcade_bay', 'balustrade', 'bethesda_fountain', 'bow_bridge',
      'elm_trunk', 'lamp_post', 'park_bench', 'rock_0', 'rock_1', 'rock_2',
      'stair_flight',
    ].filter((n) => !this.props.has(n));
    if (missing.length > 0) {
      throw new Error(`ParkArena: prop set is missing ${missing.join(', ')}`);
    }
  }

  // --- individual props ----------------------------------------------------

  /**
   * Places a single prop as its own mesh, with a trimesh collider and paint
   * registration. Used for large landmarks, where one extra draw call is
   * nothing and per-surface paint matters.
   */
  private placeSingle(
    ctx: GameContext,
    propName: string,
    position: Vector3,
    rotationY = 0,
    color: number = palette.stoneLit,
    scale = 1,
  ): Mesh {
    const geometry = this.props.get(propName)!;
    const material = createCelMaterial({ color });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.scale.setScalar(scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(material);

    const quaternion = new Quaternion().setFromAxisAngle(UP, rotationY);
    const collider = ctx.physics.createTrimeshAt(
      geometry.getAttribute('position').array as Float32Array,
      geometry.getIndex()!.array as Uint32Array,
      position,
      quaternion,
      scale,
    );
    this.surfaces.registerMesh(collider.handle, mesh);
    return mesh;
  }

  /**
   * Places many copies of one prop as a single instanced draw call, with a
   * collider and per-instance paint registration for each.
   */
  private placeInstanced(
    ctx: GameContext,
    propName: string,
    placements: Placement[],
    color: number,
  ): void {
    if (placements.length === 0) return;
    const geometry = this.props.get(propName)!;
    const material = createCelMaterial({ color });
    const mesh = new InstancedMesh(geometry, material, placements.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(material);

    const positions = geometry.getAttribute('position').array as Float32Array;
    const indices = geometry.getIndex()!.array as Uint32Array;
    const matrix = new Matrix4();
    const quaternion = new Quaternion();
    const scaleVec = new Vector3();

    placements.forEach((placement, i) => {
      quaternion.setFromAxisAngle(UP, placement.rotationY);
      scaleVec.setScalar(placement.scale);
      matrix.compose(placement.position, quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);

      const collider = ctx.physics.createTrimeshAt(
        positions,
        indices,
        placement.position,
        quaternion,
        placement.scale,
      );
      // Per-instance matrix, so a decal lands on the copy that was actually hit.
      this.surfaces.registerInstance(collider.handle, geometry, matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
  }

  /** A plain box with matching collider — used for slabs and walls. */
  private placeBox(
    ctx: GameContext,
    size: Vector3,
    position: Vector3,
    color: number,
    paintable = true,
  ): Mesh {
    const geometry = new BoxGeometry(size.x, size.y, size.z);
    const material = createCelMaterial({ color });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.disposables.push(geometry, material);

    const collider = ctx.physics.createStaticBox(position, {
      x: size.x / 2,
      y: size.y / 2,
      z: size.z / 2,
    });
    if (paintable) this.surfaces.registerMesh(collider.handle, mesh);
    return mesh;
  }

  // --- layout --------------------------------------------------------------

  private placeArchitecture(ctx: GameContext): void {
    // Upper terrace slab — a walkable roof over the arcade undercroft.
    const slabZ = (TERRACE.northZ + TERRACE.southZ) / 2;
    const slabDepth = TERRACE.southZ - TERRACE.northZ;
    this.placeBox(
      ctx,
      new Vector3(TERRACE.halfWidth * 2, TERRACE.slabThickness, slabDepth),
      new Vector3(0, TERRACE.y - TERRACE.slabThickness / 2, slabZ),
      palette.stoneLit,
    );

    // Arcade colonnade across the undercroft's north face.
    const half = ((ARCADE.bays - 1) * ARCADE.bayWidth) / 2;
    for (let i = 0; i < ARCADE.bays; i++) {
      const x = -half + i * ARCADE.bayWidth;
      this.placeSingle(ctx, 'arcade_bay', new Vector3(x, 0, ARCADE.z), 0, palette.stoneLit);
    }

    // Side walls closing the undercroft, either side of the colonnade.
    for (const side of [-1, 1]) {
      const innerX = side * (half + ARCADE.bayWidth / 2 + 0.6);
      const outerX = side * TERRACE.halfWidth;
      const width = Math.abs(outerX - innerX);
      this.placeBox(
        ctx,
        new Vector3(width, TERRACE.y, 1.2),
        new Vector3((innerX + outerX) / 2, TERRACE.y / 2, ARCADE.z),
        palette.stoneShade,
      );
    }

    // Grand stairs, flanking the arcade, climbing to the terrace.
    for (const side of [-1, 1]) {
      for (let flight = 0; flight < 3; flight++) {
        this.placeSingle(
          ctx,
          'stair_flight',
          new Vector3(side * 19, flight * 1.68, 27 + flight * 2.4),
          Math.PI,
          palette.stoneLit,
        );
      }
    }

    // Balustrade along the terrace's north edge, with a gap over the arcade so
    // the view down to the fountain stays open.
    const balustrades: Placement[] = [];
    for (let x = -TERRACE.halfWidth + 1; x < TERRACE.halfWidth; x += 2) {
      if (Math.abs(x) < half + ARCADE.bayWidth / 2) continue;
      balustrades.push({
        position: new Vector3(x, TERRACE.y, TERRACE.northZ + 0.4),
        rotationY: 0,
        scale: 1,
      });
    }
    // And around the plaza's lakeside edge.
    for (let a = -1.15; a <= 1.15; a += 0.12) {
      const r = 21;
      const x = Math.sin(a) * r;
      const z = -Math.cos(a) * r - 4;
      balustrades.push({
        position: new Vector3(x, heightAt(x, z), z),
        rotationY: -a,
        scale: 1,
      });
    }
    this.placeInstanced(ctx, 'balustrade', balustrades, palette.stoneLit);

    // Bethesda Fountain, at the origin.
    this.placeSingle(ctx, 'bethesda_fountain', new Vector3(0, 0, 0), 0, 0xc8bda4);

    // Bow Bridge, rotated a quarter turn so its span runs north-south across
    // the lake's western arm.
    this.placeSingle(
      ctx,
      'bow_bridge',
      new Vector3(BRIDGE.x, BRIDGE_APPROACH_Y - 0.4, BRIDGE.z),
      Math.PI / 2,
      0xd9cfba,
    );
  }

  private placeFurniture(ctx: GameContext, rng: Rng): void {
    const benches: Placement[] = [];
    const lamps: Placement[] = [];

    // Down both sides of the Mall, facing the path.
    for (let z = 30; z <= 58; z += 7) {
      for (const side of [-1, 1]) {
        const x = side * 8.5;
        benches.push({
          position: new Vector3(x, heightAt(x, z), z),
          rotationY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
          scale: 1,
        });
      }
      const lx = 11.5;
      lamps.push({ position: new Vector3(-lx, heightAt(-lx, z), z), rotationY: 0, scale: 1 });
      lamps.push({ position: new Vector3(lx, heightAt(lx, z), z), rotationY: 0, scale: 1 });
    }

    // Around the plaza rim, looking in at the fountain.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.4;
      const r = 16;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r + 2;
      if (lakeMask(x, z) > 0.1) continue;
      benches.push({
        position: new Vector3(x, heightAt(x, z), z),
        rotationY: -a + Math.PI / 2,
        scale: 1,
      });
      lamps.push({
        position: new Vector3(Math.cos(a) * 20, heightAt(Math.cos(a) * 20, Math.sin(a) * 20 + 2), Math.sin(a) * 20 + 2),
        rotationY: 0,
        scale: 1,
      });
    }

    // A couple looking out over the water.
    for (const [x, z] of [[-14, -14], [18, -16], [-46, -14]] as const) {
      benches.push({
        position: new Vector3(x, heightAt(x, z), z),
        rotationY: Math.atan2(x, z) + Math.PI,
        scale: 1,
      });
    }

    void rng;
    this.placeInstanced(ctx, 'park_bench', benches, 0x7d6a4f);
    this.placeInstanced(ctx, 'lamp_post', lamps, 0x3c3b46);
  }

  private placeNature(ctx: GameContext, rng: Rng): void {
    const trunks: Placement[] = [];
    const trees: TreeSpec[] = [];
    const rocks: Placement[][] = [[], [], []];

    const addTree = (x: number, z: number, radius: number, kind: number) => {
      const y = heightAt(x, z);
      const scale = radius / 5.5;
      trunks.push({ position: new Vector3(x, y, z), rotationY: rng.range(0, Math.PI * 2), scale });
      trees.push({
        position: new Vector3(x, y, z),
        radius,
        // Sits over the compact 8.09m trunk, low enough that the crown
        // swallows the limbs but high enough that the cards clear the ground.
        //
        // The relationship matters: crown height is 1.38*radius while a card's
        // half-height reaches 0.98*radius, leaving 0.4*radius of trunk visible
        // beneath. Dropping the crown to 1.16*radius put card bottoms at ground
        // level and swallowed the camera whole.
        crownHeight: 7.6 * scale,
        kind,
      });
    };

    // The Mall's elm allée: two formal rows, the park's most photographed line.
    for (let z = 29; z <= 60; z += 5.2) {
      for (const side of [-1, 1]) {
        addTree(side * 10.5 + rng.spread(0.6), z + rng.spread(0.8), rng.range(5.4, 6.6), 0);
      }
    }

    // The Ramble: dense, irregular, wooded.
    for (let i = 0; i < 54; i++) {
      const x = rng.range(-62, -16);
      const z = rng.range(-62, -34);
      if (rambleMask(x, z) < 0.25 || lakeMask(x, z) > 0.05) continue;
      addTree(x, z, rng.range(3.6, 6.2), 1);
    }

    // Eastern woods along the boundary.
    for (let i = 0; i < 40; i++) {
      const x = rng.range(30, 62);
      const z = rng.range(-58, 58);
      if (lakeMask(x, z) > 0.05 || plazaMask(x, z) > 0.05) continue;
      addTree(x, z, rng.range(4.0, 6.4), 1);
    }

    // A treeline hugging the boundary, so the containment wall reads as a park
    // edge rather than as a fence around an arena.
    for (let i = 0; i < 70; i++) {
      const along = rng.range(-ARENA_HALF + 4, ARENA_HALF - 4);
      const inset = rng.range(3, 11);
      const side = rng.int(0, 4);
      const x = side === 0 ? along : side === 1 ? along : -ARENA_HALF + inset + 2;
      const z = side === 0 ? -ARENA_HALF + inset + 2 : side === 1 ? ARENA_HALF - inset - 2 : along;
      const px = side < 2 ? x : side === 2 ? -ARENA_HALF + inset + 2 : ARENA_HALF - inset - 2;
      const pz = side < 2 ? z : along;
      if (lakeMask(px, pz) > 0.05) continue;
      addTree(px, pz, rng.range(4.0, 6.2), 1);
    }

    // Scattered specimens on the lawns, avoiding paving and water.
    for (let i = 0; i < 26; i++) {
      const x = rng.range(-60, 28);
      const z = rng.range(-10, 60);
      if (lakeMask(x, z) > 0.05 || plazaMask(x, z) > 0.05) continue;
      if (Math.abs(x) < 13 && z > 24) continue; // keep the allée clear
      // Keep clear of the terrace: a canopy planted at ground level beside it
      // engulfs anyone standing on the slab 4.2m up.
      if (Math.abs(x) < TERRACE.halfWidth + 6 && z > TERRACE.northZ - 8 && z < TERRACE.southZ + 8) {
        continue;
      }
      addTree(x, z, rng.range(4.2, 6.8), rng.bool(0.4) ? 0 : 1);
    }

    // Ramble outcrops, plus a few boulders on the shoreline.
    for (let i = 0; i < 22; i++) {
      const x = rng.range(-62, -14);
      const z = rng.range(-62, -30);
      if (rambleMask(x, z) < 0.3 || lakeMask(x, z) > 0.2) continue;
      const variant = rng.int(0, 3);
      rocks[variant]!.push({
        position: new Vector3(x, heightAt(x, z) - 0.4, z),
        rotationY: rng.range(0, Math.PI * 2),
        scale: rng.range(0.7, 1.4),
      });
    }

    // A dense hedge along the containment wall. The wall itself is a flat 6m
    // slab, and its perfectly straight top edge read as an arena boundary
    // rather than a park edge; overgrowing it with low foliage breaks that line
    // without giving up the flat vertical surface containment depends on.
    const hedgeStep = 3.4;
    for (let along = -ARENA_HALF + 3; along <= ARENA_HALF - 3; along += hedgeStep) {
      for (const [hx, hz] of [
        [along, -ARENA_HALF + 3.2],
        [along, ARENA_HALF - 3.2],
        [-ARENA_HALF + 3.2, along],
        [ARENA_HALF - 3.2, along],
      ] as const) {
        if (lakeMask(hx, hz) > 0.05) continue;
        trees.push({
          position: new Vector3(hx, heightAt(hx, hz), hz),
          radius: rng.range(2.4, 3.4),
          crownHeight: rng.range(3.2, 4.6),
          kind: 1,
        });
      }
    }

    this.placeInstanced(ctx, 'elm_trunk', trunks, 0x6f5c46);
    for (let v = 0; v < 3; v++) {
      this.placeInstanced(ctx, `rock_${v}`, rocks[v]!, 0x9a927f);
    }

    this.foliage = new Foliage(trees, rng);
    ctx.scene.add(this.foliage.mesh);
  }

  /**
   * Perimeter containment.
   *
   * Flat vertical walls, deliberately. Phase 1 established that the character
   * capsule can roll over ledges above the autostep height depending on
   * approach angle, so terrain and stacked geometry are not reliable boundaries
   * — a flat wall is the only thing that blocks every time.
   */
  private buildContainment(ctx: GameContext): void {
    const edge = ARENA_HALF - 2;
    const span = edge * 2 + 4;
    const hedge = 0x365c41;

    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const horizontal = sz !== 0;
      const size = horizontal
        ? new Vector3(span, WALL_HEIGHT, 2)
        : new Vector3(2, WALL_HEIGHT, span);
      const position = new Vector3(
        sx * edge,
        heightAt(sx * edge, sz * edge) + WALL_HEIGHT / 2 - 1,
        sz * edge,
      );
      this.placeBox(ctx, size, position, hedge);
    }
  }

  update(_dt: number, _alpha: number, ctx: GameContext): void {
    this.sky?.update(ctx.camera, ctx.elapsed);
    this.water?.update(ctx.elapsed);
    this.foliage?.update(ctx.elapsed);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.terrain?.mesh.removeFromParent();
    this.terrain?.dispose();
    this.water?.mesh.removeFromParent();
    this.water?.dispose();
    this.foliage?.mesh.removeFromParent();
    this.foliage?.dispose();
    this.sky?.mesh.removeFromParent();
    this.sky?.dispose();
    for (const item of this.disposables) item.dispose();
  }
}

const UP = new Vector3(0, 1, 0);
