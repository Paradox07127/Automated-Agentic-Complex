/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Demo modules: the app build may drop them when nothing uses their exports, though their top-level code calls functions.
const DEMO = /\/src\/mock\/|\.demos\.tsx?$|\/src\/pages\/[^/]+\/demos\.ts$/;

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  // tools/dev/dev_console.py: the shell serves these pages on its own scheme, whose URLs carry no port, so the HMR client
  // dials the server's address itself.
  ...(process.env.EF_DEV_HMR_PORT ? { server: { ws: { protocol: 'ws', host: '127.0.0.1', clientPort: Number(process.env.EF_DEV_HMR_PORT) } } } : {}),
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  build: {
    // The inline polyfill would be blocked by the app's CSP (no inline script).
    modulePreload: { polyfill: false },
    // The CSP allows fonts only from agentic-complex-ui:, so no asset may be inlined as data:.
    assetsInlineLimit: 0,
    rolldownOptions: {
      // The e2e build also carries the component demo mount the specs open; the shipped app does not.
      input: { main: 'main.html', stack: 'stack.html', ...(mode !== 'app' ? { catalog: 'tests/fixtures/catalog/index.html' } : {}) },
      ...(mode === 'app' ? { treeshake: { moduleSideEffects: (id: string) => !DEMO.test(id) } } : {}),
    },
  },
  test: {
    // The persistent transform cache misses files added to mock/index.ts's import.meta.glob.
    fsModuleCache: false,
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
  },
}));
