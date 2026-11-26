// The fake bridge's mod settings (`avatar.modSettings`) and agentd's mod-settings route (C6).
import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOD_SETTINGS } from '../../src/mock/fixtures';

describe('fake mod settings', () => {
  it('starts empty, keeps each appearance\'s values and defaults a value the table lacks', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    const ms = bridge.avatar.modSettings;
    expect(await ms.get({ character: 'si' })).toEqual({ appearances: {} });
    expect(await ms.set({ character: 'si', appearance: 'imported_summer', values: { skirt: 1, color: 2 } })).toEqual({
      values: { skirt: 1, color: 2 }, adjusted: [],
    });
    expect(await ms.get({ character: 'si' })).toEqual({ appearances: { imported_summer: { skirt: 1, color: 2 } } });
    expect(await ms.set({ character: 'si', appearance: 'imported_summer', values: { skirt: 9, cape: 1 } })).toEqual({
      values: { skirt: 0, color: 0 }, adjusted: [{ id: 'skirt', reason: 'defaulted' }, { id: 'cape', reason: 'unsupported' }],
    });
    expect(await ms.get({ character: 'si' })).toEqual({ appearances: { imported_summer: { skirt: 0, color: 0 } } });
    expect(await ms.get({ character: 'voice_a' })).toEqual({ appearances: {} });
  });

  it('fails an appearance without a table and refuses bad arguments', async () => {
    const ms = createFakeBridge({ surface: 'main', still: true }).avatar.modSettings;
    await expect(ms.set({ character: 'si', appearance: 'daily', values: {} })).rejects.toMatchObject({ code: 'failed' });
    await expect(ms.set({ character: 'si', appearance: 'imported_summer', values: { skirt: 1.5 } })).rejects.toMatchObject({ code: 'invalid_args' });
    await expect(ms.set({ character: 'si', appearance: 'imported_summer', values: { skirt: 256 } })).rejects.toMatchObject({ code: 'invalid_args' });
  });

  it('is refused outside the main surface', async () => {
    const ms = createFakeBridge({ surface: 'stack', still: true }).avatar.modSettings;
    await expect(ms.get({ character: 'si' })).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('fake GET /characters/:id/mod-settings', () => {
  it('serves the table of a character with one, {} without, and 404 for an unknown character', async () => {
    const { agentd } = createFakeBridge({ surface: 'main', still: true });
    const si = await agentd.request('GET', '/characters/si/mod-settings');
    expect(si.status).toBe(200);
    expect(si.body).toMatchObject({ character: 'si', schema: 'endfield-mod-settings/v1', appearances: MOD_SETTINGS.si });
    expect((si.body as { appearances: Record<string, { settings: unknown[] }> }).appearances.imported_summer?.settings).toHaveLength(2);
    expect((await agentd.request('GET', '/characters/voice_a/mod-settings')).body).toMatchObject({ character: 'voice_a', appearances: {} });
    expect(await agentd.request('GET', '/characters/nobody/mod-settings')).toEqual({
      status: 404, body: { error: 'unknown_character' }, error: { code: 'unknown_character' },
    });
  });
});
