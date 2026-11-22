// 雷霆大字: the new character's name in big white text over the middle of the screen she stands on while a character switch
// runs, in the game's white big area-title layout, from the switch's start until the avatar shows her: shown at least 4 s, gone
// 12 s after it opened at the latest. `stack.html#/title` shows it in a transparent overlay that clicks pass through and that never
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

/** The least time the title stays once it has shown, so a quick switch does not flash it. */
export const TITLE_MIN_MS = 4000;
/** The most time the title stays from opening, so a page that never loads or a switch that hangs does not keep it up. */
export const TITLE_MAX_MS = 12000;

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
  /** The character the open title names. */
  private target: string | null = null;
  /** The user's last choice not yet started: the switch sets `pending`, then clears it just before it starts running. */
  private picked: string | null = null;
  private switching = false;
  /** When the open title showed, in ms; null while its page loads. */
  private shownAt: number | null = null;
  /** She has appeared, or the run ended without her: the title goes once it has shown TITLE_MIN_MS. */
  private done = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(options: TitleOverlayOptions) {
    this.o = options;
  }

  /** CharacterSwitch.onChange: a run that starts on the user's choice of another character opens the title; it goes once the
   *  avatar shows that character or the run ends without it, after showing TITLE_MIN_MS. Launch, a reconnect, a restore or an
   *  agentd catch-up start no run on a choice, so they show nothing. */
  view(view: CharacterView): void {
    if (view.pending !== null) this.picked = view.pending;
    // The pick of the character she is starts no run.
    else if (!view.switching && this.picked === view.current) this.picked = null;
    if (view.switching && !this.switching) {
      const id = this.picked;
      this.picked = null;
      if (id !== null && id !== view.current) this.open(id);
    }
    this.switching = view.switching;
    if (this.target !== null && !this.done && (!view.switching || view.shown === this.target)) {
      this.done = true;
      if (this.shownAt !== null) this.closeAfterFloor();
    }
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.target = null;
  }

  /** A new title replaces the open one. */
  private open(id: string): void {
    this.stop();
    if (!this.o.enabled()) return;
    const frame = this.o.screen();
    if (!frame) return;
    const { name, en } = this.o.names(id);
    const win = this.win = this.o.makeWindow();
    this.target = id;
    this.shownAt = null;
    this.done = false;
    this.timers.push(setTimeout(() => this.stop(), TITLE_MAX_MS));
    win.setBounds(this.o.toDip(frame));
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win) return;
      win.showInactive();
      this.shownAt = Date.now();
      if (this.done) this.closeAfterFloor();
    });
    // Destroying a window rejects its pending load.
    void win.loadURL(`${this.o.url}?${new URLSearchParams({ name, ...(en ? { en } : {}) }).toString()}`).catch((e: unknown) => {
      if (!win.isDestroyed()) throw e;
    });
  }

  private closeAfterFloor(): void {
    const left = this.shownAt! + TITLE_MIN_MS - Date.now();
    if (left <= 0) this.stop();
    else this.timers.push(setTimeout(() => this.stop(), left));
  }
}
