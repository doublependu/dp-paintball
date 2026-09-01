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
/** Height of the stone plinth the board stands on. */
const PLINTH_HEIGHT = 1.1;

/**
 * Canvas resolution. 2048 across 11m is 186 texels per metre — an order of
 * magnitude past what the park's decals resolve, and the reason texture space
 * is the right answer here and the wrong one for the map.
 */
const CANVAS_WIDTH = 2048;
const CANVAS_HEIGHT = Math.round(CANVAS_WIDTH * (9 / 16));

/** Where it stands, and which way it looks. */
const SITE = { x: 13.5, z: 2 };
/** Facing west, across the fountain, into the plaza. */
const FACING = -Math.PI / 2;

/** Unpainted canvas. Not pure white — a warm rag paper sits better in this park. */
const CANVAS_WHITE = '#f7f4ec';

/** A hit has to be at least this square-on to the face to count. */
const MIN_FACING_DOT = 0.25;

/**
 * Whether (x, z) lands under the screen, plus `margin` metres of clearance.
 *
 * Exported for prop placement. The plaza's bench ring passes within a metre of
 * the board's ends, and a bench growing out of the frame is the kind of thing
 * that survives three iterations because it is only visible from one angle.
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
 * The paint screen: a canvas standing in the plaza for people to shoot at.
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
 */
export class PaintScreen {
  private readonly group = new Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly material: MeshToonMaterial;
  /**
   * The painting surface itself.
   *
   * Public because it is the frame every paint position is expressed in: its
   * local +X is the picture's width, +Y its height and +Z out of its face, so
   * `canvasMesh.localToWorld` is how anything outside here turns a place on the
   * picture into a place in the park. The suite uses it to put a hit at a known
   * spot without going through a marker and a ballistic arc.
   */
  readonly canvasMesh: Mesh;

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
  private hits = 0;

