// 交给她: which part of a drop on her
// is a motion to import, the drops waiting for the desktop layer, the clipboard as a drop, and what an Option-held drag release
// over a window does.
import type { DropItem } from './stack-cards.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'aif', 'aiff']);

/** NSString `pathExtension`, lowercased: none for a name that only starts with a dot. */
function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path, dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export interface DropSplit { source: string | null; extras: string[]; bgm: string | null; rest: DropItem[] }

/** The motion (the first ZIP, else the first VMD), the other VMDs and the first audio file only
 *  alongside one; everything else goes to the stack. */
export function splitMotion(items: DropItem[]): DropSplit {
  const path = (item: DropItem, extensions: Set<string>): string | null =>
    (item.kind === 'file' && extensions.has(extensionOf(item.path)) ? item.path : null);
  const zip = new Set(['zip']), vmd = new Set(['vmd']);
  let sourceIndex = items.findIndex((i) => path(i, zip) !== null);
  if (sourceIndex < 0) sourceIndex = items.findIndex((i) => path(i, vmd) !== null);
  if (sourceIndex < 0) return { source: null, extras: [], bgm: null, rest: items };
  const extraIndices = items.flatMap((i, n) => (n !== sourceIndex && path(i, vmd) !== null ? [n] : []));
  const bgmIndex = items.findIndex((i) => path(i, AUDIO_EXTENSIONS) !== null);
  return {
    source: path(items[sourceIndex]!, new Set(['zip', 'vmd'])),
    extras: extraIndices.map((n) => path(items[n]!, vmd)!),
    bgm: bgmIndex < 0 ? null : path(items[bgmIndex]!, AUDIO_EXTENSIONS),
    rest: items.filter((_, n) => n !== sourceIndex && n !== bgmIndex && !extraIndices.includes(n)),
  };
}

/** C3 rule 38's items, as `dropProblem` let them through. */
export function dropEventItems(items: Record<string, string>[]): DropItem[] {
  return items.map((i): DropItem => (i.kind === 'file' ? { kind: 'file', path: i.path! }
    : i.kind === 'url' ? { kind: 'url', url: i.url! } : { kind: 'text', text: i.text! }));
}

export interface Drop { items: DropItem[]; truncated: boolean }

/** DropBacklog: drops that arrived before the desktop layer was up, the last 4. */
export class DropBacklog {
  static readonly limit = 4;
  private drops: Drop[] = [];

  get count(): number { return this.drops.length; }

  add(items: DropItem[], truncated: boolean): void {
    this.drops.push({ items, truncated });
    if (this.drops.length > DropBacklog.limit) this.drops.shift();
  }

  /** All waiting drops, oldest first; the backlog is empty afterwards. */
  drain(): Drop[] {
    const drops = this.drops;
    this.drops = [];
    return drops;
  }
}

/** The avatar's drop limits: items and text bytes. */
export const CLIPBOARD_LIMITS = { items: 16, textBytes: 16_384 } as const;

/** One item per clip item that has
 *  a file, a link or text, at most CLIPBOARD_LIMITS.items of them. */
export function clipboardDrop(result: Json): Drop & { concealed: boolean } {
  if (result.concealed === true) return { items: [], truncated: false, concealed: true };
  const all = (Array.isArray(result.items) ? result.items : []).flatMap((i): DropItem[] => {
    if (!isObject(i)) return [];
    if (typeof i.file === 'string' && i.file !== '') return [{ kind: 'file', path: i.file }];
    if (typeof i.url === 'string' && i.url !== '') return [{ kind: 'url', url: i.url }];
    if (typeof i.text === 'string' && i.text !== '') return [{ kind: 'text', text: i.text }];
    return [];
  });
  return { items: all.slice(0, CLIPBOARD_LIMITS.items), truncated: result.truncated === true || all.length > CLIPBOARD_LIMITS.items,
    concealed: false };
}

/** The `window` desktop command the 快速输入 page attaches (web `bridge/desktop.ts`). */
export type WindowCommand = { kind: 'window'; windowId: number; pid: number; app: string | null; title: string | null };

export interface PointWindow { windowId: number; pid: number; title: string | null; app: string | null }

/** `windows.at_point`'s `window` asked with `include_titles`; null for none. */
export function pointWindow(result: Json): PointWindow | null {
  const w = result.window;
  if (!isObject(w) || typeof w.window_id !== 'number' || typeof w.pid !== 'number') return null;
  return { windowId: w.window_id, pid: w.pid, title: typeof w.title === 'string' ? w.title : null,
    app: typeof w.app_name === 'string' ? w.app_name : null };
}

/** An Option-held drag release over `window`; `allowsText` is the screen context policy's `text`. */
export function windowHandover(optionDown: boolean, allowsText: boolean, window: PointWindow | null):
  { kind: 'ignore' } | { kind: 'refuse'; text: string } | WindowCommand {
  if (!optionDown) return { kind: 'ignore' };
  if (!allowsText) return { kind: 'refuse', text: '读窗口文字没有打开，可以在设置的隐私里打开' };
  if (window === null) return { kind: 'refuse', text: '这里没有可以读的窗口' };
  return { kind: 'window', ...window };
}

/** ContextCapturer.RegionRead: the AX text in a dragged region, or the line that says why there is none. */
export type RegionRead = { kind: 'read'; text: string; truncated: boolean; app: string | null } | { kind: 'refused'; text: string };

/** RegionGeometry.regionRect: the rect two drag corners span, in their own space; null when a side is under `minSide`. */
export function regionRect(a: { x: number; y: number }, b: { x: number; y: number }, minSide = 8):
  { x: number; y: number; width: number; height: number } | null {
  const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  return rect.width >= minSide && rect.height >= minSide ? rect : null;
}

const REGION_KEYS = ['标签: ', '说明: ', '选中: ', '可见文字: '];

/** RegionGeometry.regionPlainText: a window observation as the user reads it; the focused control's role line goes, and each
 *  other line loses its key name. */
export function regionPlainText(observation: string): string {
  return observation.split('\n').flatMap((line) => {
    if (line.startsWith('焦点控件: ')) return [];
    const key = REGION_KEYS.find((k) => line.startsWith(k));
    return [key === undefined ? line : line.slice(key.length)];
  }).join('\n');
}
