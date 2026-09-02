import './style.css';
import { Vector3 } from 'three';
import { MURAL_DESIGNS, dotsFor, letterDesign } from './ai/MuralDesigns';
import { CharacterRegistry } from './character/CharacterRegistry';
import { CharactersSystem, type BotSpec } from './character/CharactersSystem';
import { AudioSystem } from './audio/AudioSystem';
import { Game } from './core/Game';
import { AimSolver } from './gameplay/Aim';
import { SceneCrosshairSystem } from './gameplay/SceneCrosshair';
import { BallisticsSystem } from './gameplay/Ballistics';
import { CameraRig } from './gameplay/CameraRig';
import { PlayerController } from './gameplay/PlayerController';
import { createPlayerState } from './gameplay/PlayerState';
import { LootSystem, createLootState, type LootState } from './gameplay/LootSystem';
import { createMatchState, type MatchState } from './gameplay/MatchState';
import { MatchSystem } from './gameplay/MatchSystem';
import { WeaponSystem } from './gameplay/Weapon';
import { PaintSystem } from './paint/PaintSystem';
import { SplatAtlas } from './paint/SplatAtlas';
import { SurfaceRegistry } from './paint/SurfaceRegistry';
import { HudSystem } from './ui/HudSystem';
import { PauseSystem } from './ui/PauseSystem';
import { PosterCapture } from './ui/PosterCapture';
import { ResultsSystem } from './ui/ResultsSystem';
import { TouchControlsSystem } from './ui/TouchControls';
import { PaintScreen } from './world/PaintScreen';
import { ParkArenaSystem } from './world/ParkArena';
import { TestCourseSystem } from './world/TestCourse';

const container = document.querySelector<HTMLDivElement>('#app');
if (!container) throw new Error('main: #app container missing');

const loader = document.querySelector<HTMLDivElement>('#loader');
const loaderBar = document.querySelector<HTMLDivElement>('#loader-bar');
const loaderLabel = document.querySelector<HTMLDivElement>('#loader-label');

/**
 * The park is the game; the test course is a purpose-built movement gym whose
 * geometry the movement, ballistics and paint suites assert against by exact
 * coordinate. Keeping both, selected by `?scene=course`, means those suites stay
 * meaningful instead of being rewritten every time the map changes.
 */
const scene = new URLSearchParams(location.search).get('scene');
const useTestCourse = scene === 'course';

const game = new Game(container);
// Park: south edge of the plaza, clear of the fountain basin (radius 6), and
// far enough north that the trailing camera doesn't sit inside the arcade
// undercroft at z=16. Course: the old open-ground spawn.
const playerState = createPlayerState(
  useTestCourse ? new Vector3(0, 2, 6) : new Vector3(0, 1.5, 10),
);
const surfaces = new SurfaceRegistry();
// Generated once and shared: world paint, character paint and the lens splash
// all stamp the same shapes.
const splatAtlas = new SplatAtlas();
const paint = new PaintSystem(surfaces, splatAtlas);
// Built here rather than inside the arena because two unrelated things need the
// same object: the park hangs it on the plaza, and the results card puts a
// picture of it on screen. It stamps the same splat shapes as everything else.
const paintScreen = new PaintScreen(splatAtlas);
const characterRegistry = new CharacterRegistry();
// Ballistics consults the registry at impact, so it must exist first.
const ballistics = new BallisticsSystem(characterRegistry);

// The opposition. Spawns are snapped to walkable ground at init, so these are
// hints rather than exact positions. One of each personality, spread across the
// park's distinct areas.
// None on the test course: it is a controlled fixture that the movement,
// ballistics and paint suites assert against by exact coordinate, and a bot
// firing into it makes every one of those measurements non-deterministic.
const bots: BotSpec[] = useTestCourse
  ? []
  : [
      { id: 'bot-a', position: new Vector3(-16, 0, 4), colorIndex: 1, personality: 0 },
      // Moved off (16, 6) in iteration 5, when the paint screen stood on the
      // plaza's east rim and that spawn was two metres behind it. The board has
      // since gone to the meadow; this spawn stays because it spreads the
      // opening better than the one it replaced.
      { id: 'bot-b', position: new Vector3(19, 0, 13), colorIndex: 2, personality: 1 },
      { id: 'bot-c', position: new Vector3(4, 0, 42), colorIndex: 3, personality: 2 },
      // Respread when the map grew: this one used to sit in the Ramble, which
      // the enlarged Lake now covers.
      { id: 'bot-d', position: new Vector3(-26, 0, -72), colorIndex: 5, personality: 3 },
      { id: 'bot-e', position: new Vector3(44, 0, -10), colorIndex: 6, personality: 2 },
      { id: 'bot-f', position: new Vector3(-34, 0, 40), colorIndex: 7, personality: 1 },
    ];
// Paint is finite. One map for everybody, passed to whoever needs to answer
// "can I fire?" synchronously — see MatchState's header.
const match = createMatchState(
  ['player', ...bots.map((bot) => bot.id)],
  // The test course is a sandbox: unlimited paint and no crate, so the
  // movement, ballistics and paint suites keep measuring geometry rather than
  // how much paint was left when they got there.
  { sandbox: useTestCourse },
);
const loot = createLootState();
// A different hiding place every game, so this cannot come from WORLD_SEED.
// `?seed=` pins it, which is what makes a crate reproducible when something
// about one needs reproducing.
const seedParam = new URLSearchParams(location.search).get('seed');
const lootSeed = seedParam !== null ? Number(seedParam) >>> 0 : Date.now() >>> 0;

