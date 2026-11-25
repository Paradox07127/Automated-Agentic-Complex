// The fake bridge's imported motions: per-character imports, the shared MMD library (`mmd.*`), their `avatar.actions()` rows
// the library's bake after a switch, and the progress of a running import.
import { CHARACTERS } from '../../mock/fixtures';
import type { AvatarAction, AgenticComplexBridge, ImportedMotion, ImportStage, ImportState, MmdEntry, MmdScan, MmdSyncState } from '../protocol';

const ROOT = '/tmp/agentic-complex-mmd-scan/scan';

/** A two-dancer project as motion_tool mmd-scan sorts it: two bodies placed 19 frames before the song, a camera, the music. */
const sampleScan = (): MmdScan => ({
  title: 'サンプルダンス',
  root: ROOT,
  bodies: [
    { path: `${ROOT}/サンプルダンス_SampleDancerA_v1.1[f-19].vmd`, name: 'サンプルダンス_SampleDancerA_v1.1[f-19].vmd', label: 'SampleDancerA',
      model: 'サンプルモデルA ver1.20', durationS: 223.33, placeFrame: -19, hasMorph: true },
    { path: `${ROOT}/サンプルダンス_SampleDancerB_v1.1[f-19].vmd`, name: 'サンプルダンス_SampleDancerB_v1.1[f-19].vmd', label: 'SampleDancerB',
      model: 'サンプルモデルB ver1.10', durationS: 220.4, placeFrame: -19, hasMorph: true },
  ],
  faces: [],
  cameras: [{ path: `${ROOT}/camera_v1.0.vmd`, name: 'camera_v1.0.vmd', durationS: 223, placeFrame: null }],
  audio: [{ path: `${ROOT}/サンプルダンス_inst.wav`, name: 'サンプルダンス_inst.wav' }],
  ignored: [
    { name: 'Readme.txt', reason: 'not_motion' },
    { name: 'pose_start.vmd', reason: 'no_keys' },
  ],
  suggested: { body: 0, face: null, camera: 0, audio: 0, bgmStartS: -0.633 },
});

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
  // The one scan the shell keeps, and the ids handed out so far.
  let scans = 0;
  let pending: { token: string; scan: MmdScan } | null = null;
  let made = 0;
  /** A dance baked for her and pending for the others; `ImportedMotion` of it. */
  const add = (e: Omit<MmdEntry, 'id' | 'createdAt' | 'characters'>) => {
    const id = `mmd_dance_${++made}`;
    mmd.push({
      ...e, id, createdAt: new Date().toISOString(),
      characters: CHARACTERS.map((c) => ({ id: c.id, state: c.id === character() ? 'baked' : 'pending', reason: null })),
    });
    return { id, title: e.title, durationS: e.durationS, hasBgm: e.hasBgm, format: 'vmd', warnings: [] };
  };
  const ops: AgenticComplexBridge['mmd'] = {
    list: async () => ({ ok: true, entries: mmd.map((e) => ({ ...e, characters: e.characters.map((c) => ({ ...c })) })) }),
    // As if the user picked a two-dancer project folder.
    scan: async () => {
      pending = { token: `scan_${++scans}`, scan: sampleScan() };
      return { ok: true, token: pending.token, scan: sampleScan() };
    },
    // Short: bridge-returns runs every avatar fixture within one 5 s test.
    importScan: async (plan) => {
      const taken = pending;
      if (taken === null || taken.token !== plan.token) return { ok: false, reason: 'scan_gone', detail: '识别结果已失效，请重新导入', actions: [] };
      pending = null;
      const actions: ImportedMotion[] = [];
      for (const item of plan.items) {
        const body = taken.scan.bodies[item.body]!;
        actions.push(await progressed('mmd', item.title, 300 / plan.items.length, () => add({
          title: item.title, durationS: body.durationS, hasBgm: plan.audio !== null, hasCamera: plan.camera !== null,
          hasFace: plan.face !== null || body.hasMorph, project: plan.project, role: body.label,
        })));
      }
      return { ok: true, actions };
    },
    dropScan: async (token) => {
      if (pending?.token === token) pending = null;
    },
    // As if the user picked song.wav outside the project.
    pickScanAudio: async (token) => {
      if (pending === null || pending.token !== token) return { ok: false, reason: 'scan_gone', detail: '识别结果已失效，请重新导入' };
      const path = '/elsewhere/song.wav';
      let audio = pending.scan.audio.findIndex((a) => a.path === path);
      if (audio < 0) audio = pending.scan.audio.push({ path, name: 'song.wav' }) - 1;
      return { ok: true, scan: { ...pending.scan, audio: [...pending.scan.audio] }, audio };
    },
    // `pick` as if the user picked off vocal.wav.
    setMedia: async (id, media) => {
      const e = mmd.find((m) => m.id === id);
      if (e === undefined) return { ok: false, reason: 'unknown_action', detail: id };
      return progressed('mmd', media.bgm === 'pick' ? 'off vocal' : '', 200, () => {
        e.hasBgm = media.bgm === 'pick';
        return { ok: true as const, action: { id, title: e.title, durationS: e.durationS, hasBgm: e.hasBgm, format: 'vmd', warnings: [] } };
      });
    },
    // A cut every 8 s, a mouth open on every other second, music swelling to the middle.
    detail: async (id) => {
      const e = mmd.find((m) => m.id === id);
      if (e === undefined) return { ok: false, reason: 'unknown_action', detail: id };
      if (!e.characters.some((c) => c.state === 'baked')) return { ok: false, reason: 'not_baked', detail: id };
      const bins = 600;
      const at = (i: number) => ((i + 0.5) / bins) * e.durationS;
      return {
        ok: true,
        detail: {
          id, source: `${e.title}.vmd`,
          face: e.hasFace ? { mapped: ['あ', 'い', 'まばたき'], unmapped: ['てへぺろ'], blinkFromDance: true } : null,
          camera: e.hasCamera ? { cuts: Array.from({ length: Math.floor(e.durationS / 8) }, (_, k) => (k + 1) * 8), fovDeg: [12, 40] } : null,
          bgm: e.hasBgm ? { name: 'song.wav', offsetS: 0 } : null,
          lanes: {
            bins,
            mouth: e.hasFace ? Array.from({ length: bins }, (_, i) => (Math.floor(at(i)) % 2 === 0 ? 0.8 : 0)) : null,
            loudness: e.hasBgm ? Array.from({ length: bins }, (_, i) => 1 - Math.abs(i / bins - 0.5)) : null,
          },
        },
      };
    },
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
        media: { bgm: e.hasBgm, face: e.hasFace, camera: e.hasCamera },
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
