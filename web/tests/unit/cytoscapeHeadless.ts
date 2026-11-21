// jsdom has no canvas: tests that mount 动作 → 图 run Cytoscape headless, which still lays out and fires pan, zoom and position.
// Use as `vi.mock('cytoscape', () => import('./cytoscapeHeadless'))`.
import type { CytoscapeOptions } from 'cytoscape';
import { vi } from 'vitest';

const real = (await vi.importActual<{ default: typeof import('cytoscape') }>('cytoscape')).default;

export default Object.assign((o: CytoscapeOptions) => real({ ...o, headless: true, styleEnabled: true }), real);
