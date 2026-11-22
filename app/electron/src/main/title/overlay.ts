// 雷霆大字: her name in big white text over the middle of the screen she stands on when a character switch lands, as the
// game's region banner. `stack.html#/title` plays it in a transparent overlay that clicks pass through and that never
// activates the app; the page has no bridge, its name and English name come in its URL. Frames are in the placement space.
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';
import { characterEntry } from '../../common/character.ts';
import { parseCatalogDocument } from '../../common/config.ts';
import type { Rect, ScreenInfo } from '../../common/placement.ts';
import type { CharacterView } from '../../common/runtime.ts';

export interface TitleOverlayOptions {
  /** `stack.html#/title`. */
  url: string;
  /** A hidden, transparent overlay window over her status level that clicks pass through and that never activates the app. */
  makeWindow(): BrowserWindow;
  toDip(r: Rect): Rectangle;
  /** The frame of the screen she stands on (`titleScreen`). */
  screen(): Rect | null;
  /** Her name, and her English name ('' without one). */
  names(id: string): { name: string; en: string };
  /** config.json `switch_title`. */
  enabled(): boolean;
}

/** The page's 5.333 s and a little more. */
export const TITLE_MS = 5400;

/** The frame of the screen with id `current` (AvatarPlacer.currentScreen), else the main screen's; null without screens. */
export function titleScreen(current: string | null, screens: readonly ScreenInfo[]): Rect | null {
  return (screens.find((s) => String(s.id) === current) ?? screens[0])?.frame ?? null;
}

/** `character.list`'s name and en of `id` in the library `catalog`; null when it cannot be read. */
export function titleNames(catalog: string, id: string): { name: string; en: string } | null {
  try {
    const entry = parseCatalogDocument(readFileSync(catalog, 'utf8')).entries.find((e) => e.id === id);
    const root = resolve(dirname(catalog)), file = entry && resolve(root, entry.definition);
    if (!file?.startsWith(root + sep)) return null;
    const { name, en } = characterEntry(readFileSync(file, 'utf8'), id, false);
    return { name: String(name), en: String(en) };
  } catch {
    return null;
  }
}

export class TitleOverlay {
  private readonly o: TitleOverlayOptions;
  private win: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: string | null = null;

  constructor(options: TitleOverlayOptions) {
    this.o = options;
  }

  /** CharacterSwitch.onChange: a switch has landed when its current character moves to another one while it runs; a hello's
   *  current at launch or on a reconnect is no switch. */
  view(view: CharacterView): void {
    const was = this.current;
    this.current = view.current;
    if (view.switching && was !== null && view.current !== null && view.current !== was) this.play(view.current);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** A new title replaces the one showing. */
  private play(id: string): void {
    if (!this.o.enabled()) return;
    const frame = this.o.screen();
    if (!frame) return;
    this.stop();
    const { name, en } = this.o.names(id);
    const win = this.win = this.o.makeWindow();
    win.setBounds(this.o.toDip(frame));
    // Shown once the page is there, so its 5.333 s start with the window.
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win) return;
      win.showInactive();
      this.timer = setTimeout(() => this.stop(), TITLE_MS);
    });
    void win.loadURL(`${this.o.url}?${new URLSearchParams({ name, ...(en ? { en } : {}) }).toString()}`);
  }
}
