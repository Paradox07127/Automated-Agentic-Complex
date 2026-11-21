// Her look over C3 v27 and what the user chose of it: the appearance and layer lists of a `hello` or `character_changed`,
// mod settings (rule 53) and the action switch reply (rule 28), and config.json's `mod_settings` and `action_switches`.
import { type C3Message, MAX_LINE } from './c3.ts';

export interface AppearanceOption { id: string; name: string; kind?: string; desc?: string }
export interface LayerOption { id: string; name: string; appearances?: string[] }
/** One appearance's mod switches: switch id → 0–255. */
export type ModValues = Record<string, number>;
export interface Adjusted { id: string; reason: string }
/** C3 `mod_settings`; `req` null for her own report (rule 53 (e)). */
export interface ModReceipt { req: number | null; character: string; appearance: string; values: ModValues; adjusted: Adjusted[] }
/** C3 `action_switches`. */
export interface SwitchReply { character: string; switches: Record<string, boolean>; adjusted: Adjusted[]; error?: string }

/** HostLink.maxLayers, maxLayerNameBytes, layersFailReasons. */
export const MAX_LAYERS = 16;
const MAX_LAYER_NAME = 64;
export const LAYER_FAIL_REASONS = ['superseded', 'switching', 'unknown_layer', 'load_failed'];
const MAX_ACTIONS = 128;
const MAX_ID = 64;
const SWITCH_ERRORS = ['wrong_character', 'switching', 'not_ready'];
const SWITCH_ADJUSTED = ['required', 'missing', 'last_in_section'];
const MOD_REASONS = ['defaulted', 'unsupported'];
const MAX_MODS = 64;

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** reportAppearances: the list and the current one when they agree; otherwise none, with why for the log. */
export function readAppearances(m: C3Message): { current: string | null; options: AppearanceOption[]; problem: string | null } {
  if (m.appearance === undefined && m.appearances === undefined) return { current: null, options: [], problem: null };
  const items = Array.isArray(m.appearances) ? m.appearances : [];
  const options: AppearanceOption[] = [];
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || item.id === '' || item.name === '') continue;
    const option: AppearanceOption = { id: item.id, name: item.name };
    if (typeof item.kind === 'string') option.kind = item.kind;
    if (typeof item.desc === 'string') option.desc = item.desc;
    options.push(option);
  }
  const current = m.appearance;
  if (typeof current === 'string' && options.length > 0 && options.length === items.length && options.some((o) => o.id === current)) {
    return { current, options, problem: null };
  }
  return { current: null, options: [], problem: `appearance=${String(current ?? '')} appearances=${JSON.stringify(m.appearances ?? '')}` };
}

/** parseLayers: null when the message has neither field; `problem` when they break rule 46 (h). */
export function readLayers(m: C3Message): { layers: LayerOption[]; hidden: string[] } | { problem: string } | null {
  if (m.layers === undefined && m.hidden_layers === undefined) return null;
  const items = m.layers, hidden = m.hidden_layers;
  if (!Array.isArray(items) || !strings(hidden)) return { problem: 'layers and hidden_layers must both be lists' };
  if (items.length > MAX_LAYERS || hidden.length > MAX_LAYERS) return { problem: `more than ${MAX_LAYERS} layers` };
  const layers: LayerOption[] = [];
  for (const item of items) {
    if (!isObject(item) || typeof item.id !== 'string' || !ID.test(item.id) || typeof item.name !== 'string' || item.name === ''
      || bytes(item.name) > MAX_LAYER_NAME) {
      return { problem: `bad layer ${isObject(item) ? String(item.id ?? '') : ''}` };
    }
    const layer: LayerOption = { id: item.id, name: item.name };
    if (item.appearances !== undefined) {
      if (!strings(item.appearances) || item.appearances.length === 0 || item.appearances.some((a) => a === '')) {
        return { problem: `bad appearances of layer ${item.id}` };
      }
      layer.appearances = item.appearances;
    }
    layers.push(layer);
  }
  const ids = layers.map((l) => l.id);
  if (new Set(ids).size !== ids.length) return { problem: 'repeated layer id' };
  if (new Set(hidden).size !== hidden.length || !hidden.every((h) => ids.includes(h))) {
    return { problem: `hidden_layers ${hidden.join(',')} are not distinct ids of layers` };
  }
  return { layers, hidden };
}

/** `{switch id: 0–255}`, at most 64; null when any part breaks rule 53 (h). */
export function modValues(v: unknown): ModValues | null {
  if (!isObject(v) || Object.keys(v).length > MAX_MODS) return null;
  for (const [k, x] of Object.entries(v)) {
    if (!ID.test(k) || typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 255) return null;
  }
  return v as ModValues;
}

