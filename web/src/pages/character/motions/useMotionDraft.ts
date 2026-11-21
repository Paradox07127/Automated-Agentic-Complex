// What the user changed since the last save, per kind, and the whole set those changes make.
import { useState } from 'react';
import type { MotionOverrides, MotionPoolEntry } from '../../../bridge';
import type { ChainRow } from './graph';

export interface MotionDraft {
  /** Chain key → the value shown. */
  chains: Record<string, boolean>;
  /** Pool key → its whole pool; null gives it back to the pack. */
  pools: Record<string, MotionPoolEntry[] | null>;
  /** Clip → seconds; null gives it back to the pack. */
  blend: Record<string, number | null>;
  /** Chain key → note; '' removes it. */
  notes: Record<string, string>;
}

const EMPTY: MotionDraft = { chains: {}, pools: {}, blend: {}, notes: {} };
const samePool = (a: MotionPoolEntry[] | undefined, b: MotionPoolEntry[] | null) =>
  (a ?? null) === b || (!!a && !!b && a.length === b.length && a.every((e, i) => e.clip === b[i]!.clip && e.weight === b[i]!.weight));

function merge<T>(stored: Record<string, T>, draft: Record<string, T | null>, keep: (v: T) => boolean = () => true): Record<string, T> {
  const out = { ...stored };
  for (const [k, v] of Object.entries(draft)) {
    if (v === null || !keep(v)) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function useMotionDraft(stored: MotionOverrides | undefined) {
  const [draft, setDraft] = useState<MotionDraft>(EMPTY);
  const notes = stored?.notes ?? {};

  /** Sets `key` of one kind, dropping it from the draft when it is the saved value again. */
  function put<K extends keyof MotionDraft>(kind: K, key: string, value: MotionDraft[K][string], saved: boolean) {
    setDraft((d) => {
      const next = { ...d[kind] } as Record<string, unknown>;
      if (saved) delete next[key];
      else next[key] = value;
      return { ...d, [kind]: next };
    });
  }

  const n = Object.values(draft).reduce((s, x) => s + Object.keys(x).length, 0);
  return {
    draft,
    n,
    clear: () => setDraft(EMPTY),
    /** Toggles chains; `savedValue` is the value shown without a draft. */
    toggle: (changes: Array<[string, boolean]>, savedValue: (k: string) => boolean) =>
      setDraft((d) => {
        const chains = { ...d.chains };
        for (const [k, on] of changes) {
          if (on === savedValue(k)) delete chains[k];
          else chains[k] = on;
        }
        return { ...d, chains };
      }),
    setPool: (key: string, pool: MotionPoolEntry[] | null) => put('pools', key, pool, samePool(stored?.pools[key], pool)),
    setBlend: (clip: string, s: number | null) => put('blend', clip, s, (stored?.blend_in[clip] ?? null) === s),
    setNote: (key: string, text: string) => put('notes', key, text, (notes[key] ?? '') === text),
    /** The whole set to save: chains that differ from their default, the stored rest with the draft over it. */
    next: (rows: ChainRow[], value: (k: string) => boolean): MotionOverrides => {
      const base = stored ?? { chains: {}, pools: {}, blend_in: {} };
      const chains = Object.fromEntries(rows.filter((r) => value(r.key) !== r.def).map((r) => [r.key, value(r.key)]));
      const out: MotionOverrides = { chains, pools: merge(base.pools, draft.pools), blend_in: merge(base.blend_in, draft.blend) };
      const kept = merge(notes, draft.notes, (t) => t.trim() !== '');
      if (Object.keys(kept).length > 0) out.notes = kept;
      return out;
    },
  };
}
