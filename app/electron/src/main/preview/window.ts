// The preview in the main window: frames from the preview service go to the page with Electron's `sharedTexture`, and the preload
// draws them into a canvas over the rect the page reported (src/preload/index.ts). A window gets one connection for its life;
// closing it ends the connection.
import { type BrowserWindow, screen, sharedTexture } from 'electron';
import { BridgeFailure } from '../../common/bridge.ts';
import type { PreviewRect } from '../ops/preview.ts';
import type { PreviewView } from './controller.ts';
import { previewOutput, PreviewSession, type PreviewSelection, type PreviewSurface, type PreviewTransport } from './session.ts';

/** The addon (native/mac/preview.m). */
export interface PreviewAddon extends PreviewTransport<PreviewSurface> {
  mainBundle(): { identifier: string | null; path: string };
  setPreventsActivation(nativeWindowHandle: Buffer): boolean;
}

/** The service is `<bundle id>.preview`, `local.agenticcomplex.companion` without a bundle id. */
export function previewService(identifier: string | null): string {
  return `${identifier ?? 'local.agenticcomplex.companion'}.preview`;
}

export interface WindowPreviewOptions {
  addon: PreviewAddon;
  /** The main window, null when it is not open. */
  window(): BrowserWindow | null;
  log(line: string): void;
}

export class WindowPreview implements PreviewView {
  private readonly options: WindowPreviewOptions;
  private readonly service: string;
  private win: BrowserWindow | null = null;
  private session: PreviewSession<PreviewSurface> | null = null;
  private shown = false;
  private rect: PreviewRect | null = null;
  private readonly inFlight = new Set<PreviewSurface>();

  constructor(options: WindowPreviewOptions) {
    this.options = options;
    const bundle = options.addon.mainBundle();
    this.service = previewService(bundle.identifier);
  }

  place(rect: PreviewRect): void {
    const win = this.options.window();
    if (!win || win.isDestroyed()) return;
    if (win !== this.win) this.attach(win);
    win.webContents.send('preview:place', rect);
    this.shown = true;
    this.rect = rect;
    this.session?.syncPlayback();
  }

  /** Plays `selection` at the output the placed rect takes in device pixels, as the preload sizes its canvas. */
  async load(selection: PreviewSelection): Promise<boolean> {
    if (!this.session) return false;
    // A session lives while its window does.
    const win = this.win!;
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor * win.webContents.getZoomFactor();
    await this.session.load(this.rect ? { ...selection, output: previewOutput(this.rect, scale) } : selection);
    return true;
  }

  sequence(clips: string[], blendSeconds: number[]): Promise<void> {
    if (!this.session) return Promise.reject(new BridgeFailure('unavailable', 'no live preview'));
    return this.session.sequence(clips, blendSeconds);
  }

  hide(): void {
    this.shown = false;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('preview:hide');
    this.session?.syncPlayback();
  }

  private attach(win: BrowserWindow): void {
    this.session?.disconnect();
    this.win = win;
    this.shown = false;
    const active = () => this.shown && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
    const session = this.session = new PreviewSession<PreviewSurface>({
      transport: this.options.addon, service: this.service, log: this.options.log,
      presenter: { get active() { return active(); }, present: (surface, done) => this.present(win, surface, done) },
    });
    const sync = () => session.syncPlayback();
    for (const event of ['show', 'hide', 'minimize', 'restore'] as const) win.on(event as 'show', sync);
    // A new document has no canvas until its page places the preview again.
    win.webContents.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument || this.win !== win) return;
      this.shown = false;
      sync();
    });
    win.on('closed', () => {
      session.disconnect();
      if (this.win !== win) return;
      this.win = null;
      this.session = null;
    });
  }

  /** Imports the frame's IOSurface and hands it to the page; `done` once the page and this process have released it. */
  private present(win: BrowserWindow, surface: PreviewSurface, done: (drawn: boolean) => void): void {
    let drawn = false;
    let imported: Electron.SharedTextureImported;
    // Holding `surface` keeps its IOSurfaceRef alive until the GPU is through with the texture.
    this.inFlight.add(surface);
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: 'bgra', codedSize: { width: surface.width, height: surface.height }, handle: { ioSurface: surface.handle } },
        allReferencesReleased: () => {
          this.inFlight.delete(surface);
          done(drawn);
        },
      });
    } catch (e) {
      this.inFlight.delete(surface);
      this.options.log(`character preview import failed: ${e instanceof Error ? e.message : String(e)}`);
      return done(false);
    }
    void sharedTexture.sendSharedTexture({ frame: win.webContents.mainFrame, importedSharedTexture: imported }).then(
      () => { drawn = true; },
      () => {},
    ).finally(() => imported.release());
  }
}
