// agentic-complex-ui://app/ over one root directory, with `art/` from the UI art directory
// the web-ui component copies into its ui/art, and `characters/<id>/head.png`, `portrait.png` and `background.png` from the character packages.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { ArtKind } from '../common/character.ts';
import { CSP, HOST, MIME_TYPES, SCHEME } from '../common/ui.ts';

export interface UiResponse { status: number; headers: Record<string, string>; body: Buffer }

/** Electron's NativeImage, as far as a portrait needs it. */
export interface ArtImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: { width: number; height: number; quality: 'best' }): { toPNG(): Buffer };
  toPNG(): Buffer;
}

export interface CharacterArt {
  /** The package file of a character's head, portrait or background; null for an unknown id or a missing file. */
  file(id: string, kind: ArtKind): string | null;
  /** The image in a file (`nativeImage.createFromPath`). */
  image(file: string): ArtImage;
}

const PORTRAIT_MAX_PIXELS = 1024;

/** A request's path parts, or null when the answer is 404. */
function partsOf(url: string): string[] | null {
  let parsed: URL, decoded: string;
  try {
    parsed = new URL(url);
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (parsed.protocol !== SCHEME + ':' || parsed.hostname !== HOST || decoded.includes('\\') || decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter((p) => p !== '' && p !== '.');
  return parts.length === 0 || parts.includes('..') ? null : parts;
}

/** The file under `realRoot` (`art/` under `realArt`) the parts name, or null when the answer is 404. */
function fileFor(realRoot: string, realArt: string | null, parts: string[]): string | null {
  if (parts[0] === 'characters') return null;
  const [base, rest] = parts[0] === 'art' && realArt !== null ? [realArt, parts.slice(1)] : [realRoot, parts];
  try {
    const file = realpathSync(join(base, ...rest));
    return file.startsWith(base + sep) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Answers requests from `root`'s files, `art/` from `art`'s and `characters/` from `characters`; `root` must exist, a missing
 *  `art` leaves `art/` to `root`. Every answer carries the CSP. */
export function uiServer(root: string, art: string | null = null, characters: CharacterArt | null = null): (url: string) => UiResponse {
  const realRoot = realpathSync(root);
  let realArt: string | null = null;
  try {
    if (art !== null) realArt = realpathSync(art);
  } catch { /* no art: the pages go without it */ }
  /** Downscaled portraits by character id. */
  const portraits = new Map<string, Buffer>();

  /** The PNG of `characters/<id>/<kind>.png`, a portrait at most PORTRAIT_MAX_PIXELS on its
   *  longest side. */
  const characterArt = (parts: string[]): Buffer | null => {
    const [top, id, name] = parts;
    const kind = name?.endsWith('.png') ? name.slice(0, -4) : null;
    if (characters === null || parts.length !== 3 || top !== 'characters' || (kind !== 'head' && kind !== 'portrait' && kind !== 'background')) return null;
    const file = characters.file(id!, kind);
    if (file === null) return null;
    if (kind !== 'portrait') {
      try {
        return readFileSync(file);
      } catch {
        return null;
      }
    }
    const cached = portraits.get(id!);
    if (cached !== undefined) return cached;
    const image = characters.image(file);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    const scale = PORTRAIT_MAX_PIXELS / Math.max(width, height);
    const png = scale >= 1 ? image.toPNG()
      : image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toPNG();
    portraits.set(id!, png);
    return png;
  };

  const missing = (): UiResponse =>
    ({ status: 404, headers: { 'Content-Security-Policy': CSP, 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.alloc(0) });
  return (url): UiResponse => {
    const parts = partsOf(url);
    const found = parts && characterArt(parts);
    const file = !found && parts ? fileFor(realRoot, realArt, parts) : null;
    const mime = found ? 'image/png' : file && MIME_TYPES[extname(file).slice(1).toLowerCase()];
    if (!mime || (!found && !file)) return missing();
    let body: Buffer;
    try {
      body = found ?? readFileSync(file!);
    } catch {
      // Gone or unreadable since it was found.
      return missing();
    }
    return { status: 200, headers: { 'Content-Security-Policy': CSP, 'Content-Type': mime, 'Content-Length': String(body.length) }, body };
  };
}
