import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

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
   * GitHub Pages serves this repo as a project site, at
   * `doublependu.github.io/dp-paintball/` rather than at a domain root, so every
   * built URL needs the repo name in front of it.
   *
   * This is set unconditionally rather than only for the Pages build so dev and
   * preview exercise the same paths production does — a base-relative bug that
   * only appears once deployed is the whole reason this setting is easy to get
   * wrong. Anything reading `import.meta.env.BASE_URL` therefore stays correct
   * everywhere, and the `tools/*.mjs` harnesses still work against the preview
   * server's root, which serves this same base-prefixed `index.html`.
   */
  base: '/dp-paintball/',
  plugins: [wasm()],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
