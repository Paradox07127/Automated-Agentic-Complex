// Fake bridge and demo settings parity with the shell: MMD import ids, per-character layers, the scene rows.
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEMO_SCHEMA, demoNative } from '../../src/mock/settings';
import { SettingRows } from '../../src/pages/character/SettingRows';

afterEach(cleanup);

describe('fake bridge', () => {
  it('imports a sample dance as an MMD action with its BGM', async () => {
    const { avatar, character } = createFakeBridge({ surface: 'main', still: true });
    const imported = await character.importMotion();
    if (!imported.ok) throw new Error(imported.reason);
    expect(imported.action.id.startsWith('mmd_')).toBe(true);
    const action = (await avatar.actions()).find((a) => a.id === imported.action.id);
    expect(action?.media?.bgm).toBe(true);
  });

  it('forgets the hidden layers on a character switch', async () => {
    const { avatar, character } = createFakeBridge({ surface: 'main', still: true });
    await avatar.setLayers(['coat']);
    await character.switchTo('voice_a');
    const active = (await character.list()).find((c) => c.active);
    expect(active?.layers?.filter((l) => !l.visible)).toEqual([]);
  });
});

describe('demo settings', () => {
  it('lists scn.mode and scn.parallax on the 场景 tab', async () => {
    expect(DEMO_SCHEMA.map((r) => r.id)).toEqual(expect.arrayContaining(['scn.mode', 'scn.parallax']));
    render(createElement(SettingRows, { n: await demoNative(null), tab: 'scene', dev: false, set: vi.fn(), pending: new Set<string>(), offline: false }));
    expect(screen.queryAllByText('舞台盒').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('背景视差').length).toBeGreaterThan(0);
  });
});
