import './style.css';
import { Vector3 } from 'three';
import { Game } from './core/Game';
import { CameraRig } from './gameplay/CameraRig';
import { PlayerAvatarSystem } from './gameplay/PlayerAvatar';
import { PlayerController } from './gameplay/PlayerController';
import { createPlayerState } from './gameplay/PlayerState';
import { TestCourseSystem } from './world/TestCourse';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('main: #app container missing');

const loader = document.querySelector<HTMLDivElement>('#loader');
const loaderBar = document.querySelector<HTMLDivElement>('#loader-bar');
const loaderLabel = document.querySelector<HTMLDivElement>('#loader-label');

const game = new Game(container);
const playerState = createPlayerState(new Vector3(0, 2, 6));
const player = new PlayerController(playerState);

// Registration order is execution order, and it matters:
//   player writes renderPosition -> camera reads it and writes avatarOpacity
//   -> avatar reads both.
game
  .add(new TestCourseSystem())
  .add(player)
  .add(new CameraRig(playerState))
  .add(new PlayerAvatarSystem(playerState));

// Test hook. The headless movement tests and the phase 9 visual critic drive
// the game through this rather than through simulated input alone.
declare global {
  interface Window {
    __paintball?: {
      game: Game;
      state: typeof playerState;
      player: PlayerController;
      camera: () => { x: number; y: number; z: number };
    };
  }
}
window.__paintball = {
  game,
  state: playerState,
  player,
  camera: () => game.render.camera.position.clone(),
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
