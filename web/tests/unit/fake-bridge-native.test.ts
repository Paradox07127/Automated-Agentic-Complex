import { afterEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge';
import { MOTIONS } from '../../src/mock/character';
import { DEMO_SCHEMA } from '../../src/mock/settings';
import { loadNative } from '../../src/pages/settings/native';

afterEach(() => {
  window.location.hash = '';
});

describe('fake bridge: native ops of pass 1', () => {
  it('serves the demo settings schema and saved values itself', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    expect((await bridge.settings.schema()).map((r) => r.id)).toEqual(DEMO_SCHEMA.map((r) => r.id));
    expect((await bridge.settings.read()).saved).toMatchObject({ web: true, wintext: true, mute: false });
    await bridge.settings.save({ web: false });
    expect((await bridge.settings.read()).saved.web).toBe(false);
  });

  it('reads demo=configerr and demo=pending from the hash', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    window.location.hash = '#/settings?demo=pending';
    expect((await bridge.settings.read()).saved.web).toBe(false);
    window.location.hash = '#/settings?demo=configerr';
    await expect(bridge.settings.schema()).rejects.toMatchObject({ code: 'config_unreadable' });
  });

  it('answers look, quick input, deletion preview and supervisor backoff', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    expect(await bridge.app.look()).toEqual({ requestId: 'fake-look' });
    await expect(bridge.app.openQuickInput()).resolves.toBeUndefined();
    const preview = await bridge.settings.previewDestructive('web');
    expect(preview.total).toBe(Object.values(preview.counts).reduce((a, b) => a + b, 0));
    expect((await bridge.supervisor.state()).agentd.backoff).toBeNull();
  });
});

describe('fake bridge: avatar of pass 2', () => {
  it('lists the motions with section, missing and requiredReason, and hands out copies', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const actions = await bridge.avatar.actions();
    expect(actions).toEqual(MOTIONS);
    expect(actions.find((a) => a.id === 'talk')).toMatchObject({ section: 'talk', requiredReason: '说话时必须有口型动作' });
    expect(actions.find((a) => a.id === 'think')?.missing).toBe(true);
    actions[0]!.enabled = false;
    expect((await bridge.avatar.actions())[0]!.enabled).toBe(true);
  });
});

describe('settings/native.ts loadNative', () => {
  it('takes the schema the bridge serves, without a demo stand-in', async () => {
    const real = createFakeBridge({ surface: 'main', still: true });
    const empty: AgenticComplexBridge = { ...real, settings: { ...real.settings, schema: async () => [] } };
    const native = await loadNative(empty, null);
    expect(native.rows).toEqual({});
    const served = await loadNative(real, null);
    expect(Object.keys(served.rows)).toHaveLength(DEMO_SCHEMA.length);
    expect(served.saved.web).toBe(true);
  });
});