// Built after the match, whose roster needs the bot list and whose phase the
// controller reads — a player does not drive once the round is over.
const player = new PlayerController(playerState, match);
const charactersSystem = new CharactersSystem(
  playerState,
  characterRegistry,
  ballistics,
  splatAtlas,
  match,
  loot,
  useTestCourse ? null : paintScreen,
  bots,
  // Only used to put the player back at their spawn when a round restarts.
  player,
);
const lootSystem = new LootSystem(match, loot, playerState, charactersSystem, lootSeed);
const matchSystem = new MatchSystem(match, charactersSystem, ballistics, loot, lootSystem);
const audio = new AudioSystem(playerState);
const hud = new HudSystem(container, charactersSystem, splatAtlas, match, loot, playerState);
// One solver shared by the gun and the scene crosshair, so the mark on the
// ground is traced from the same muzzle and direction the ball actually leaves.
const aim = new AimSolver();
// The souvenir: one frame of the park with the mural in it, taken at the
// whistle. It has to run before `ResultsSystem`, which reparents every
// character onto the results stage — a photograph taken after that is of an
// empty meadow.
const poster = new PosterCapture(game.render, useTestCourse ? null : paintScreen, match);

// Registration order is execution order, and it matters:
//   player writes renderPosition -> camera reads it and writes avatarOpacity
//   -> avatar reads both.
game
  .add(
    useTestCourse
      ? new TestCourseSystem(surfaces)
      : new ParkArenaSystem(surfaces, paintScreen),
  )
  .add(player)
  .add(new CameraRig(playerState))
  .add(ballistics)
  .add(new WeaponSystem(playerState, ballistics, aim, match))
  // After the camera, which it aims from; before paint, which does not care.
  .add(new SceneCrosshairSystem(playerState, ballistics, aim))
  .add(paint)
  .add(charactersSystem)
  // After characters, whose init builds the navgrid the crate is placed on.
  .add(lootSystem)
  // After loot: the round can end on the last paintball in the park, and the
  // crate's own rounds count until somebody has taken them.
  .add(matchSystem)
  // After characters: the HUD reads their scores, and audio positions sounds
  // relative to the player's interpolated transform.
  .add(audio)
  .add(hud)
  // Nothing on a desktop; on a phone, the thumbs. It feeds `Input` and draws
  // its own layer, so it only has to exist before the first frame a player
  // could touch.
  .add(new TouchControlsSystem(container, match))
  // After the HUD, whose bottom hint it replaces while the round is held.
  .add(new PauseSystem(container, charactersSystem, match))
  // Before the results, and that ordering is the whole contract. See above.
  .add(poster)
  // Last: it draws over the finished frame, and it takes the characters out of
  // the world, which everything above expects to still be there while playing.
  .add(
    new ResultsSystem(
      container,
      charactersSystem,
      match,
      game.render,
      useTestCourse ? null : paintScreen,
      useTestCourse ? null : poster,
    ),
  );

interface ImpactRecord {
  x: number;
  y: number;
  z: number;
  color: number;
  speed: number;
  colliderHandle: number;
  shooterId: string;
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
      paintScreen: PaintScreen;
      poster: PosterCapture;
      characters: CharactersSystem;
      audio: AudioSystem;
      hud: HudSystem;
      match: MatchState;
      loot: LootState;
      lootSystem: LootSystem;
      matchSystem: MatchSystem;
      camera: () => { x: number; y: number; z: number };
      simTime: () => number;
      setManualSim: (on: boolean) => void;
      stepSim: (seconds: number) => number;
      bootTimings: () => Array<{ phase: string; ms: number }>;
      impacts: ImpactRecord[];
      /** The bots' drawing catalogue, so the suite can check it directly. */
      mural: {
        designs: typeof MURAL_DESIGNS;
        dotsFor: typeof dotsFor;
        letterDesign: typeof letterDesign;
      };
    };
  }
}
const impacts: ImpactRecord[] = [];
game.events.on('shot:fired', ({ shooterId }) => {
  if (shooterId === 'player') charactersSystem.onPlayerShot();
});

game.events.on('hit:world', ({ point, color, impactSpeed, colliderHandle, shooterId }) => {
  impacts.push({
    x: point.x,
    y: point.y,
    z: point.z,
    color,
    speed: impactSpeed,
    colliderHandle,
    shooterId,
  });
  if (impacts.length > 512) impacts.shift();
});

window.__paintball = {
  game,
  state: playerState,
  player,
  ballistics,
  paint,
  paintScreen,
  poster,
  characters: charactersSystem,
  audio,
  hud,
  match,
  loot,
  lootSystem,
  matchSystem,
  camera: () => game.render.camera.position.clone(),
  simTime: () => game.simElapsed,
  setManualSim: (on) => game.setManualSim(on),
  stepSim: (seconds) => game.stepSim(seconds),
  bootTimings: () => game.bootTimings,
  impacts,
  mural: { designs: MURAL_DESIGNS, dotsFor, letterDesign },
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
