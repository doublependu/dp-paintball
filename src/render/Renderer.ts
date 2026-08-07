import {
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import { camera as cameraConfig, render as renderConfig } from '../core/Config';
import { NO_OUTLINE_LAYER, NprPipeline } from './NprPipeline';

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

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderConfig.maxPixelRatio));
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
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, renderConfig.maxPixelRatio));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.pipeline?.setSize(width, height, this.renderer.getPixelRatio());
    };

    applySize();

    // ResizeObserver catches layout changes that a window resize event misses
    // (devtools docking, sidebar toggles, CSS-driven size changes).
    this.resizeObserver = new ResizeObserver(applySize);
    this.resizeObserver.observe(container);
  }

  render(elapsed: number): void {
    this.renderer.info.reset();
    if (this.pipeline) {
      this.pipeline.render(elapsed);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.pipeline?.dispose();
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
