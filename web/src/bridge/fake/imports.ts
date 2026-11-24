// The fake bridge's imported motions: per-character imports, the shared MMD library (`mmd.*`), their `avatar.actions()` rows
// the library's bake after a switch, and the progress of a running import.
import { CHARACTERS } from '../../mock/fixtures';
import type { AvatarAction, AgenticComplexBridge, ImportStage, ImportState, MmdEntry, MmdSyncState } from '../protocol';

const IDLE: MmdSyncState = { running: false, character: null, total: 0, done: 0, failed: 0, stage: null, fraction: 0 };
const IMPORT_IDLE: ImportState = { running: false, kind: null, title: null, stage: null, fraction: 0 };
/** As native: a motion call meant for a character no longer current. */
const CHANGED = { ok: false as const, reason: 'character_changed', detail: '角色刚换过，这次没有改' };
const TOOL_STAGES: Record<NonNullable<ImportState['kind']>, ImportStage[]> = {
  motion: ['read', 'sample', 'retarget', 'write', 'validate', 'publish'],
  mmd: ['read', 'sample', 'retarget', 'write', 'validate', 'publish'],
  outfit: ['read', 'compose', 'write', 'validate', 'publish'],
};

export function fakeImports(character: () => string) {
  const packaged = character();
  const imported: AvatarAction[] = [];
  const mmd: MmdEntry[] = [];
  let sync = IDLE;
  const watchers = new Set<(s: MmdSyncState) => void>();
  const push = (s: MmdSyncState) => {
    sync = s;
    watchers.forEach((cb) => cb({ ...s }));
  };
  let importing = IMPORT_IDLE;
  const importWatchers = new Set<(s: ImportState) => void>();
  const report = (s: ImportState) => {
    importing = s;
    importWatchers.forEach((cb) => cb({ ...s }));
  };
  /** As native: the tool's stages spread over `ms`, then `reload`, then idle just before `done`'s result. */
  const progressed = async <T>(kind: NonNullable<ImportState['kind']>, title: string, ms: number, done: () => T | Promise<T>): Promise<T> => {
    const stages = TOOL_STAGES[kind];
    for (const [i, stage] of [...stages, 'reload' as const].entries()) {
      report({ running: true, kind, title, stage, fraction: stage === 'reload' ? 1 : i / stages.length });
      await new Promise((r) => setTimeout(r, ms / (stages.length + 1)));
    }
    report(IMPORT_IDLE);
    return done();
  };
  const motions: Pick<AgenticComplexBridge['character'], 'importMotion' | 'listImportedMotions' | 'renameMotion' | 'removeMotion' | 'importState' | 'onImport'> = {
    // As if the user picked a .vmd and a BGM and the import took a second.
    importMotion: () => progressed('motion', '示例舞蹈', 1000, () => {
      const action = { id: `mmd_sample_${imported.length + 1}`, title: '示例舞蹈', durationS: 12.5, hasBgm: true, format: 'vmd', warnings: [] };
      imported.push({
        id: action.id, label: action.title, enabled: true, defaultEnabled: true, section: 'idle', trigger: '导入 VMD · 手动播放', durationS: action.durationS, isNew: true, missingReason: null, playable: true,
        media: { bgm: true, face: false, camera: false },
      });
      return { ok: true as const, action };
    }),
    importState: async () => ({ ...importing }),
    onImport: (cb) => {
      importWatchers.add(cb);
      return () => void importWatchers.delete(cb);
    },
    // The fake library has only the starting character's package; listing another one fails as motion_tool does.
    listImportedMotions: async (c) => {
      if (c !== character()) return CHANGED;
      if (character() !== packaged) return { ok: false, reason: 'internal', detail: `unknown_character: ${character()}` };
      const motions = imported.map((a) => ({
        id: a.id, clip: `imported_${a.id}`, title: a.label, format: 'vmd', durationS: a.durationS ?? 0, hasBgm: true, createdAt: null, warnings: [],
      }));
      return { ok: true, motions };
    },
    renameMotion: async (c, id, title) => {
      if (c !== character()) return CHANGED;
      const motion = mmd.find((e) => e.id === id) ?? imported.find((a) => a.id === id);
      if (!motion) return { ok: false, reason: 'unknown_action' };
      if ('title' in motion) motion.title = title.trim();
      else motion.label = title.trim();
      return { ok: true, id, title: title.trim() };
    },
    removeMotion: async (c, id) => {
      if (c !== character()) return CHANGED;
      const list: Array<{ id: string }> = mmd.some((e) => e.id === id) ? mmd : imported;
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return { ok: false, reason: 'unknown_action' };
      list.splice(i, 1);
      return { ok: true, id };
    },
  };
  const ops: AgenticComplexBridge['mmd'] = {
    list: async () => ({ ok: true, entries: mmd.map((e) => ({ ...e, characters: e.characters.map((c) => ({ ...c })) })) }),
    // As if the user picked a .vmd and a BGM and the import took a second.
    import: () => progressed('mmd', '示例舞蹈', 1000, () => {
      const action = { id: `mmd_dance_${mmd.length + 1}`, title: '示例舞蹈', durationS: 12.5, hasBgm: true, format: 'vmd', warnings: [] };
      mmd.push({
        id: action.id, title: action.title, durationS: action.durationS, hasBgm: true, hasCamera: false, createdAt: new Date().toISOString(),
        characters: CHARACTERS.map((c) => ({ id: c.id, state: c.id === character() ? 'baked' : 'pending', reason: null })),
      });
      return { ok: true as const, action };
    }),
    syncState: async () => ({ ...sync }),
    onSync: (cb) => {
      watchers.add(cb);
      return () => void watchers.delete(cb);
    },
  };
  return {
    motions,
    mmd: ops,
    /** For `character.importOutfit`, which lives in outfit.ts. */
    progressed,
    /** The imported rows of the current character's `avatar.actions()`: her own imports, then the library's dances baked into her. */
    actions: (): AvatarAction[] => [
      ...imported.map((a) => ({ ...a })),
      ...mmd.filter((e) => e.characters.some((c) => c.id === character() && c.state === 'baked')).map((e) => ({
        id: e.id, label: e.title, enabled: true, defaultEnabled: true, section: 'idle', trigger: '导入 VMD · 手动播放', durationS: e.durationS, isNew: true, missingReason: null, playable: true,
        media: { bgm: e.hasBgm, face: false, camera: e.hasCamera },
      })),
    ],
    /** As native, bakes the dances she lacks in the background once she is on the desktop. */
    switched: (id: string) => {
      const due = mmd.filter((e) => e.characters.some((c) => c.id === id && c.state === 'pending'));
      if (due.length === 0) return;
      setTimeout(() => push({ running: true, character: id, total: due.length, done: 0, failed: 0, stage: 'write', fraction: 0 }));
      setTimeout(() => {
        due.forEach((e) => e.characters.forEach((c) => c.id === id && (c.state = 'baked')));
        push(IDLE);
      }, 1000);
    },
  };
}
