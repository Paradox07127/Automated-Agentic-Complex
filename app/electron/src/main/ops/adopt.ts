// Files the user drops on or pastes into a page, held by the page only as `scope_file` handles like a picked file
// (protocol/ui-bridge/CONTRACT.md step 7). Only the preload calls these, over their own IPC channels: a dropped file's
// path comes from `webUtils.getPathForFile`, which gives none for a File the page made itself.
import type { Surface } from '../../common/bridge.ts';
import type { PageSession } from '../../common/page.ts';
import { ORIGIN } from '../../common/ui.ts';
import { imageExtensions, MAX_IMAGE_BYTES, MAX_SCOPE_FILES, pastedImages } from '../../common/adoption.ts';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const SCOPE_FILE_TYPES = ['md', 'txt', 'csv', 'json', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
let pasteGeneration = 0;

export function clearPasted(supportDir: string): void {
  pasteGeneration++;
  rmSync(join(supportDir, 'pasted'), { recursive: true, force: true });
}

export interface Adopted { handle: string; displayName: string; size: number }
type Picked = PageSession['picked'];

function hold(picked: Picked, path: string, displayName: string, size: number, discard?: () => void): Adopted {
  const handle = randomUUID().toUpperCase();
  picked.set(handle, { purpose: 'scope_file', path, ...(discard && { discard }) });
  return { handle, displayName, size };
}

/** One handle per path that is a regular file of a scope type; the others are left out. */
export async function adoptPaths(paths: unknown, picked: Picked): Promise<Adopted[]> {
  if (!Array.isArray(paths)) return [];
  const out: Adopted[] = [];
  for (const p of paths.slice(0, MAX_SCOPE_FILES)) {
    if (typeof p !== 'string' || p === '' || !SCOPE_FILE_TYPES.includes(extname(p).slice(1).toLowerCase())) continue;
    const s = await stat(p).catch(() => null);
    if (s?.isFile() && s.size <= MAX_IMAGE_BYTES) out.push(hold(picked, p, basename(p), s.size));
  }
  return out;
}

/** An unused handle owns its copy until release or the end of its document. */
export async function adoptPasted(items: unknown, page: PageSession, dir: string): Promise<Adopted[]> {
  const images = pastedImages(items);
  if (!images.length) return [];
  const generation = page.generation, batch = pasteGeneration;
  const files: { path: string; name: string; size: number }[] = [];
  let committed = false;
  await mkdir(dir, { recursive: true });
  try {
    for (const { type, data } of images) {
      const name = `pasted-${randomUUID()}.${imageExtensions.get(type)!}`;
      const path = join(dir, name);
      files.push({ path, name, size: data.byteLength });
      await writeFile(path, new Uint8Array(data), { mode: 0o600 });
      if (generation !== page.generation || batch !== pasteGeneration) return [];
    }
    const handles = files.map(({ path, name, size }) =>
      hold(page.picked, path, name, size, () => rmSync(path, { force: true })));
    committed = true;
    return handles;
  } finally {
    if (!committed) for (const { path } of files) rmSync(path, { force: true });
  }
}

export function filePage(event: { sender: { mainFrame: object }; senderFrame: { origin: string } | null },
  entry?: { surface: Surface; page: PageSession }): PageSession | undefined {
  return entry?.surface === 'main' && event.senderFrame?.origin === ORIGIN && event.senderFrame === event.sender.mainFrame ? entry.page : undefined;
}
