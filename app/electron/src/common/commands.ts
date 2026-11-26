// agentd's `/feed` `looks` event.
import { modAppearance, modValues, type ModValues } from './looks.ts';

/** agentd's `/feed` `looks` event: her own change of appearance, layers or one appearance's mod switches. */
export interface FeedLooks {
  seq: number;
  requestId: string;
  /** The character agentd checked the ids against. */
  character: string;
  appearance?: string;
  layers?: { hide: string[]; show: string[] };
  modSettings?: { appearance: string; values: ModValues };
}

const LOOKS_KEYS = ['seq', 'request_id', 'character', 'appearance', 'layers', 'mod_settings'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const layerIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => modAppearance(x) !== null);

/** Null for another event, or one with any part that does not decode: none of it is carried out. */
export function feedLooks(e: { event: string; data: string }): FeedLooks | null {
  if (e.event !== 'looks') return null;
  let v: unknown;
  try {
    v = JSON.parse(e.data);
  } catch {
    return null;
  }
  if (!isObject(v) || !Object.keys(v).every((k) => LOOKS_KEYS.includes(k))) return null;
  const { seq, request_id: requestId, appearance, layers, mod_settings: mods } = v;
  if (!Number.isInteger(seq) || typeof requestId !== 'string' || !/^[0-9a-f]{16}$/.test(requestId)) return null;
  const character = modAppearance(v.character);
  if (character === null) return null;
  if (appearance === undefined && layers === undefined && mods === undefined) return null;
  const out: FeedLooks = { seq: seq as number, requestId, character };
  if (appearance !== undefined) {
    const id = modAppearance(appearance);
    if (id === null) return null;
    out.appearance = id;
  }
  if (layers !== undefined) {
    if (!isObject(layers) || Object.keys(layers).length !== 2 || !layerIds(layers.hide) || !layerIds(layers.show)
      || layers.hide.length + layers.show.length === 0) return null;
    out.layers = { hide: layers.hide, show: layers.show };
  }
  if (mods !== undefined) {
    const id = isObject(mods) ? modAppearance(mods.appearance) : null, values = isObject(mods) ? modValues(mods.values) : null;
    if (id === null || values === null || Object.keys(values).length === 0) return null;
    out.modSettings = { appearance: id, values };
  }
  return out;
}
