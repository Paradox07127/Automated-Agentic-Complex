// C3 v27 rule 51: one character's whole motion override set as config.json `motion_overrides` keeps it
// (`{character: {chains, pools, blend_in, notes?}}`) and `avatar.motionOverrides.*` carry it.
import { MOTION_OVERRIDES } from './c3.ts';

export interface PoolEntry { clip: string; weight: number }

export interface StoredOverrides {
  /** Chain key (its first clip) → on. */
  chains: Record<string, boolean>;
  pools: Record<string, PoolEntry[]>;
  /** Clip → seconds, 0–2. */
  blend_in: Record<string, number>;
  /** Chain key → the user's note; config.json only, never sent to the avatar. */
  notes: Record<string, string>;
}

/** The notes' own limits: one per chain, 500 characters each. */
const NOTES = { count: MOTION_OVERRIDES.chains, characters: 500 } as const;

const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && v !== '' && encoder.encode(v).length <= MOTION_OVERRIDES.keyBytes;
/** Grapheme clusters. */
const characters = (s: string): number => [...graphemes.segment(s)].length;

/** MotionOverrides.parse: a `{chains, pools, blend_in, notes?}` object within rule 51 (j) and the notes' limits; null when any
 *  part breaks them. Other keys are ignored. */
export function parseOverrides(value: unknown): StoredOverrides | null {
  if (!isObject(value)) return null;
  const { chains, pools, blend_in: blend, notes } = value;
  if (!isObject(chains) || Object.keys(chains).length > MOTION_OVERRIDES.chains || !isObject(pools)
    || Object.keys(pools).length > MOTION_OVERRIDES.pools || !isObject(blend) || Object.keys(blend).length > MOTION_OVERRIDES.blendIn) {
    return null;
  }
  const result: StoredOverrides = { chains: {}, pools: {}, blend_in: {}, notes: {} };
  if (notes !== undefined) {
    if (!isObject(notes) || Object.keys(notes).length > NOTES.count) return null;
    for (const [k, v] of Object.entries(notes)) {
      if (!key(k) || typeof v !== 'string' || characters(v) > NOTES.characters) return null;
      result.notes[k] = v;
    }
  }
  for (const [k, v] of Object.entries(chains)) {
    if (!key(k) || typeof v !== 'boolean') return null;
    result.chains[k] = v;
  }
  for (const [k, v] of Object.entries(pools)) {
    if (!key(k) || !Array.isArray(v) || v.length < 1 || v.length > MOTION_OVERRIDES.poolEntries) return null;
    const entries: PoolEntry[] = [];
    for (const item of v) {
      if (!isObject(item) || !key(item.clip) || !Number.isInteger(item.weight) || (item.weight as number) < 1
        || (item.weight as number) > MOTION_OVERRIDES.weight) return null;
      entries.push({ clip: item.clip, weight: item.weight as number });
    }
    if (new Set(entries.map((e) => e.clip)).size !== entries.length) return null;
    result.pools[k] = entries;
  }
  for (const [k, v] of Object.entries(blend)) {
    if (!key(k) || typeof v !== 'number' || !(v >= 0 && v <= MOTION_OVERRIDES.blendSeconds)) return null;
    result.blend_in[k] = v;
  }
  return result;
}

/** `avatar.motionOverrides.set`'s argument (rule 51 (j)): exactly `{chains, pools, blend_in}`
 *  and optional `notes`; null otherwise. */
export function overridesArg(value: unknown): StoredOverrides | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value).filter((k) => k !== 'notes').sort();
  if (keys.join(',') !== 'blend_in,chains,pools') return null;
  return parseOverrides(value);
}

/** `{chains, pools, blend_in}`, and `notes` when there are any. */
export function overridesJson(o: StoredOverrides): Record<string, unknown> {
  const json: Record<string, unknown> = { chains: o.chains, pools: o.pools, blend_in: o.blend_in };
  if (Object.keys(o.notes).length > 0) json.notes = o.notes;
  return json;
}

/** The set the avatar gets: without the notes. */
export const sentOverrides = (o: StoredOverrides) => ({ chains: o.chains, pools: o.pools, blend_in: o.blend_in });

/** Nothing to send; notes do not count. */
export const overridesEmpty = (o: StoredOverrides): boolean =>
  [o.chains, o.pools, o.blend_in].every((t) => Object.keys(t).length === 0);


/** The character's stored set from config.json's object; null when there is none or it breaks
 *  rule 51 (j). */
export function loadOverrides(config: Record<string, unknown>, character: string): StoredOverrides | null {
  const all = config.motion_overrides;
  return isObject(all) ? parseOverrides(all[character]) : null;
}

/** The config.json object with the character's whole set; other characters and keys stay. */
export function storeOverrides(config: Record<string, unknown>, character: string, o: StoredOverrides): Record<string, unknown> {
  const all = isObject(config.motion_overrides) ? config.motion_overrides : {};
  return { ...config, motion_overrides: { ...all, [character]: overridesJson(o) } };
}
