import './style.css';
import { Vector3 } from 'three';
import { Game } from './core/Game';
import { BallisticsSystem } from './gameplay/Ballistics';
import { CameraRig } from './gameplay/CameraRig';
import { PlayerAvatarSystem } from './gameplay/PlayerAvatar';
import { PlayerController } from './gameplay/PlayerController';
import { createPlayerState } from './gameplay/PlayerState';
import { WeaponSystem } from './gameplay/Weapon';
import { PaintSystem } from './paint/PaintSystem';
import { SurfaceRegistry } from './paint/SurfaceRegistry';
import { TestCourseSystem } from './world/TestCourse';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('main: #app container missing');

const loader = document.querySelector<HTMLDivElement>('#loader');
const loaderBar = document.querySelector<HTMLDivElement>('#loader-bar');
const loaderLabel = document.querySelector<HTMLDivElement>('#loader-label');

const game = new Game(container);
const playerState = createPlayerState(new Vector3(0, 2, 6));
const player = new PlayerController(playerState);
const ballistics = new BallisticsSystem();
const surfaces = new SurfaceRegistry();
const paint = new PaintSystem(surfaces);

// Registration order is execution order, and it matters:
//   player writes renderPosition -> camera reads it and writes avatarOpacity
//   -> avatar reads both.
game
  .add(new TestCourseSystem(surfaces))
  .add(player)
  .add(new CameraRig(playerState))
  .add(ballistics)
  .add(new WeaponSystem(playerState, ballistics))
  .add(paint)
  .add(new PlayerAvatarSystem(playerState));

interface ImpactRecord {
  x: number;
  y: number;
  z: number;
  color: number;
  speed: number;
  colliderHandle: number;
}

// Test hook. The headless movement tests and the phase 9 visual critic drive
// the game through this rather than through simulated input alone.
declare global {
  interface Window {
    __paintball?: {
      game: Game;
      state: typeof playerState;
      player: PlayerController;
      ballistics: BallisticsSystem;
      paint: PaintSystem;
      camera: () => { x: number; y: number; z: number };
      simTime: () => number;
      impacts: ImpactRecord[];
    };
  }
}
const impacts: ImpactRecord[] = [];
game.events.on('hit:world', ({ point, color, impactSpeed, colliderHandle }) => {
  impacts.push({
    x: point.x,
    y: point.y,
    z: point.z,
    color,
    speed: impactSpeed,
    colliderHandle,
  });
  if (impacts.length > 512) impacts.shift();
});

window.__paintball = {
  game,
  state: playerState,
  player,
  ballistics,
  paint,
  camera: () => game.render.camera.position.clone(),
  simTime: () => game.simElapsed,
  impacts,
};

game.events.on('load:progress', ({ phase, progress }) => {
  if (loaderBar) loaderBar.style.width = `${Math.round(progress * 100)}%`;
  if (loaderLabel) loaderLabel.textContent = phase;
});

game.events.once('game:ready', () => {
  loader?.classList.add('is-done');
  // Let the fade finish before pulling it out of the layer tree.
  setTimeout(() => loader?.remove(), 600);
});

void game.boot().catch((error: unknown) => {
  console.error('Boot failed', error);
  if (loaderLabel) {
    loaderLabel.textContent =
      error instanceof Error ? `Failed to start: ${error.message}` : 'Failed to start';
  }
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose());
}
