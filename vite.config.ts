import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';

/**
 * The commit this build is made from: the one the Pages workflow checked out,
 * then the local checkout's HEAD, then `dev` where there is no git at all. A
 * local build from a dirty tree is still named after HEAD — only a deployed
 * build is guaranteed to be exactly its commit.
 */
function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

const COMMIT = buildCommit();

/**
 * The version label in the corner, written into `index.html` rather than
 * created by `main.ts`, so it paints with the loading card and is still there
 * when the module fails to load — which is when a bug report needs it most.
 */
const buildTag: Plugin = {
  name: 'build-tag',
  transformIndexHtml: (html) => html.replace('__BUILD_TAG__', `v.${COMMIT.slice(0, 4)}`),
};

/**
 * The wasm plugin exists for Rapier.
 *
 * `@dimforge/rapier3d-compat` inlines its WebAssembly as base64 inside a JS
 * module, which cost 842 KB gzipped — base64 wastes a third of its bytes and
 * compresses poorly on top of that. The non-compat package ships the real
 * `.wasm`, which gzips to ~570 KB and goes through the browser's streaming
 * compiler instead of being decoded from a string at runtime.
 *
 * No top-level-await plugin: that package requires rollup, and Vite 8 bundles
 * with rolldown. It is also unnecessary — an `esnext` target supports top-level
 * await natively, which is the only reason the plugin existed.
 */
export default defineConfig({
  /**
   * No `base` is set: GitHub Pages serves this from the custom domain
   * `v0.maize.live`, so the app sits at the domain root and Vite's default `/`
   * is correct. It used to be a project site under `/dp-paintball/`, which is
   * why anything URL-building still goes through `import.meta.env.BASE_URL` —
   * that keeps working whichever way this setting goes.
   */
  plugins: [wasm(), buildTag],
  // The commit, as the game's version for p3p2: players on different builds are kept in
  // different rooms, as their pages would not understand each other's messages. Twelve
  // characters where the label shows four, which could match between two deploys; not the
  // whole hash, which is 40, because p3p2 takes at most 32.
  define: { __BUILD__: JSON.stringify(COMMIT.slice(0, 12)) },
  // The p3p2 client is served as the files it is made of, on the dev server too: its
  // small entry on every visit, and the rest only when a room is opened.
  optimizeDeps: { exclude: ['@p3p2/client'] },
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
