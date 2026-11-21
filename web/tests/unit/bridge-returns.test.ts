import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, Surface } from '../../src/bridge/protocol';
import { BRIDGE_OPS, SURFACE_OPS } from '../../src/bridge/surfaces.generated';
import { kind, mismatches } from './shape';

interface ReturnCase {
  op: string;
  surface: Surface;
  args?: unknown[];
  before?: Array<{ op: string; args?: unknown[] }>;
  kind?: string;
  value?: unknown;
  nullable?: string[];
  free_keys?: string[];
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../protocol/ui-bridge/returns');
const FILES = ['app', 'agentd', 'settings', 'avatar', 'desktop', 'onboarding', 'void', 'computer-use', 'camera', 'region', 'resize'];
const read = (name: string): ReturnCase[] => JSON.parse(readFileSync(resolve(ROOT, `${name}.json`), 'utf8'));

function member(bridge: AgenticComplexBridge, op: string): (...args: unknown[]) => unknown {
  return op.split('.').reduce<any>((node, key) => node[key], bridge);
}

afterEach(() => { window.location.hash = ''; });

describe('fake bridge return contracts', () => {
  it.each(FILES)('%s return shapes', async (name) => {
    for (const c of read(name)) {
      const bridge = createFakeBridge({ surface: c.surface, still: true });
      for (const step of c.before ?? []) await member(bridge, step.op)(...(step.args ?? []));
      const result = await member(bridge, c.op)(...(c.args ?? []));
      if (c.kind) expect(kind(result), c.op).toBe(c.kind);
      else expect(mismatches(c.value, result, c.nullable ?? [], c.free_keys ?? []), c.op).toEqual([]);
    }
  });

  it('covers every promise-returning bridge call available to the UI', () => {
    const covered = new Set(FILES.flatMap(read).map((c) => c.op));
    const sync = JSON.parse(readFileSync(resolve(ROOT, '../ops.json'), 'utf8')) as { kinds: { sync: string[] } };
    const available = new Set(Object.values(SURFACE_OPS).flat());
    const promises = BRIDGE_OPS.filter((op) => available.has(op) && !sync.kinds.sync.includes(op) && !/\.(subscribe|on[A-Z]\w*)$/.test(op));
    expect([...covered].sort()).toEqual([...promises].sort());
  });
});
