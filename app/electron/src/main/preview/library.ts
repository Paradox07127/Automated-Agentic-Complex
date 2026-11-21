// What a preview `load` needs of a character package: its native bundle, the bundle's sha256, and the
// archive clip that plays an action. Each document is checked against its reference's size and sha256 and must stay in the package.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { parseCatalogDocument } from '../../common/config.ts';

export interface MotionLibrary {
  bundle: string;
  sha256: string;
  character: string;
  /** The actor archive's clips in order, each with the first playable action that lists it. */
  clips: { clip: string; actionID: string | null }[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

class MotionError extends Error {}

function document(path: string): Json {
  const d: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isObject(d)) throw new MotionError('motion_document');
  return d;
}

/** The library entry's package, or null when the catalog has no such character. */
export function loadMotionLibrary(catalog: string, characterID: string): MotionLibrary | null {
  const entry = parseCatalogDocument(readFileSync(catalog, 'utf8')).entries.find((e) => e.id === characterID);
  if (!entry) return null;
  const definition = realpathSync(resolve(dirname(catalog), entry.definition));
  const root = dirname(definition);
  const contained = (path: string) => {
    const real = realpathSync(path);
    if (!real.startsWith(root + sep)) throw new MotionError('motion_path_escape');
    return real;
  };
  const reference = (owner: string, raw: unknown) => {
    if (!isObject(raw) || typeof raw.file !== 'string' || typeof raw.sha256 !== 'string' || typeof raw.byte_count !== 'number') {
      throw new MotionError('motion_reference');
    }
    const path = contained(resolve(dirname(owner), raw.file));
    const data = readFileSync(path);
    if (data.length !== raw.byte_count || createHash('sha256').update(data).digest('hex') !== raw.sha256) throw new MotionError('motion_identity');
    return path;
  };
  const def = document(definition);
  const render = isObject(def.components) ? def.components.render : undefined;
  if (!isObject(render) || !isObject(render.native_bundle) || typeof render.native_bundle.file !== 'string') {
    throw new MotionError('text_only_package');
  }
  const bundle = contained(resolve(root, render.native_bundle.file));
  const sha256 = typeof render.native_bundle.sha256 === 'string' ? render.native_bundle.sha256 : '';
  const native = document(bundle);
  const role = (Array.isArray(native.characters) ? native.characters : []).find((c: unknown) => isObject(c) && c.id === characterID);
  if (!isObject(role)) throw new MotionError('motion_role');
  const archive = document(reference(bundle, role.actor_archive));
  const packPath = reference(bundle, role.c7);
  const pack = document(packPath);
  const section = (name: string, file: string): Json | null => {
    const s = pack[name];
    const ref = isObject(s) && Array.isArray(s.data) ? s.data.find((d: unknown) => isObject(d) && d.file === file) : undefined;
    return ref === undefined ? null : document(reference(resolve(dirname(packPath), name, 'owner.json'), ref));
  };
  const actions: Json[] = [];
  for (const part of ['animation', 'interaction']) {
    const list = section(part, 'actions.json')?.actions;
    if (Array.isArray(list)) actions.push(...list.filter(isObject));
  }
  const playable = actions.filter((a) => a.unavailable_reason === undefined && a.section !== 'move');
  const clips: MotionLibrary['clips'] = [];
  for (const row of Array.isArray(archive.clips) ? archive.clips : []) {
    if (!isObject(row) || typeof row.name !== 'string' || typeof row.length !== 'number') continue;
    const name = row.name;
    const action = playable.find((a) => Array.isArray(a.clips) && a.clips.includes(name));
    clips.push({ clip: name, actionID: typeof action?.id === 'string' ? action.id : null });
  }
  return { bundle, sha256, character: characterID, clips };
}
