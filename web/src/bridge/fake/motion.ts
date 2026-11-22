// The fake bridge's motion settings: one override set per character, as native keeps them in config.json `motion_overrides`.
import { MOTION_GRAPH } from '../../mock/motionGraph';
import type { BridgeError, ChainCheck, ChainProposal, MotionAvatarOps, MotionChainOps, MotionOverrides, PreviewSequence, PreviewView } from '../protocol';
import { fakeModSettings } from './modSettings';

const copy = (o: MotionOverrides): MotionOverrides => JSON.parse(JSON.stringify(o)) as MotionOverrides;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** `avatar.preview.sequence`, checked as native checks it; a browser has no live preview, so false. */
export async function fakePreviewSequence(s: PreviewSequence): Promise<boolean> {
  const clips = Array.isArray(s?.clips) ? s.clips : [];
  const ok =
    clips.length >= 1 && clips.length <= 32 && clips.every((c) => typeof c === 'string' && bytes(c) >= 1 && bytes(c) <= 128) &&
    Array.isArray(s.blend_s) && s.blend_s.length === clips.length - 1 && s.blend_s.every((b) => typeof b === 'number' && b >= 0 && b <= 2);
  if (!ok) return Promise.reject({ code: 'invalid_args', detail: '{clips: 1–32 of 1–128 bytes, blend_s: one fewer of 0–2}' } satisfies BridgeError);
  return false;
}

let viewed: Required<PreviewView> | null = null;

/** The last `avatar.preview.view` the newest fake bridge took, with its defaults and clamps as native applies them; null before one. */
export const lastFakeView = () => viewed;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);

/** `avatar.preview.view`, checked as native checks it; each new fake bridge starts with no view. */
export function fakePreviewView(): (v: PreviewView) => Promise<void> {
  viewed = null;
  return async (v) => {
    const frame = v?.frame ?? [0, 0, 1, 1];
    const ok = finite(v?.turn) && finite(v?.zoom) && (v.tilt === undefined || finite(v.tilt)) && (v.pan === undefined || numbers(v.pan, 2))
      && numbers(frame, 4) && frame[0] >= 0 && frame[1] >= 0 && frame[2] > 0 && frame[3] > 0 && frame[0] + frame[2] <= 1 && frame[1] + frame[3] <= 1;
    if (!ok) return Promise.reject({ code: 'invalid_args', detail: '{turn, tilt?, zoom, pan?: [x, y], frame?: [x, y, w, h] in 0–1}: finite numbers' } satisfies BridgeError);
    viewed = { turn: v.turn, tilt: Math.min(80, Math.max(-80, v.tilt ?? 0)), zoom: Math.min(2, Math.max(0.1, v.zoom)), pan: v.pan ?? [0, 0], frame };
  };
}

/**
 * `avatar.motionChain`: check finds only clips the mock graph lacks and a replace or insert past its chain's end (lengths as the
 * mock graph has them, not as earlier edits leave them); apply always rebuilds.
 */
export const fakeMotionChain = (): MotionChainOps => ({
  check: async (p: ChainProposal): Promise<ChainCheck> => {
    const clips = new Set(MOTION_GRAPH.clips.map((c) => c.name));
    const chains: Record<string, unknown[]> = MOTION_GRAPH.chains;
    const problems = p.edits.flatMap((e, edit) => {
      if (!clips.has(e.clip)) return [{ edit, reason: `unknown_clip:${e.clip}` }];
      if (e.op !== 'replace' && e.op !== 'insert') return [];
      const n = chains[e.chain]?.length ?? 0;
      return e.index > (e.op === 'insert' ? n : n - 1) ? [{ edit, reason: 'bad_index' }] : [];
    });
    const changed = problems.length === 0 ? [...new Set(p.edits.flatMap((e) => ('chain' in e ? [e.chain] : [])))].sort() : [];
    return { ok: problems.length === 0, problems, graph_changes: { chains_added: [], chains_removed: [], chains_changed: changed } };
  },
  apply: async (p) => ({ ok: true, character: p.character, version: '1.2.43' }),
});

/** Takes every entry; `character` is the current character. Notes are stored, not counted, and dropped when empty. */
export function fakeMotion(character: () => string): Omit<MotionAvatarOps, 'preview'> {
  const stored: Record<string, MotionOverrides> = {};
  return {
    motionOverrides: {
      get: async () => copy(stored[character()] ?? { chains: {}, pools: {}, blend_in: {} }),
      set: async (o) => {
        const { notes, ...sent } = copy(o);
        stored[character()] = notes && Object.keys(notes).length > 0 ? { ...sent, notes } : sent;
        const applied = { chains: Object.keys(o.chains).length, pools: Object.keys(o.pools).length, blend_in: Object.keys(o.blend_in).length };
        return { applied, adjusted: [] };
      },
    },
    playChain: async () => {},
    motionChain: fakeMotionChain(),
    modSettings: fakeModSettings(),
  };
}
export { motionGroupRoutes } from './motionGroups';