  constructor(private readonly atlas: SplatAtlas) {
    this.canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    this.context = get2D(this.canvas);
    this.context.fillStyle = CANVAS_WHITE;
    this.context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    // No mip chain: it is regenerated on every hit, and the board is never seen
    // small enough for the aliasing to be worth that cost.
    this.texture.generateMipmaps = false;

    this.tileSize = Math.floor(paintConfig.splatAtlasSize / this.atlas.tilesPerRow);
    this.atlasCanvas = this.buildAtlasCanvas();
    this.stamp = createCanvas(this.tileSize, this.tileSize);
    this.stampContext = get2D(this.stamp);

    const material = createCelMaterial({
      // White, because `map` multiplies: any tint here would tint the paint too.
      color: 0xffffff,
      map: this.texture,
      rimStrength: 0.12,
    });
    this.material = material;

    this.canvasMesh = new Mesh(new PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT), material);
    // Just proud of the frame's front face, so the two never z-fight.
    this.canvasMesh.position.z = FRAME_DEPTH / 2 + 0.012;
    this.canvasMesh.receiveShadow = true;
    this.group.add(this.canvasMesh);
  }

  /** Splats stamped since the canvas was last cleared. */
  get splatCount(): number {
    return this.hits;
  }

  /** The painting surface's size in metres, as [width, height]. */
  get size(): readonly [number, number] {
    return [BOARD_WIDTH, BOARD_HEIGHT];
  }

  /** The mural as a PNG data URL — what the results card shows. */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** The mural as a PNG blob, for sharing. Null if the browser refuses. */
  toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /** Back to bare canvas. */
  clear(): void {
    this.context.fillStyle = CANVAS_WHITE;
    this.context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.hits = 0;
    this.texture.needsUpdate = true;
  }

  /**
   * Builds the board and hangs it in the park.
   *
   * The site is the plaza's east rim: `heightAt` is flat to within 3mm across
   * the whole footprint there, it faces west across the fountain so it is the
   * first thing a player sees on turning round at spawn, and it sits inside the
   * bench ring at r=16 without displacing any of it.
   */
  build(ctx: GameContext): void {
    const ground = heightAt(SITE.x, SITE.z);
    const outerWidth = BOARD_WIDTH + BORDER * 2;
    const outerHeight = BOARD_HEIGHT + BORDER * 2;
    // The canvas's own centre height, which is what the group is placed at.
    const centreY = ground + PLINTH_HEIGHT + outerHeight / 2;

    this.group.position.set(SITE.x, centreY, SITE.z);
    this.group.rotation.y = FACING;

    const frame = new Mesh(
      new BoxGeometry(outerWidth, outerHeight, FRAME_DEPTH),
      createCelMaterial({ color: 0x4a3b2f, rimStrength: 0.2 }),
    );
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.group.add(frame);

    const plinth = new Mesh(
      new BoxGeometry(outerWidth, PLINTH_HEIGHT, FRAME_DEPTH + 0.34),
      createCelMaterial({ color: 0xd8cdb8, rimStrength: 0.2 }),
    );
    plinth.position.y = -(outerHeight / 2) - PLINTH_HEIGHT / 2;
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
      new Vector3(SITE.x, ground + PLINTH_HEIGHT / 2, SITE.z),
      { x: outerWidth / 2, y: PLINTH_HEIGHT / 2, z: (FRAME_DEPTH + 0.34) / 2 },
      rotation,
    );

    ctx.events.on('hit:world', (impact) => this.onHit(impact, ctx.rng));
  }

  /**
   * Stamps a hit, if it landed on the front of the canvas.
   *
   * Every world impact in the park arrives here, so the cheap rejections come
   * first. Note there is no collider-handle test: a hit is placed by where it
   * is, not by what it says it struck, which means the board needs no entry in
   * any registry and the plinth and frame reject themselves by geometry.
   */
  private onHit(
    impact: { point: Vector3; normal: Vector3; color: number; impactSpeed: number },
    rng: Rng,
  ): void {
    // Into the canvas plane's own frame: +X is its width, +Y its height, +Z out
    // of its face.
    this.localPoint.copy(impact.point);
    this.canvasMesh.worldToLocal(this.localPoint);

    const halfWidth = BOARD_WIDTH / 2;
    const halfHeight = BOARD_HEIGHT / 2;
    if (Math.abs(this.localPoint.x) > halfWidth) return;
    if (Math.abs(this.localPoint.y) > halfHeight) return;
    // Within the thickness of the board — a shot passing the plane somewhere
    // else in the park is not a hit on it.
    if (Math.abs(this.localPoint.z) > FRAME_DEPTH) return;

    // Front only. Without this, a shot into the back of the board prints a
    // mirrored splat on the picture, from paint nobody can see.
    FACE_NORMAL.set(0, 0, 1).applyQuaternion(this.canvasMesh.getWorldQuaternion(SCRATCH_Q));
    if (impact.normal.dot(FACE_NORMAL) < MIN_FACING_DOT) return;

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
    const radius = paintConfig.baseSplatRadius * speedScale;

    // Metres to canvas pixels. The canvas's v runs up the board and its pixel
    // rows run down, hence the flip.
    const pixelsPerMetre = CANVAS_WIDTH / BOARD_WIDTH;
    const x = (this.localPoint.x / BOARD_WIDTH + 0.5) * CANVAS_WIDTH;
    const y = (0.5 - this.localPoint.y / BOARD_HEIGHT) * CANVAS_HEIGHT;

    this.stampSplat(x, y, radius * pixelsPerMetre, impact.color, rng);
  }

  /**
   * Draws one tinted splat onto the mural.
   *
   * Two-step because a 2D context cannot tint a source image while drawing it:
   * the atlas tile goes into a scratch canvas, `source-in` floods it with the
   * shooter's colour through its own alpha, and the result is composited.
   */
  private stampSplat(
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

    const context = this.context;
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

    this.hits++;
    this.texture.needsUpdate = true;
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
    this.texture.dispose();
    this.material.dispose();
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
const FACE_NORMAL = new Vector3();
const SCRATCH_Q = new Quaternion();
