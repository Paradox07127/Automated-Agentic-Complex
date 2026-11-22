import { describe, expect, it } from 'vitest';
import type { AgenticComplexBridge, Surface } from '../../src/bridge/protocol';
import { createFakeBridge } from '../../src/bridge/fake';
import { BRIDGE_OPS, SURFACE_CAPABILITIES, SURFACE_OPS, SYNC_OPS } from '../../src/bridge/surfaces.generated';

const SURFACES: Surface[] = ['main', 'stack', 'onboarding'];
const subscription = (op: string) => /\.(subscribe|on[A-Z]\w*)$/.test(op);

function member(bridge: AgenticComplexBridge, op: string): (...args: unknown[]) => unknown {
  return op.split('.').reduce<any>((node, key) => node[key], bridge);
}

const codeOf = async (run: () => unknown) => {
  try {
    await run();
    return null;
  } catch (e) {
    return (e as { code?: string } | null)?.code ?? null;
  }
};

describe('fake bridge gates ops per surface like the native shim', () => {
  it('rejects an op the surface may not send', async () => {
    const onboarding = createFakeBridge({ surface: 'onboarding', still: true });
    await expect(onboarding.character.importMotion()).rejects.toMatchObject({ code: 'not_implemented', detail: 'character.importMotion' });
    await expect(onboarding.avatar.state()).rejects.toMatchObject({ code: 'not_implemented', detail: 'avatar.state' });
    const stack = createFakeBridge({ surface: 'stack', still: true });
    await expect(stack.open.runInTerminal('true')).rejects.toMatchObject({ code: 'not_implemented', detail: 'open.runInTerminal' });
    await expect(stack.open.revealInFinder('/tmp')).resolves.toBeUndefined();
    const main = createFakeBridge({ surface: 'main', still: true });
    await expect(main.stack.decide('c1', { kind: 'cancel-question', expected_version: 1 })).rejects.toMatchObject({ code: 'not_implemented', detail: 'stack.decide' });
  });

  it('lets onboarding list characters', async () => {
    const list = await createFakeBridge({ surface: 'onboarding', still: true }).character.list();
    expect(list.some((c) => c.active)).toBe(true);
  });

  it('lets onboarding import a character package', async () => {
    expect(await codeOf(() => createFakeBridge({ surface: 'onboarding', still: true }).character.importPackage())).toBeNull();
  });

  it.each(SURFACES)('%s: a disallowed subscription or void op is a no-op', (surface) => {
    const bridge = createFakeBridge({ surface, still: true });
    const allowed = new Set(SURFACE_OPS[surface]);
    for (const op of BRIDGE_OPS.filter((o) => !allowed.has(o))) {
      const fn = member(bridge, op);
      if (subscription(op)) {
        let called = false;
        const off = fn(() => void (called = true), () => void (called = true));
        expect(typeof off, op).toBe('function');
        expect(called, op).toBe(false);
      } else if (SYNC_OPS.includes(op)) {
        expect(fn(), op).toBeUndefined();
      }
    }
  });

  it.each(SURFACES)('%s: every other disallowed op rejects with not_implemented', async (surface) => {
    const bridge = createFakeBridge({ surface, still: true });
    const allowed = new Set(SURFACE_OPS[surface]);
    for (const op of BRIDGE_OPS.filter((o) => !allowed.has(o) && !subscription(o) && !SYNC_OPS.includes(o))) {
      expect(await codeOf(() => member(bridge, op)()), op).toBe('not_implemented');
    }
  });

  it.each(SURFACES)('%s: no allowed op rejects with not_implemented', async (surface) => {
    const bridge = createFakeBridge({ surface, still: true });
    for (const op of SURFACE_OPS[surface].filter((o) => BRIDGE_OPS.includes(o) && !subscription(o) && !SYNC_OPS.includes(o))) {
      expect(await codeOf(() => member(bridge, op)()), op).not.toBe('not_implemented');
    }
  });

  it.each(SURFACES)('%s: capabilities follow the generated table', (surface) => {
    const caps = createFakeBridge({ surface, still: true }).capabilities;
    for (const [key, bit] of Object.entries(SURFACE_CAPABILITIES[surface])) {
      expect(caps[key as keyof typeof caps], key).toBe(typeof bit === 'string' ? true : bit);
    }
  });
});
