import type { ChatDemoSource } from './demoTypes';

// Filled by src/bridge/fake/demos/chat.ts; empty in the app.
export const demo: {
  /** The prototype data of the `full` and `sparse` demos. */
  sources?: Record<'full' | 'sparse', ChatDemoSource>;
} = {};
