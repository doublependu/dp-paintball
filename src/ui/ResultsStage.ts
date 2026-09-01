import {
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Character } from '../character/Character';
import { palette } from '../core/Config';
import { createCelMaterial } from '../render/CelMaterial';
import { NO_OUTLINE_LAYER } from '../render/NprPipeline';

/** Vertical field of view. Narrow, so the row reads as a line-up, not a fisheye. */
const FOV = 38;
/** Metres between figures on the stage. */
const SPACING = 1.5;
/** How fast each figure turns, in radians per second. */
const SPIN_RATE = 0.55;
/** Figures sit this far apart in depth across the arc, for a little parallax. */
const ARC_DEPTH = 0.55;
/**
 * Fraction of the frame height the panel covers along the bottom, before the
 * real card has been measured. The line-up is pushed above it rather than
 * centred, or the DOM card sits over their legs.
 */
const DEFAULT_PANEL_SHARE = 0.34;

/**
 * The end-of-round line-up: everybody's character, turning slowly, wearing the
 * paint they collected.
 *
 * Drawn as an overlay scene on top of the finished frame — see
 * `RenderSystem.setOverlay`. The scrim that dims the park lives *in this scene*
 * rather than being a DOM element, because the park, the scrim and the figures
 * are three layers on one canvas and DOM cannot be inserted into the middle of
 * that stack. The score panel is DOM, and sits above all of it.
 *
 * The figures are the real ones, reparented out of the world: paint, team colour
 * and pose come with them for nothing, and `CharacterPaint` is uniform data on a
 * material that travels with the mesh. Cloning would mean rebuilding a rig
 * material per character and keeping two of everything in step.
 */
