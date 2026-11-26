import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBridge } from '../../src/bridge/fake';
import {
  BRIDGE_OPS,
  DESKTOP_OPS,
  INTERNAL_OPS,
  STREAM_OPS,
  SURFACE_CAPABILITIES,
  SURFACE_OPS,
  SYNC_OPS,
  WATCH_OPS,
} from '../../src/bridge/surfaces.generated';

const opsFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../protocol/ui-bridge/ops.json');

/** Dotted names of every function member, e.g. `avatar.preview.show`. */
function opNames(node: object, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const name = prefix + key;
    if (typeof value === 'function') return [name];
    if (value && typeof value === 'object') return opNames(value, name + '.');
    return [];
  });
}

describe('protocol/ui-bridge/ops.json', () => {
  // `internal` ops are sent only by the native shim and are not bridge members.
  it('lists exactly the bridge members', () => {
    const file = JSON.parse(readFileSync(opsFile, 'utf8')) as { ops: string[]; internal: string[] };
    const { ops } = file;
    const onboarding = JSON.parse(readFileSync(resolve(dirname(opsFile), 'onboarding-ops.json'), 'utf8')) as { ops: string[] };
    ops.push(...onboarding.ops);
    const bridge = createFakeBridge({ surface: 'main', still: true });
    expect(new Set([...ops, ...file.internal]).size).toBe(ops.length + file.internal.length);
    expect(opNames(bridge).sort()).toEqual([...ops].sort());
  });

  it('matches the generated surfaces module', () => {
    const file = JSON.parse(readFileSync(opsFile, 'utf8')) as {
      ops: string[];
      internal: string[];
      surfaces: Record<string, string[]>;
      kinds: Record<string, string[]>;
      desktop: string[];
      capabilities: Record<string, Record<string, boolean | string>>;
    };
    const onboarding = JSON.parse(readFileSync(resolve(dirname(opsFile), 'onboarding-ops.json'), 'utf8')) as { ops: string[] };
    expect(BRIDGE_OPS).toEqual([...file.ops, ...onboarding.ops]);
    expect(INTERNAL_OPS).toEqual(file.internal);
    expect(SURFACE_OPS).toEqual(file.surfaces);
    expect({ watch: WATCH_OPS, sync: SYNC_OPS, stream: STREAM_OPS }).toEqual(file.kinds);
    expect(DESKTOP_OPS).toEqual(file.desktop);
    expect(SURFACE_CAPABILITIES).toEqual(file.capabilities);
  });
});

/** Dotted key paths of a JSON value; null, arrays and scalars are leaves. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, v]) => keyPaths(v, prefix + key + '.'));
}

describe('app.runtime', () => {
  it('the fake snapshot has the native wire shape', async () => {
    const golden: unknown = JSON.parse(readFileSync(resolve(dirname(opsFile), 'runtime/initial.json'), 'utf8'));
    const fake = await createFakeBridge({ surface: 'main', still: true }).app.runtime();
    expect(keyPaths(fake).sort()).toEqual(keyPaths(golden).sort());
  });
});