/** 1–64 bytes. */
export const modAppearance = (v: unknown): string | null => (typeof v === 'string' && bytes(v) >= 1 && bytes(v) <= MAX_ID ? v : null);

const sorted = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.keys(o).sort().map((k) => [k, isObject(o[k]) ? sorted(o[k] as Record<string, unknown>) : o[k]]));

/** `--agentic-complex-mod-settings`'s JSON, keys sorted; null with nothing to pass or over a line. */
export function modArgument(all: Record<string, ModValues>): string | null {
  if (Object.keys(all).length === 0) return null;
  const text = JSON.stringify(sorted(all));
  return bytes(text) <= MAX_LINE ? text : null;
}

/** The field at fault when it does not parse. */
export function readModReceipt(m: C3Message): ModReceipt | string {
  let req: number | null = null;
  if (m.req !== null) {
    if (typeof m.req !== 'number' || !Number.isInteger(m.req) || m.req < 1 || m.req > 2147483647) return 'req';
    req = m.req;
  }
  if (typeof m.character !== 'string' || m.character === '') return 'character';
  const appearance = modAppearance(m.appearance);
  if (appearance === null) return 'appearance';
  const values = modValues(m.values);
  if (values === null) return 'values';
  const adjusted: Adjusted[] = [];
  if (m.adjusted !== undefined) {
    if (!Array.isArray(m.adjusted) || m.adjusted.length > MAX_MODS) return 'adjusted';
    for (const a of m.adjusted) {
      if (!isObject(a) || typeof a.id !== 'string' || !ID.test(a.id) || !MOD_REASONS.includes(a.reason as string)) return 'adjusted';
      adjusted.push({ id: a.id, reason: a.reason as string });
    }
  }
  return { req, character: m.character, appearance, values, adjusted };
}

/** `{action id: bool}`, at most 128. */
function switchTable(v: unknown): Record<string, boolean> | null {
  if (!isObject(v) || Object.keys(v).length > MAX_ACTIONS) return null;
  for (const [k, x] of Object.entries(v)) if (k === '' || bytes(k) > MAX_ID || typeof x !== 'boolean') return null;
  return v as Record<string, boolean>;
}

/** The field at fault when it does not parse. */
export function readSwitchReply(m: C3Message): SwitchReply | string {
  if (typeof m.character !== 'string' || m.character === '') return 'character';
  const switches = switchTable(m.switches);
  if (switches === null) return 'switches';
  if (!Array.isArray(m.adjusted) || m.adjusted.length > Object.keys(switches).length) return 'adjusted';
  const adjusted: Adjusted[] = [];
  for (const a of m.adjusted) {
    if (!isObject(a) || typeof a.id !== 'string' || a.id === '' || !SWITCH_ADJUSTED.includes(a.reason as string)) return 'adjusted';
    adjusted.push({ id: a.id, reason: a.reason as string });
  }
  const reply: SwitchReply = { character: m.character, switches, adjusted };
  if (m.error !== undefined) {
    if (typeof m.error !== 'string' || !SWITCH_ERRORS.includes(m.error) || adjusted.length > 0) return 'error';
    reply.error = m.error;
  }
  return reply;
}

/** The character's appearances in config.json; one that breaks rule 53 (h) is left out. */
export function storedModSettings(config: Record<string, unknown>, character: string): Record<string, ModValues> {
  const all = isObject(config.mod_settings) ? config.mod_settings[character] : undefined;
  const out: Record<string, ModValues> = {};
  if (!isObject(all)) return out;
  for (const [appearance, v] of Object.entries(all)) {
    const values = modValues(v);
    if (modAppearance(appearance) !== null && values !== null) out[appearance] = values;
  }
  return out;
}

/** Config.json with the character's appearances; none drops the character. */
export function withModSettings(config: Record<string, unknown>, character: string, appearances: Record<string, ModValues>): Record<string, unknown> {
  const all = { ...(isObject(config.mod_settings) ? config.mod_settings : {}) };
  if (Object.keys(appearances).length === 0) delete all[character];
  else all[character] = appearances;
  return { ...config, mod_settings: all };
}

/** The user's table for the character; null when there is none. */
export function storedSwitches(config: Record<string, unknown>, character: string): Record<string, boolean> | null {
  const table = isObject(config.action_switches) ? config.action_switches[character] : undefined;
  return isObject(table) && Object.values(table).every((v) => typeof v === 'boolean') ? table as Record<string, boolean> : null;
}

export function withSwitches(config: Record<string, unknown>, character: string, switches: Record<string, boolean>): Record<string, unknown> {
  return { ...config, action_switches: { ...(isObject(config.action_switches) ? config.action_switches : {}), [character]: switches } };
}
