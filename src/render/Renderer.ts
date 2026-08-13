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
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap()));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      if (this.overlay) {
        this.overlay.camera.aspect = this.camera.aspect;
        this.overlay.camera.updateProjectionMatrix();
      }
      this.pipeline?.setSize(width, height, this.renderer.getPixelRatio());
    };

    applySize();

    // ResizeObserver catches layout changes that a window resize event misses
    // (devtools docking, sidebar toggles, CSS-driven size changes).
    this.resizeObserver = new ResizeObserver(applySize);
    this.resizeObserver.observe(container);
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

  render(elapsed: number): void {
    this.renderer.info.reset();
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
