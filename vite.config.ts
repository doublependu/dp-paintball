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
   * No `base` is set: GitHub Pages serves this from the custom domain
   * `v0.maize.live`, so the app sits at the domain root and Vite's default `/`
   * is correct. It used to be a project site under `/dp-paintball/`, which is
   * why anything URL-building still goes through `import.meta.env.BASE_URL` —
   * that keeps working whichever way this setting goes.
   */
  plugins: [wasm()],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
