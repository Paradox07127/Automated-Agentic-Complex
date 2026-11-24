// The fake bridge's imported appearance: the `returns/avatar.json` sample `character.importOutfit` adds, per character.
import type { CharacterAppearance, AvatarState, BridgeError, AgenticComplexBridge } from '../protocol';
import { characterChanged } from './motion';

const OUTFIT: CharacterAppearance = { id: 'mod_1a2b3c4d', name: '示例外观', desc: '导入的外观', kind: 'imported' };
/** `demo=outfitwarn`: the import left two textures and a shader of the mod out. */
const WARNINGS = ['texture_unbound:Textures/Body-Emission.dds', 'needs_mips:Textures/Body-Diffuse.dds', 'custom_shader_ignored:ResourceGlow'];
/** Any other import: one switch of the mod could not be made switchable. */
const WARNING = ['setting_fixed:glow'];

/** `character.importOutfit` and `removeOutfit` on the `current()` character; `looks(id)` is what it added to that character's appearances,
 *  with the warnings that import returned. */
export function fakeOutfit(current: () => string, avatar: AvatarState, demo: () => string | null) {
  /** Character → the warnings of her import. */
  const owners = new Map<string, string[]>();
  const ops: Pick<AgenticComplexBridge['character'], 'importOutfit' | 'removeOutfit'> = {
    importOutfit: async () => {
      const warnings = demo() === 'outfitwarn' ? WARNINGS : WARNING;
      owners.set(current(), warnings);
      return { ok: true, appearance: { id: OUTFIT.id, name: OUTFIT.name }, warnings: [...warnings] };
    },
    removeOutfit: async (c, id) => {
      if (c !== current()) throw characterChanged(c);
      if (id !== OUTFIT.id || !owners.has(current())) {
        throw { code: 'not_imported', detail: `${current()} has no imported appearance ${id}` } satisfies BridgeError;
      }
      owners.delete(current());
      if (avatar.appearanceId === id) avatar.appearanceId = 'default';
      return { ok: true, appearance: { id } };
    },
  };
  const looks = (id: string): CharacterAppearance[] => {
    const warnings = owners.get(id);
    return warnings ? [{ ...OUTFIT, warnings: [...warnings] }] : [];
  };
  return { ops, looks };
}