export class ResultsStage {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 16 / 9, 0.1, 100);

  /** One material for every plinth — they are identical, and this owns it. */
  private readonly plinthMaterial = createCelMaterial({
    color: palette.stoneLit,
    rimStrength: 0.2,
  });
  private readonly plinths: Mesh[] = [];
  private readonly shown: Character[] = [];
  /** Where each figure came from, so it can be put back exactly. */
  private readonly homes = new Map<Character, { parent: Scene; position: Vector3; yaw: number }>();
  private spin = 0;
  private panelShare = DEFAULT_PANEL_SHARE;

  constructor() {
    // Warm key against a cool fill, the same pair the park uses, so the paint
    // reads in the colours it read in during the round.
    this.scene.add(new HemisphereLight(0x9dc2e4, 0xc9ad84, 1.28));
    const sun = new DirectionalLight(palette.sunWarm, 2.4);
    sun.position.set(4, 7, 6);
    this.scene.add(sun);

    // The scrim parents itself to the camera, so the camera has to be in the
    // scene for it to be drawn at all.
    this.buildScrim();
    this.scene.add(this.camera);

    // Both layers: the character hull lives on NO_OUTLINE_LAYER, and it is the
    // hull — not the screen-space pass, which does not run out here — that gives
    // these figures their ink.
    this.camera.layers.enable(NO_OUTLINE_LAYER);
  }

  get isShowing(): boolean {
    return this.shown.length > 0;
  }

  /**
   * How much of the bottom of the frame the score card is covering.
   *
   * Measured from the live card rather than assumed, because the card's height
   * is not a constant: it grew by two thirds when the mural moved into it, it
   * differs again on a phone, and it reflows with the viewport. A number pinned
   * here is a number that silently stops matching the thing it describes.
   */
  setPanelShare(share: number): void {
    // Bounded, or a mis-measurement (a card mid-transition, a zero-height
    // container) aims the camera at the sky.
    //
    // The ceiling is deliberately below what a landscape phone asks for. There
    // the card covers ~85% of a 390px screen, and honouring that aims low
    // enough to push the figures' heads off the top of the frame — a strip of
    // torsos. Capped, the strip shows heads and shoulders instead, which is the
    // half of a character worth seeing when only a sliver fits.
    this.panelShare = Math.min(Math.max(share, 0), 0.72);
  }

  /** Takes the characters out of the world and stands them on the stage. */
  present(characters: Character[]): void {
    this.dismiss();
    this.spin = 0;

    const middle = (characters.length - 1) / 2;
    characters.forEach((character, index) => {
      const root = character.rig.root;
      this.homes.set(character, {
        parent: root.parent as Scene,
        position: root.position.clone(),
        yaw: root.rotation.y,
      });

      const x = (index - middle) * SPACING;
      // A shallow arc, so the ends are not hidden behind their neighbours.
      const z = -Math.abs(index - middle) * ARC_DEPTH;
      root.position.set(x, 0, z);
      // Facing the camera, which sits at +Z — and these characters face -Z, so
      // that is half a turn, not zero. At zero the whole line-up presents its
      // back, which is a convincing impression of a rig that has lost its paint.
      root.rotation.y = Math.PI;
      this.scene.add(root);

      // The camera may have been pulled in tight on the player when the whistle
      // went, which fades their avatar out — on the stage everybody is solid.
      character.setOpacity(1);

      this.plinths.push(this.addPlinth(x, z));
      this.shown.push(character);
    });
  }

  /** Puts everybody back where they were standing. */
  dismiss(): void {
    for (const character of this.shown) {
      const home = this.homes.get(character);
      if (!home) continue;
      const root = character.rig.root;
      home.parent.add(root);
      root.position.copy(home.position);
      root.rotation.y = home.yaw;
    }
    this.shown.length = 0;
    this.homes.clear();

    for (const plinth of this.plinths) {
      plinth.removeFromParent();
      plinth.geometry.dispose();
    }
    this.plinths.length = 0;
  }

  /** Turns the figures and keeps the framing right for the current aspect. */
  update(dt: number): void {
    if (!this.isShowing) return;

    this.spin += dt * SPIN_RATE;
    this.shown.forEach((character, index) => {
      // Turning away from front-on in alternating directions, so the row does
      // not read as one rigid carousel — and so a splat on any side comes round.
      character.rig.root.rotation.y = Math.PI + (index % 2 === 0 ? this.spin : -this.spin);
    });

    this.frame();
  }

  /**
   * Pulls the camera back far enough to fit the line-up, and aims it high.
   *
   * Recomputed per frame rather than on resize, because it costs two tangents
   * and it means the stage cannot be caught mid-resize with a row hanging off
   * the side of the screen.
   */
  private frame(): void {
    const halfFovY = (FOV * Math.PI) / 360;
    const needed = (this.shown.length - 1) * SPACING + 2.2;
    const halfWidth = needed / 2;
    // Distance at which `needed` metres fit across, with a margin.
    const distance = Math.max(6.5, (halfWidth / (Math.tan(halfFovY) * this.camera.aspect)) * 1.06);

    // Aim below the figures' centre so they sit above the score panel.
    const visibleHeight = 2 * Math.tan(halfFovY) * distance;
    const lookY = 1.05 - visibleHeight * (this.panelShare / 2);

    this.camera.position.set(0, 1.9, distance);
    this.camera.lookAt(0, lookY, 0);
  }

  /** A stone disc under each figure, so nobody is standing on the void. */
  private addPlinth(x: number, z: number): Mesh {
    const plinth = new Mesh(new CylinderGeometry(0.58, 0.64, 0.16, 20), this.plinthMaterial);
    plinth.position.set(x, -0.08, z);
    this.scene.add(plinth);
    return plinth;
  }

  /**
   * The dimming layer: a plane hung behind the line-up, parented to the camera.
   *
   * It has to be real geometry with the depth test *on*, and that is the whole
   * trick. A full-screen quad with `depthTest: false` is the obvious approach and
   * it is wrong here: three renders opaque meshes before transparent ones
   * whatever their `renderOrder`, so a transparent scrim always lands on top of
   * the figures and dims them along with the park. Behind them and depth-tested,
   * it fails the test exactly where a character stands and passes everywhere
   * else — dimming the park, and nothing else.
   *
   * Parented to the camera so it follows the framing without recomputation, and
   * far enough back, at a generous size, to cover the frustum at any aspect. The
   * camera is added to the scene because three only walks the scene graph, and a
   * camera that is not in it has no children as far as the renderer is
   * concerned.
   */
  private buildScrim(): Mesh {
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        void main() {
          gl_FragColor = vec4( uColor, uOpacity );
        }`,
      uniforms: {
        uColor: { value: [0.106, 0.09, 0.153] },
        uOpacity: { value: 0.72 },
      },
    });
    const scrim = new Mesh(new PlaneGeometry(200, 120), material);
    scrim.position.z = -60;
    scrim.frustumCulled = false;
    scrim.layers.enable(NO_OUTLINE_LAYER);
    this.camera.add(scrim);
    return scrim;
  }

  dispose(): void {
    this.dismiss();
    // After dismiss(), the only meshes left in the scene are the stage's own —
    // the characters have gone back to the park with their materials.
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      if (!Array.isArray(object.material)) object.material.dispose();
    });
    this.plinthMaterial.dispose();
  }
}
