import {
  BoxGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshToonMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { paint as paintConfig } from '../core/Config';
import { clamp, remap } from '../core/MathUtils';
import type { Rng } from '../core/Random';
import type { GameContext } from '../core/System';
import type { SplatAtlas } from '../paint/SplatAtlas';
import { createCelMaterial } from '../render/CelMaterial';
import { heightAt } from './ParkLayout';

/** Painting surface, in metres. 16:9 — the picture of it goes to social media. */
const BOARD_WIDTH = 11;
const BOARD_HEIGHT = BOARD_WIDTH * (9 / 16);
/** Timber border around the canvas. */
const BORDER = 0.32;
/** How thick the whole board is, front to back. */
const FRAME_DEPTH = 0.45;
/** Clear standing height under the frame, above the highest ground it covers. */
const PLINTH_HEIGHT = 1.1;
/** How far the plinth is buried below the lowest ground under the board. */
const PLINTH_BURY = 0.25;

/**
 * Canvas resolution, front and back.
 *
 * 2048 across 11m is 186 texels per metre — an order of magnitude past what the
 * park's decals resolve, and the reason texture space is the right answer here
 * and the wrong one for the map.
 *
 * The back is half that in each dimension, which is a quarter of the memory and
 * a quarter of the upload. It is a graffiti wall facing the woods; it is never
 * exported, never put on the results card, and never seen from the distance
 * that would show the difference.
 */
const CANVAS_WIDTH = 2048;
const BACK_CANVAS_WIDTH = 1024;

/**
 * Where it stands, and which way it looks: Sheep Meadow's west rim, facing east
 * across the lawn.
 *
 * Moved out of the plaza in iteration 6. It used to stand 16m from the player's
 * spawn on the plaza's east rim, which made it the first thing you saw and the
 * last place you had to travel to. Here it is 72m from the spawn with the west
 * woods behind it, so its back faces the trees and its face looks down the
 * meadow's long sightline.
 *
 * The site was chosen by sampling `heightAt` over the real footprint rather
 * than by eye. The ground moves 0.27m across the 13.2m the frame covers — the
 * flattest ground in the park outside the paving — no walk passes within 8m,
 * `canPlant` keeps Sheep Meadow treeless so nothing grows in front of it, and
 * the woodland belt behind reaches 0.68 density within 30m. Two neighbouring
 * spots are flatter still and both put the board's north end within 1.8m of the
 * meadow's western walk, which is a canvas you walk into rather than look at.
 */
const SITE = { x: -64, z: 42 };
/** Facing east, into the meadow. Local +Z is (sin, cos) of this in world XZ. */
const FACING = Math.PI / 2;

/** Unpainted canvas. Not pure white — a warm rag paper sits better in this park. */
const CANVAS_WHITE = '#f7f4ec';

/** Seconds between texture uploads, whatever has landed in between. */
const UPLOAD_INTERVAL = 1 / 20;

/**
 * How the front is divided up between painters: four corners, and nothing else.
 *
 * It used to be two full-height columns, 4.73m by 4.58m, which between them
 * owned the whole picture. That was a legibility budget — a paintball lands as
 * a blob half a metre across, so a drawing needs several metres to read as a
 * sun rather than as a splatter — and it answered the wrong question. The board
 * is the player's canvas. What the bots want is a corner of it.
 *
 * So: a 2.8 x 2.6m drawing box inset 0.45m from each edge of the canvas. Three
 * painters at once is 21.8m² of the board's 68.1m², all of it at the rim, and
 * the whole central band stays the player's. What survives at that size is a
 * shorter list than the full catalogue, which is what `MuralDesign.minBox` is
 * for.
 *
 * Four slots for at most three painters (`mural.maxPainters`) is deliberate: it
 * keeps the least-recently-used hand-out in `claimSlot` meaningful, so a second
 * round of drawings does not land on the first.
 */
const SLOT_COUNT = 4;
/** The drawing box itself, in metres. */
const SLOT_BOX_WIDTH = 2.8;
const SLOT_BOX_HEIGHT = 2.6;
/** How far the box is held off the canvas edge, in metres. */
const SLOT_INSET = 0.45;

/** One painter's patch of the front, in uv. */
export interface MuralSlot {
  readonly index: number;
  /** Centre of the slot on the picture. */
  readonly u: number;
  readonly v: number;
  /** Half-extents of the *drawing area* inside it, in uv. */
  readonly halfU: number;
  readonly halfV: number;
  /** And the same in metres, which is what stroke spacing is measured in. */
  readonly widthMetres: number;
  readonly heightMetres: number;
}

/**
 * What a bot needs from the board in order to paint on it.
 *
 * Narrow on purpose: the AI has no business holding a canvas, a texture or a
 * data URL, and this is everything it actually asks — where the board is,
 * which way it faces, and which part of it is mine.
 */
export interface MuralBoard {
  readonly centre: Vector3;
  readonly normal: Vector3;
  claimSlot(ownerId: string): MuralSlot | null;
  releaseSlot(ownerId: string): void;
  worldPointAt(u: number, v: number, out: Vector3): Vector3;
}

/**
 * Whether (x, z) lands under the screen, plus `margin` metres of clearance.
 *
 * Exported for prop and tree placement. Benches read it because the plaza's
 * bench ring used to pass within a metre of the board's ends; trees read it
 * because the meadow's mask — which is what actually keeps this site clear —
 * falls off exactly where the board's ends are.
 */
export function screenBlocks(x: number, z: number, margin = 0): boolean {
  const dx = x - SITE.x;
  const dz = z - SITE.z;
  // Into the board's own axes: `u` runs along its width, `w` through its depth.
  const u = dx * Math.cos(FACING) - dz * Math.sin(FACING);
  const w = dx * Math.sin(FACING) + dz * Math.cos(FACING);
  const halfWidth = (BOARD_WIDTH + BORDER * 2) / 2;
  const halfDepth = (FRAME_DEPTH + 0.34) / 2;
  return Math.abs(u) <= halfWidth + margin && Math.abs(w) <= halfDepth + margin;
}

/**
 * One painted side of the board: a canvas, the texture over it, and the mesh
 * showing it.
 *
 * The two sides are the same machinery at two resolutions and two orientations,
 * and everything that differs between them — where paint lands, what gets
 * wiped, what leaves the game — is decided by whoever holds the pair.
 */
class Face {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly material: MeshToonMaterial;
  readonly mesh: Mesh;
  /** Whether the picture runs right-to-left, which the back's does. */
  readonly mirrored: boolean;
  hits = 0;
  /** Painted since the texture was last handed to the GPU. See `flush`. */
  dirty = false;

  constructor(width: number, mirrored: boolean, z: number, faceOut: number) {
    this.mirrored = mirrored;
    const height = Math.round(width * (9 / 16));
    this.canvas = createCanvas(width, height);
    this.context = get2D(this.canvas);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    // No mip chain: it is regenerated on every hit, and the board is never seen
    // small enough for the aliasing to be worth that cost.
    this.texture.generateMipmaps = false;

    this.material = createCelMaterial({
      // White, because `map` multiplies: any tint here would tint the paint too.
      color: 0xffffff,
      map: this.texture,
      rimStrength: 0.12,
    });

    this.mesh = new Mesh(new PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT), this.material);
    this.mesh.position.z = z;
    // The back plane is turned to face the other way, so each face's own +Z
    // points out of the board and `localToWorld` means the same thing on both.
    this.mesh.rotation.y = faceOut < 0 ? Math.PI : 0;
    this.mesh.receiveShadow = true;

    this.clear();
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  clear(): void {
    this.context.fillStyle = CANVAS_WHITE;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.hits = 0;
    // Immediate, not deferred: a wipe is the one change that must not be seen
    // late, because it happens at the start of a round rather than during one.
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  /** Hands the canvas to the GPU, if anything has landed on it. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * The paint screen: a canvas standing on Sheep Meadow's west rim for people to
 * shoot at, painted on both sides.
 *
 * Deliberately *not* a `SurfaceRegistry` receiver, so world decals never land
 * on it. It accumulates paint in texture space instead — a 2D canvas stamped
 * per hit and uploaded as a `CanvasTexture` — which is the technique
 * `PaintSystem`'s header rejects for the park. The reason it rejects it there is
 * the reason it holds here: texture space fails across a 130m map because a
 * 4096 atlas buys five texels per metre, and succeeds on one 11m board because
 * the same budget buys nearly two hundred.
 *
 * Two things follow from that, and both are the point:
 *
 * - **The mural cannot be evicted.** World paint is a bounded vertex buffer
 *   that drops its oldest decals, and a board everyone shoots at on purpose is
 *   the heaviest decal producer in the park — it would spend the whole budget
 *   and then erase its own beginning.
 * - **The picture can leave the game.** `toDataURL` is the shareable poster,
 *   with no orthographic camera, no render target and no pixel readback.
 *
 * The two faces are not symmetrical, and the asymmetry is the design:
 *
 * - The **front** looks down the meadow. It is the round's canvas, it is what
 *   the results card shows, and it is wiped at every whistle — a souvenir that
 *   is half of last round's game is not this round's souvenir.
 * - The **back** faces the woods. Nothing photographs it, so it keeps whatever
 *   anybody has ever put on it, exactly as the park's world paint does.
 */
export class PaintScreen {
  private readonly group = new Group();
  private readonly front: Face;
  private readonly back: Face;

  /**
   * The painting surface itself — the front.
   *
   * Public because it is the frame every paint position is expressed in: its
   * local +X is the picture's width, +Y its height and +Z out of its face, so
   * `canvasMesh.localToWorld` is how anything outside here turns a place on the
   * picture into a place in the park. The suite uses it to put a hit at a known
   * spot without going through a marker and a ballistic arc.
   */
  readonly canvasMesh: Mesh;
  /** The same, for the back. Its own +Z points out of the back of the board. */
  readonly backMesh: Mesh;

  /**
   * The splat atlas as something `drawImage` can read.
   *
   * The atlas itself is a `DataTexture` over a `Uint8Array` — fine for a
   * sampler, useless to a 2D context — so it is copied into a canvas once at
   * build time. Shared shapes matter: a splat on this board should be the same
   * splat as one on a bench.
   */
  private readonly atlasCanvas: HTMLCanvasElement;
  /** Scratch canvas, one tile big, where a splat is tinted before compositing. */
  private readonly stamp: HTMLCanvasElement;
  private readonly stampContext: CanvasRenderingContext2D;
  private readonly tileSize: number;

  private readonly localPoint = new Vector3();

  /**
   * Where the front of the picture is and which way it looks, in world space.
   *
   * Resolved once in `build` and then read rather than recomputed: anything
   * that wants to stand in front of the board — the poster camera, a bot
   * setting up to paint — asks the same two questions every time, and neither
   * answer ever changes again.
   */
  readonly centre = new Vector3();
  readonly normal = new Vector3();

  private sinceUpload = 0;

  /**
   * Who is painting where, by slot index.
   *
   * A lease rather than a lock: it keeps two bots from drawing on top of each
   * other, and it does not stop the player from shooting straight through
   * somebody's cat. Cleared with the front at every whistle.
   */
  private readonly claims = new Map<string, number>();
  /**
   * When each slot was last handed out, as a counter rather than a clock.
   *
   * Slots go out least-recently-used rather than lowest-index-first, and the
   * difference is the whole point of having two: handing out the first free one
   * puts every drawing in a round on the same half of the board, one on top of
   * the last. In practice painters come one at a time — two bots in front of the
   * same board can see each other and would rather fight — so without this the
   * second half of the mural would never be used at all.
   */
  private readonly slotUsed: number[] = [];
  private claimTick = 0;

  constructor(private readonly atlas: SplatAtlas) {
    this.tileSize = Math.floor(paintConfig.splatAtlasSize / this.atlas.tilesPerRow);
    this.atlasCanvas = this.buildAtlasCanvas();
    this.stamp = createCanvas(this.tileSize, this.tileSize);
    this.stampContext = get2D(this.stamp);

    // Just proud of the frame's faces, so neither plane z-fights the timber.
    this.front = new Face(CANVAS_WIDTH, false, FRAME_DEPTH / 2 + 0.012, 1);
    this.back = new Face(BACK_CANVAS_WIDTH, true, -(FRAME_DEPTH / 2 + 0.012), -1);
    this.canvasMesh = this.front.mesh;
    this.backMesh = this.back.mesh;
    this.group.add(this.front.mesh, this.back.mesh);
  }

  /** Splats stamped on the front since it was last cleared. */
  get splatCount(): number {
    return this.front.hits;
  }

  /** And on the back, which is only cleared when the whole board is. */
  get backSplatCount(): number {
    return this.back.hits;
  }

  /** The painting surface's size in metres, as [width, height]. */
  get size(): readonly [number, number] {
    return [BOARD_WIDTH, BOARD_HEIGHT];
  }

  /**
   * The mural as a PNG data URL — what the results card falls back to.
   *
   * Takes a face because the suite has to read the back to check that a shot
   * from behind lands mirrored; everything in the game asks for the front, and
   * the front is the default for that reason.
   */
  toDataURL(face: 'front' | 'back' = 'front'): string {
    return (face === 'back' ? this.back : this.front).canvas.toDataURL('image/png');
  }

  /** The mural as a PNG blob, for sharing. Null if the browser refuses. */
  toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => this.front.canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * Wipes the front. This is what a fresh round does.
   *
   * The back is deliberately untouched — see the class comment. So is the
   * park's world paint, for the reason `MatchSystem.restart` already gives.
   */
  clearFront(): void {
    this.front.clear();
    // The leases go with the paint. Anybody still holding one is painting a
    // picture that no longer exists, and `Bot` drops the errand on the same
    // event — this is what makes the slot available again rather than held by
    // a bot that has forgotten about it.
    this.claims.clear();
    this.slotUsed.length = 0;
  }

  /** Wipes the back. Nothing in the game calls this; it exists for the suite. */
  clearBack(): void {
    this.back.clear();
  }

  /** Both faces, back to bare canvas. */
  clear(): void {
    this.front.clear();
    this.back.clear();
  }

  /**
   * Builds the board and hangs it in the park.
   *
   * The board's bottom edge sits `PLINTH_HEIGHT` above the *highest* ground
   * under its footprint and the plinth is buried below the lowest, so a site
   * with a quarter-metre of fall across it still gets a level board with no
   * daylight under one end. Sampling the centre alone was enough on the paved
   * plaza and is not enough on a lawn.
   */
  build(ctx: GameContext): void {
    const outerWidth = BOARD_WIDTH + BORDER * 2;
    const outerHeight = BOARD_HEIGHT + BORDER * 2;

    const { min: groundMin, max: groundMax } = this.groundRange(outerWidth);
    const frameBottom = groundMax + PLINTH_HEIGHT;
    const plinthBase = groundMin - PLINTH_BURY;
    const plinthHeight = frameBottom - plinthBase;
    // The canvas's own centre height, which is what the group is placed at.
    const centreY = frameBottom + outerHeight / 2;

    this.group.position.set(SITE.x, centreY, SITE.z);
    this.group.rotation.y = FACING;

    const frame = new Mesh(
      new BoxGeometry(outerWidth, outerHeight, FRAME_DEPTH),
      createCelMaterial({ color: 0x4a3b2f, rimStrength: 0.2 }),
    );
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.group.add(frame);

    const plinthDepth = FRAME_DEPTH + 0.34;
    const plinth = new Mesh(
      new BoxGeometry(outerWidth, plinthHeight, plinthDepth),
      createCelMaterial({ color: 0xd8cdb8, rimStrength: 0.2 }),
    );
    plinth.position.y = plinthBase + plinthHeight / 2 - centreY;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    this.group.add(plinth);

    ctx.scene.add(this.group);
    // Local transforms are read per hit to place paint; resolve them once here
    // rather than trusting whenever the renderer last walked the graph.
    this.group.updateMatrixWorld(true);

    const rotation = new Quaternion().setFromAxisAngle(UP, FACING);
    ctx.physics.createStaticBox(
      this.group.position,
      { x: outerWidth / 2, y: outerHeight / 2, z: FRAME_DEPTH / 2 },
      rotation,
    );
    ctx.physics.createStaticBox(
      new Vector3(SITE.x, plinthBase + plinthHeight / 2, SITE.z),
      { x: outerWidth / 2, y: plinthHeight / 2, z: plinthDepth / 2 },
      rotation,
    );

    this.canvasMesh.getWorldPosition(this.centre);
    this.normal.set(Math.sin(FACING), 0, Math.cos(FACING));

    ctx.events.on('hit:world', (impact) => this.onHit(impact, ctx.rng));
    // A fresh round gets a fresh canvas to paint. This also fires once during
    // boot, from `MatchSystem.init`, where it wipes an already-blank front —
    // harmless, and not worth a guard that would then also skip a restart.
    ctx.events.on('match:started', () => this.clearFront());
  }

  /**
   * Hands whatever has been painted to the GPU, a few times a second.
   *
   * Setting `needsUpdate` per hit re-uploads the entire canvas — 2048 x 1152
   * RGBA is 9.4MB — and while three coalesces several hits in one frame into
   * one upload, the steady state once bots paint the board deliberately is one
   * full upload *per frame*, all round. At 20Hz the paint arrives up to 50ms
   * late, which is under three frames and has no tell, and the bandwidth falls
   * by two thirds at a firing rate and by an order of magnitude at a bot's.
   *
   * Driven from `ParkArenaSystem.update`, which owns this object's lifetime.
   */
  update(dt: number): void {
    this.sinceUpload += dt;
    if (this.sinceUpload < UPLOAD_INTERVAL) return;
    this.sinceUpload = 0;
    this.front.flush();
    this.back.flush();
  }

  /**
   * Hands out a free patch of the front, or null when both are taken.
   *
   * Re-claiming while already holding one returns the same slot, so a bot that
   * asks twice does not quietly take the other half of the board with it.
   */
  claimSlot(ownerId: string): MuralSlot | null {
    const held = this.claims.get(ownerId);
    if (held !== undefined) return this.slotAt(held);

    let best = -1;
    for (let index = 0; index < SLOT_COUNT; index++) {
      let taken = false;
      for (const value of this.claims.values()) if (value === index) taken = true;
      if (taken) continue;
      if (best === -1 || (this.slotUsed[index] ?? 0) < (this.slotUsed[best] ?? 0)) best = index;
    }
    if (best === -1) return null;

    this.claims.set(ownerId, best);
    this.slotUsed[best] = ++this.claimTick;
    return this.slotAt(best);
  }

  releaseSlot(ownerId: string): void {
    this.claims.delete(ownerId);
  }

  /** Which slot somebody holds, for the suite. */
  slotOf(ownerId: string): number | undefined {
    return this.claims.get(ownerId);
  }

  /**
   * One corner, by index: 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right.
   *
   * Public because the suite has to check that a drawing landed inside its own
   * box and outside the band the player is being left, and asking the board
   * where its boxes are beats restating the arithmetic in the test.
   */
  slotAt(index: number): MuralSlot {
    const halfU = SLOT_BOX_WIDTH / 2 / BOARD_WIDTH;
    const halfV = SLOT_BOX_HEIGHT / 2 / BOARD_HEIGHT;
    // Centre of the box nearest each edge, in uv.
    const nearU = (SLOT_INSET + SLOT_BOX_WIDTH / 2) / BOARD_WIDTH;
    const nearV = (SLOT_INSET + SLOT_BOX_HEIGHT / 2) / BOARD_HEIGHT;
    return {
      index,
      u: index % 2 === 0 ? nearU : 1 - nearU,
      v: index < 2 ? nearV : 1 - nearV,
      halfU,
      halfV,
      widthMetres: SLOT_BOX_WIDTH,
      heightMetres: SLOT_BOX_HEIGHT,
    };
  }

  /** How many corners there are to hand out. */
  get slotCount(): number {
    return SLOT_COUNT;
  }

  /**
   * A place on the picture, in world space.
   *
   * `u` and `v` run 0..1 from the picture's left and *top*, matching the canvas
   * rather than the mesh, because everything outside here that has an opinion
   * about where to put paint — a design laid out in a unit square, a slot on
   * the board — thinks in image coordinates.
   */
  worldPointAt(u: number, v: number, out: Vector3): Vector3 {
    out.set((u - 0.5) * BOARD_WIDTH, (0.5 - v) * BOARD_HEIGHT, 0);
    return this.canvasMesh.localToWorld(out);
  }

  /** Lowest and highest ground under the board's footprint. */
  private groundRange(outerWidth: number): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    const halfWidth = outerWidth / 2;
    const halfDepth = (FRAME_DEPTH + 0.34) / 2;
    const alongX = Math.cos(FACING);
    const alongZ = -Math.sin(FACING);
    for (let u = -halfWidth; u <= halfWidth + 1e-6; u += 0.5) {
      for (let w = -halfDepth; w <= halfDepth + 1e-6; w += halfDepth) {
        const x = SITE.x + u * alongX + w * Math.sin(FACING);
        const z = SITE.z + u * alongZ + w * Math.cos(FACING);
        const h = heightAt(x, z);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return { min, max };
  }

  /**
   * Stamps a hit, if it landed on either face of the canvas.
   *
   * Every world impact in the park arrives here, so the cheap rejections come
   * first. Note there is no collider-handle test: a hit is placed by where it
   * is, not by what it says it struck, which means the board needs no entry in
   * any registry and the plinth and frame reject themselves by geometry.
   *
   * Work is done in the *group's* frame rather than either plane's, because
   * that is the one frame in which the two faces are simply +Z and -Z.
   */
  private onHit(
    impact: { point: Vector3; color: number; impactSpeed: number },
    rng: Rng,
  ): void {
    // Into the board's own frame: +X is its width, +Y its height, +Z out of the
    // front.
    this.localPoint.copy(impact.point);
    this.group.worldToLocal(this.localPoint);

    const halfWidth = BOARD_WIDTH / 2;
    const halfHeight = BOARD_HEIGHT / 2;
    if (Math.abs(this.localPoint.x) > halfWidth) return;
    if (Math.abs(this.localPoint.y) > halfHeight) return;
    // Within the thickness of the board — a shot passing the plane somewhere
    // else in the park is not a hit on it.
    if (Math.abs(this.localPoint.z) > FRAME_DEPTH) return;

    // Which side, decided by where the hit is rather than by which way its
    // normal points.
    //
    // The normal was the obvious test and it is wrong: a swept-sphere cast
    // against a box reports a contact normal that can come back either way
    // round, and a burst fired into the back of the board split roughly evenly
    // between the two faces — half of it printing mirrored onto the picture.
    // The position has no such ambiguity. Every real hit lands on the frame's
    // front or back plane, a clean 0.45m apart, and the only hits that land
    // anywhere in between are on the top and side edges, which the bounds check
    // above has already rejected for being outside the canvas.
    const face = this.localPoint.z >= 0 ? this.front : this.back;

    const speedScale = clamp(
      remap(
        impact.impactSpeed,
        paintConfig.splatSpeedMin,
        paintConfig.splatSpeedMax,
        paintConfig.minSplatScale,
        paintConfig.maxSplatScale,
      ),
      paintConfig.minSplatScale,
      paintConfig.maxSplatScale,
    );
    // Scaled down against the park's own splat size. A board whose purpose is
    // being painted on wants a finer mark than a bench that merely gets hit:
    // at the world radius a splat is nearly a metre across here, which is three
    // blobs to a drawing. See `paint.screenSplatScale`.
    const radius = paintConfig.baseSplatRadius * speedScale * paintConfig.screenSplatScale;

    // Metres to canvas pixels. The canvas's v runs up the board and its pixel
    // rows run down, hence the flip; the back's u runs the other way, because
    // its picture is read from the far side and a splat has to land where the
    // person who fired it saw it land.
    const pixelsPerMetre = face.width / BOARD_WIDTH;
    const u = face.mirrored
      ? 0.5 - this.localPoint.x / BOARD_WIDTH
      : this.localPoint.x / BOARD_WIDTH + 0.5;
    const x = u * face.width;
    const y = (0.5 - this.localPoint.y / BOARD_HEIGHT) * face.height;

    this.stampSplat(face, x, y, radius * pixelsPerMetre, impact.color, rng);
  }

  /**
   * Draws one tinted splat onto a face.
   *
   * Two-step because a 2D context cannot tint a source image while drawing it:
   * the atlas tile goes into a scratch canvas, `source-in` floods it with the
   * shooter's colour through its own alpha, and the result is composited.
   */
  private stampSplat(
    face: Face,
    x: number,
    y: number,
    radius: number,
    color: number,
    rng: Rng,
  ): void {
    const variant = rng.int(0, this.atlas.variants);
    const tileX = (variant % this.atlas.tilesPerRow) * this.tileSize;
    const tileY = Math.floor(variant / this.atlas.tilesPerRow) * this.tileSize;

    const tinted = this.stampContext;
    tinted.globalCompositeOperation = 'copy';
    tinted.drawImage(
      this.atlasCanvas,
      tileX,
      tileY,
      this.tileSize,
      this.tileSize,
      0,
      0,
      this.tileSize,
      this.tileSize,
    );
    tinted.globalCompositeOperation = 'source-in';
    tinted.fillStyle = hexColor(color);
    tinted.fillRect(0, 0, this.tileSize, this.tileSize);

    const context = face.context;
    context.save();
    context.translate(x, y);
    // A random roll, so repeated hits in one place do not stamp identically —
    // the same reason `PaintSystem` rolls its decal box.
    context.rotate(rng.range(0, Math.PI * 2));

    // Twice, at two sizes, which is how the wet rim gets here.
    //
    // Both paint shaders darken the edge with `0.74 + 0.26 * field`, reading the
    // atlas's red channel as a scalar. A 2D context has no way to multiply by
    // one channel — `multiply` takes all three, and the atlas's green and blue
    // carry interior noise and a drip mask, not luminance. Drawing a darkened
    // copy at full size and the true colour just inside it lands in the same
    // place for two `drawImage` calls.
    context.filter = 'brightness(0.74)';
    context.drawImage(this.stamp, -radius, -radius, radius * 2, radius * 2);
    context.filter = 'none';
    const inner = radius * 0.88;
    context.drawImage(this.stamp, -inner, -inner, inner * 2, inner * 2);
    context.restore();

    face.hits++;
    // Marked, not uploaded. See `update`.
    face.dirty = true;
  }

  /** Copies the splat atlas into a canvas `drawImage` can source from. */
  private buildAtlasCanvas(): HTMLCanvasElement {
    const size = paintConfig.splatAtlasSize;
    const canvas = createCanvas(size, size);
    const context = get2D(canvas);
    const pixels = this.atlas.texture.image.data as Uint8Array;
    // Copied rather than wrapped: ImageData needs its own buffer, and the
    // atlas's is owned by a live texture.
    const image = context.createImageData(size, size);
    image.data.set(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.length));
    context.putImageData(image, 0, 0);
    return canvas;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      if (!Array.isArray(object.material)) object.material.dispose();
    });
    this.front.dispose();
    this.back.dispose();
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function get2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('PaintScreen: no 2D context');
  return context;
}

function hexColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

const UP = new Vector3(0, 1, 0);
