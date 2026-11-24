import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';

describe('fake motion library: character.listImportedMotions, renameMotion, removeMotion', () => {
  it('lists an import, renames it and removes it', async () => {
    const { avatar, character } = createFakeBridge({ surface: 'main', still: true });
    const imported = await character.importMotion();
    if (!imported.ok) throw new Error(imported.reason);
    const id = imported.action.id;

    expect(await character.listImportedMotions('si')).toEqual({
      ok: true,
      motions: [{ id, clip: `imported_${id}`, title: '示例舞蹈', format: 'vmd', durationS: 12.5, hasBgm: true, createdAt: null, warnings: [] }],
    });
    expect(await character.renameMotion('si', id, '慢舞')).toEqual({ ok: true, id, title: '慢舞' });
    const renamed = await character.listImportedMotions('si');
    expect(renamed.ok && renamed.motions.map((m) => m.title)).toEqual(['慢舞']);
    expect((await avatar.actions()).find((a) => a.id === id)?.label).toBe('慢舞');
    expect(await character.removeMotion('si', id)).toEqual({ ok: true, id });
    expect(await character.listImportedMotions('si')).toEqual({ ok: true, motions: [] });
    expect((await avatar.actions()).some((a) => a.id === id)).toBe(false);
  });

  it('refuses an id it never imported', async () => {
    const { character } = createFakeBridge({ surface: 'main', still: true });
    expect(await character.removeMotion('si', 'vmd_missing')).toEqual({ ok: false, reason: 'unknown_action' });
    expect(await character.renameMotion('si', 'vmd_missing', 'x')).toEqual({ ok: false, reason: 'unknown_action' });
  });

  it('refuses a call meant for a character no longer current', async () => {
    const { character } = createFakeBridge({ surface: 'main', still: true });
    const changed = { ok: false, reason: 'character_changed', detail: '角色刚换过，这次没有改' };
    expect(await character.removeMotion('voice_a', 'vmd_missing')).toEqual(changed);
    expect(await character.renameMotion('voice_a', 'vmd_missing', 'x')).toEqual(changed);
    expect(await character.listImportedMotions('voice_a')).toEqual(changed);
  });
});
