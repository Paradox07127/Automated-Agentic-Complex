// Files the user drops on or pastes into a page, held by the page only as `scope_file` handles like a picked file
// (protocol/ui-bridge/CONTRACT.md step 7). Only the preload calls these, over their own IPC channels: a dropped file's
// path comes from `webUtils.getPathForFile`, which gives none for a File the page made itself.
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const SCOPE_FILE_TYPES = ['md', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
const PASTED_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** Bytes of one pasted image. */
export const PASTE_MAX = 20 * 1024 * 1024;

export interface Adopted { handle: string; displayName: string; size: number }
type Picked = Map<string, { purpose: string; path: string }>;

function hold(picked: Picked, path: string, displayName: string, size: number): Adopted {
  const handle = randomUUID().toUpperCase();
  picked.set(handle, { purpose: 'scope_file', path });
  return { handle, displayName, size };
}

/** One handle per path that is a regular file of a scope type; the others are left out. */
export async function adoptPaths(paths: unknown, picked: Picked): Promise<Adopted[]> {
  if (!Array.isArray(paths)) return [];
  const out: Adopted[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p === '' || !SCOPE_FILE_TYPES.includes(extname(p).slice(1).toLowerCase())) continue;
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) out.push(hold(picked, p, basename(p), s.size));
  }
  return out;
}

/** Each pasted image written under `dir` and held; other types and images over PASTE_MAX are left out. */
export async function adoptPasted(items: unknown, picked: Picked, dir: string): Promise<Adopted[]> {
  if (!Array.isArray(items)) return [];
  const out: Adopted[] = [];
  for (const item of items) {
    const o = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    const ext = typeof o.type === 'string' ? PASTED_TYPES[o.type] : undefined;
    if (!ext || !(o.data instanceof ArrayBuffer) || o.data.byteLength === 0 || o.data.byteLength > PASTE_MAX) continue;
    await mkdir(dir, { recursive: true });
    const name = `pasted-${randomUUID()}.${ext}`;
    const path = join(dir, name);
    await writeFile(path, new Uint8Array(o.data), { mode: 0o600 });
    out.push(hold(picked, path, name, o.data.byteLength));
  }
  return out;
}
