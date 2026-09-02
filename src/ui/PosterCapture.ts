import { Matrix4, Vector3 } from 'three';
import type { GameContext, System } from '../core/System';
import type { MatchState } from '../gameplay/MatchState';
import type { RenderSystem } from '../render/Renderer';
import type { PaintScreen } from '../world/PaintScreen';

/** The poster, in pixels. 16:9, and big enough to post without looking soft. */
const POSTER_WIDTH = 1600;
const POSTER_HEIGHT = 900;

/**
 * Where the shutter stands, relative to the board.
 *
 * Eight and a half metres back at a 16-degree angle: far enough that the whole canvas is in
 * frame with the meadow and the woods around it, close enough that the painting
 * is two thirds of the picture, and off-axis so the board has perspective. A
 * square-on shot of a flat rectangle is the flat rectangle again, which is what
 * the mural's own PNG already is.
 */
const STANDOFF = 8.4;
const YAW_OFFSET = (16 * Math.PI) / 180;
/** Camera height relative to the middle of the canvas — a shade below it. */
const EYE_DROP = 0.6;
/** Narrower than the game's 62, to fill the frame with the board from 8.4m. */
const POSTER_FOV = 52;

/**
 * Anything that can hand over a picture of the round.
 *
 * Both `PaintScreen` and this implement it, which is the whole point: the card
 * shows a poster where one could be taken and the flat mural where one could
 * not, and nothing downstream has to know which it got.
 */
export interface Souvenir {
  toDataURL(): string;
  toBlob(): Promise<Blob | null>;
}

/**
 * A screenshot of the park with the mural in it, taken at the whistle.
 *
 * The prompt asked for "a game play screen capture with the painted mural in
 * it", and that is a different picture from the mural's own canvas: the canvas
 * is the painting, and this is the painting *in the park*, lit, inked and
 * standing on its plinth on the meadow with whoever is nearby still in shot.
 *
 * Three things about how it is taken, all of which are the difference between
 * this working and this silently returning a blank image:
 *
 * - **It renders through the real pipeline** by borrowing the game's own
 *   camera for one frame rather than building a second one. The outline pass,
 *   the bloom and the grade all read that camera, and a poster without them is
 *   not a picture of this game.
 * - **The readback happens in the same synchronous task as the render.** The
 *   renderer is built without `preserveDrawingBuffer` — deliberately, it costs
 *   frame time — so the drawing buffer is valid until control returns to the
 *   browser and no longer. Hence `drawImage` immediately after `render`, with
 *   nothing awaited in between.
 * - **It runs before the results stage takes the park apart.** `ResultsStage`
 *   reparents every character onto its own scene, so a capture taken after that
 *   shows an empty meadow. This system is registered ahead of `ResultsSystem`
 *   and the bus dispatches in subscription order; that ordering is the only
 *   thing enforcing it, which is why it is written down here and there.
 */
export class PosterCapture implements System {
  readonly name = 'poster';

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  /** False until a capture has actually produced pixels this round. */
  private captured = false;

  private readonly eye = new Vector3();
  private readonly offset = new Vector3();
  private readonly savedPosition = new Vector3();
  private readonly lookAt = new Matrix4();

  constructor(
    private readonly render: RenderSystem,
    private readonly screen: PaintScreen | null,
    private readonly match: MatchState,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = POSTER_WIDTH;
    this.canvas.height = POSTER_HEIGHT;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('PosterCapture: no 2D context');
    this.context = context;
  }

  init(ctx: GameContext): void {
    if (this.match.sandbox || !this.screen) return;
    ctx.events.on('match:ended', () => this.capture(ctx));
    ctx.events.on('match:started', () => {
      this.captured = false;
    });
  }

  /** Whether there is a poster from this round worth showing. */
  get hasPoster(): boolean {
    return this.captured;
  }

  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  private capture(ctx: GameContext): void {
    const screen = this.screen;
    if (!screen) return;

    const camera = ctx.camera;
    this.savedPosition.copy(camera.position);
    const savedQuaternion = camera.quaternion.clone();
    const savedFov = camera.fov;

    try {
      // Back off along the board's normal, swung round it by the yaw offset.
      this.offset
        .copy(screen.normal)
        .applyAxisAngle(UP, YAW_OFFSET)
        .multiplyScalar(STANDOFF);
      this.eye.copy(screen.centre).add(this.offset).setY(screen.centre.y - EYE_DROP);

      camera.position.copy(this.eye);
      this.lookAt.lookAt(this.eye, screen.centre, UP);
      camera.quaternion.setFromRotationMatrix(this.lookAt);
      camera.fov = POSTER_FOV;
      camera.updateProjectionMatrix();

      this.render.render(ctx.elapsed);
      this.captured = this.copyOut();
    } finally {
      camera.position.copy(this.savedPosition);
      camera.quaternion.copy(savedQuaternion);
      camera.fov = savedFov;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * Crops the freshly drawn frame to 16:9 and keeps it.
   *
   * Cropped rather than rendered at the poster's own aspect, because the frame
   * came from the game's canvas and resizing that to take a screenshot would
   * mean a resize, a reflow and a pipeline rebuild in the middle of the whistle.
   * A centre crop of a 16:10 or 4:3 window loses only sky and grass.
   *
   * Returns false when the frame came back blank, which is what a context that
   * has already discarded its drawing buffer looks like. The caller falls back
   * to the flat mural rather than showing an empty rectangle.
   */
  private copyOut(): boolean {
    const source = this.render.canvas;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (sourceWidth < 2 || sourceHeight < 2) return false;

    const wanted = POSTER_WIDTH / POSTER_HEIGHT;
    let cropWidth = sourceWidth;
    let cropHeight = Math.round(sourceWidth / wanted);
    if (cropHeight > sourceHeight) {
      cropHeight = sourceHeight;
      cropWidth = Math.round(sourceHeight * wanted);
    }
    const cropX = Math.round((sourceWidth - cropWidth) / 2);
    const cropY = Math.round((sourceHeight - cropHeight) / 2);

    this.context.drawImage(
      source,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      POSTER_WIDTH,
      POSTER_HEIGHT,
    );

    return !this.isBlank();
  }

  /**
   * Whether the copied frame is one flat colour.
   *
   * A handful of samples on a diagonal, not the whole image: the failure this
   * guards against is a *cleared* buffer, which is uniform everywhere, and a
   * real frame of this park has sky at the top and grass at the bottom.
   */
  private isBlank(): boolean {
    const samples = 9;
    let first: number | null = null;
    for (let i = 0; i < samples; i++) {
      const t = (i + 0.5) / samples;
      const pixel = this.context.getImageData(
        Math.floor(t * POSTER_WIDTH),
        Math.floor(t * POSTER_HEIGHT),
        1,
        1,
      ).data;
      const value = (pixel[0]! << 16) | (pixel[1]! << 8) | pixel[2]!;
      if (first === null) first = value;
      else if (value !== first) return false;
    }
    return true;
  }
}

const UP = new Vector3(0, 1, 0);
