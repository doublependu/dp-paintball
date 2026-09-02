import {
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import {
  camera as cameraConfig,
  render as renderConfig,
  touch as touchConfig,
} from '../core/Config';
import { isTouchDevice } from '../core/Device';
import { NO_OUTLINE_LAYER, NprPipeline } from './NprPipeline';

/**
 * How much of the device's pixel ratio we are willing to pay for.
 *
 * A phone reports 3 and has nothing like the fill rate to back it. Asked here
 * rather than baked into the config so both the constructor and the resize
 * path get the same answer.
 */
function pixelRatioCap(): number {
  return isTouchDevice() ? touchConfig.maxPixelRatio : renderConfig.maxPixelRatio;
}

/**
 * Sun shadow map resolution, halved on a phone.
 *
 * Lives here beside the pixel-ratio cap because they are the same decision —
 * what this machine can afford — and the two arenas that light a sun both ask
 * for it rather than reading the desktop number.
 */
export function shadowMapSize(): number {
  return isTouchDevice() ? touchConfig.shadowMapSize : renderConfig.shadowMapSize;
}

export interface RenderTargets {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
}

/**
 * Owns the WebGL context, the root scene, and the camera, plus resize handling.
 *
 * The post-processing stack lands here in phase 3; for now this renders the
 * scene directly so the rest of the foundation can be exercised.
 */
export class RenderSystem {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  private resizeObserver?: ResizeObserver;
  private pipeline?: NprPipeline;
  private overlay: { scene: Scene; camera: PerspectiveCamera } | null = null;

  /** Current CSS size, kept so a resolution change can re-apply it. */
  private cssWidth = 1;
  private cssHeight = 1;
  /** What the adaptive loop has settled on, before the device cap. */
  private ratioScale = 1;
  private lastFrameAt = 0;
  private readonly frameTimes: number[] = [];
  private lastRatioChangeAt = 0;
  /** Counts frames so the shadow map can be redrawn on some of them. */
  private frame = 0;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.append(this.canvas);

    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      // We never composite the canvas over page content, and an opaque context
      // is measurably cheaper.
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap()));
    this.renderer.outputColorSpace = SRGBColorSpace;
    // ACES crushes saturated flats, which is exactly what cel shading is made
    // of. Neutral keeps the paint colors popping while still taming highlights.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // renderer.info resets on every render() by default. The composer issues
    // one per pass, so the stats would only ever describe the final fullscreen
    // quad — draw calls and triangles for the actual scene would read as 1.
    // Reset manually, once per frame, instead.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of r185. Crisp-edged shadows suit the
    // cel look anyway — Ghibli shadow edges are hard, not blurred.
    this.renderer.shadowMap.type = PCFShadowMap;
    // Redrawn on a cadence rather than every frame — see `render` below.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    this.scene = new Scene();

    this.camera = new PerspectiveCamera(
      cameraConfig.fov,
      1,
      cameraConfig.near,
      cameraConfig.far,
    );
    this.camera.position.set(0, 3, 8);
    // The sky sits on this layer; the camera must see it even though the
    // outline prepass explicitly does not.
    this.camera.layers.enable(NO_OUTLINE_LAYER);

    this.observeResize(container);

    this.pipeline = new NprPipeline(this.renderer, this.scene, this.camera);
  }

  private observeResize(container: HTMLElement): void {
    const applySize = () => {
      this.cssWidth = container.clientWidth || window.innerWidth;
      this.cssHeight = container.clientHeight || window.innerHeight;
      this.applyResolution();
      this.camera.aspect = this.cssWidth / this.cssHeight;
      this.camera.updateProjectionMatrix();
      if (this.overlay) {
        this.overlay.camera.aspect = this.camera.aspect;
        this.overlay.camera.updateProjectionMatrix();
      }
    };

    applySize();

    // ResizeObserver catches layout changes that a window resize event misses
    // (devtools docking, sidebar toggles, CSS-driven size changes).
    this.resizeObserver = new ResizeObserver(applySize);
    this.resizeObserver.observe(container);
  }

  /**
   * Pushes the current size and pixel ratio through to everything that holds a
   * buffer sized by them.
   *
   * The ratio is the device's, capped for the machine, then scaled by whatever
   * the adaptive loop has decided this frame rate can afford. Shadow maps are
   * invalidated because their content is now stale against a different buffer.
   */
  private applyResolution(): void {
    const ratio = Math.min(window.devicePixelRatio, pixelRatioCap()) * this.ratioScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
    this.pipeline?.setSize(this.cssWidth, this.cssHeight, this.renderer.getPixelRatio());
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Walks the render resolution down when frames run long, and back up when
   * they stop.
   *
   * This is the answer to "the game feels laggy when I move the mouse". Looking
   * around has no smoothing in it anywhere — the mouse delta goes straight into
   * the camera's yaw in the same frame it arrives — so what a player feels when
   * panning is nothing but how long a frame takes, and the fastest way to make
   * a frame shorter is to draw fewer pixels of it. Four full-screen passes at
   * DPR 2 on a 4K display is 8.3 million fragments each.
   *
   * Deliberately slow and deliberately hysteretic: the thresholds are 8ms
   * apart, nothing changes more often than every couple of seconds, and each
   * step is a quarter. Every change reallocates the composer's targets, which
   * costs a hitch — a resolution that hunts is worse than one that is slightly
   * too low.
   */
  private adaptResolution(): void {
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      this.frameTimes.push(now - this.lastFrameAt);
      if (this.frameTimes.length > 90) this.frameTimes.shift();
    }
    this.lastFrameAt = now;
    if (this.lastRatioChangeAt === 0) this.lastRatioChangeAt = now;

    // Wall clock, and a small sample.
    //
    // Both were the other way round first — a settle timer fed by the frame
    // delta, and a sixty-frame minimum — and both are backwards on exactly the
    // machine this exists for. The frame delta is clamped at `MAX_FRAME_DT`, so
    // a machine drawing at three frames a second accumulates a quarter of a
    // second per frame and takes half a minute to reach a two-and-a-half-second
    // timer; sixty samples at that rate is twenty seconds more. Measured under
    // a software rasteriser at 1.3 seconds a frame, the resolution never moved
    // at all. Twenty frames of wall clock is a stable enough median and reacts
    // while somebody is still looking at it.
    if (now - this.lastRatioChangeAt < renderConfig.resolutionSettleSeconds * 1000) return;
    if (this.frameTimes.length < 8) return;

    // Median, not mean: one 200ms hitch from a garbage collection or a texture
    // upload must not spend a quarter of the resolution.
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;

    const step = renderConfig.pixelRatioStep;
    const capped = Math.min(window.devicePixelRatio, pixelRatioCap());
    const floor = renderConfig.minPixelRatio / capped;
    let next = this.ratioScale;
    if (median > renderConfig.slowFrameMs) next = Math.max(floor, this.ratioScale - step);
    else if (median < renderConfig.fastFrameMs) next = Math.min(1, this.ratioScale + step);

    if (next === this.ratioScale) return;
    this.ratioScale = next;
    this.lastRatioChangeAt = now;
    this.frameTimes.length = 0;
    this.applyResolution();
  }

  /** What the adaptive loop has settled on, 0..1 of the cap. For the perf HUD. */
  get resolutionScale(): number {
    return this.ratioScale;
  }

  /** The NPR pipeline, exposed for profiling. */
  get nprPipeline(): NprPipeline | undefined {
    return this.pipeline;
  }

  /**
   * A second scene drawn on top of the finished frame, or null for none.
   *
   * This is how the end-of-round showcase gets in front of the park without a
   * second WebGL context. It is drawn *after* post-processing on purpose: the
   * outline pass and the grade belong to the world, and running the showcase
   * through them would ink and tint a presentation that is not part of it.
   *
   * Its own aspect is kept in step with the canvas here, so the overlay never
   * has to watch for resizes itself.
   */
  setOverlay(overlay: { scene: Scene; camera: PerspectiveCamera } | null): void {
    this.overlay = overlay;
    if (overlay) {
      overlay.camera.aspect = this.camera.aspect;
      overlay.camera.updateProjectionMatrix();
    }
  }

  render(elapsed: number, adapt = false): void {
    this.renderer.info.reset();
    // Only frames driven by the loop pace the resolution. A poster capture and
    // a manual-mode repaint are neither frames the player waited for nor frames
    // whose cost says anything about how the game is running.
    if (adapt) this.adaptResolution();

    // The sun is fixed and the only things that move are seven people and a
    // handful of paintballs, so the shadow map is redrawn on a cadence rather
    // than every frame. Set immediately before the render that should consume
    // it: any other `renderer.render` in the same frame — the results overlay,
    // the poster capture — would otherwise spend it on a scene that does not
    // need it.
    this.renderer.shadowMap.needsUpdate =
      this.frame % renderConfig.shadowUpdateInterval === 0;
    this.frame++;

    if (this.pipeline) {
      this.pipeline.render(elapsed);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    const overlay = this.overlay;
    if (!overlay) return;
    // The composer's last pass leaves the default framebuffer bound, but say so
    // explicitly rather than depending on it. `autoClear` off keeps the colour
    // we just spent a frame producing; the depth buffer *is* cleared, or the
    // world's depth would occlude a showcase that sits nowhere near it.
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(overlay.scene, overlay.camera);
    this.renderer.autoClear = true;
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
