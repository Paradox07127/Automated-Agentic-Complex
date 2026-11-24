// `avatar.preview.*` over the main window's preview: the current character, playing the
// first archive clip of the action or her idle.
import { BridgeFailure } from '../../common/bridge.ts';
import type { EventSource } from '../../common/page.ts';
import type { PreviewHost, PreviewRect } from '../ops/preview.ts';
import type { MotionLibrary } from './library.ts';
import type { CameraView, PreviewSelection } from './session.ts';

/** The preview in the main window. */
export interface PreviewView {
  /** Shows the preview over `rect`, CSS px of the page's viewport; nothing without a window. */
  place(rect: PreviewRect): void;
  /** Plays `selection` in the placed preview; true once it is drawn, false without a preview. */
  load(selection: PreviewSelection): Promise<boolean>;
  /** Preview `sequence` in the drawn preview; `unavailable` without one. */
  sequence(clips: string[], blendSeconds: number[]): Promise<void>;
  /** Preview `view`; nothing without a preview. */
  view(v: CameraView): void;
  hide(): void;
  /** `{fraction}` while a load builds anew, null once none does. */
  readonly progress: EventSource;
}

export interface PreviewControllerOptions {
  view: PreviewView;
  /** The avatar's character, null before one is known, her appearance and the layer ids she has hidden. */
  avatar(): { character: string | null; appearance: string | null; hiddenLayers?: string[] };
  /** The character's motion library; null when the library does not have her. */
  library(character: string): Promise<MotionLibrary | null>;
  /** The character's remembered mod settings by appearance (`avatar.modSettings.*`). */
  modSettings?(character: string): Record<string, Record<string, number>>;
  /** The desktop renderer's lookArguments from the saved settings; absent leaves the service's own. */
  renderArgs?(): string[];
}

const hostError = (text: string) => new BridgeFailure('failed', text);

/** ms a new stage size has to hold before the view loads at it: the stage's transitions run 300 ms, and each output the
 *  service has not drawn builds its actor again. */
const SIZE_SETTLE_MS = 150;

export class PreviewController implements PreviewHost {
  private readonly options: PreviewControllerOptions;
  private readonly libraries = new Map<string, Promise<MotionLibrary | null>>();
  private request = 0;
  /** The rect placed last, null after a hide. */
  private placed: PreviewRect | null = null;

  constructor(options: PreviewControllerOptions) {
    this.options = options;
  }

  get progress(): EventSource {
    return this.options.view.progress;
  }

  async show(rect: PreviewRect, action: string | null, loop: boolean, revision: number): Promise<boolean> {
    this.request += 1;
    const expected = this.request;
    const resized = this.placed !== null && (this.placed.w !== rect.w || this.placed.h !== rect.h);
    this.placed = rect;
    this.options.view.place(rect);
    // The canvas follows each rect at once; the load waits until the size stops changing, and a newer show takes over.
    if (resized) {
      await new Promise((r) => setTimeout(r, SIZE_SETTLE_MS));
      if (this.request !== expected) return false;
    }
    const id = this.options.avatar().character;
    if (id === null) throw hostError('角色还没连上');
    let task = this.libraries.get(id) ?? this.options.library(id);
    this.libraries.set(id, task);
    let library: MotionLibrary | null;
    try {
      library = await task;
      if (action !== null && library?.clips.some((c) => c.actionID === action) !== true && this.request === expected) {
        task = this.options.library(id);
        this.libraries.set(id, task);
        library = await task;
      }
    } catch (e) {
      if (this.libraries.get(id) === task) this.libraries.delete(id);
      throw e;
    }
    const avatar = this.options.avatar();
    if (this.request !== expected || avatar.character !== id) return false;
    if (library === null) throw hostError('这个角色没有可预览的动作');
    let clip: string | null = null;
    if (action !== null) {
      const found = library.clips.find((c) => c.actionID === action);
      if (!found) throw hostError('这个动作不能单独预览');
      clip = found.clip;
    }
    // The desktop's mod settings and render arguments as of now, so the preview draws her the same; the page shows again when
    // it changes them.
    const mods = this.options.modSettings?.(id) ?? {};
    const renderArgs = this.options.renderArgs?.();
    return this.options.view.load({ bundle: library.bundle, sha256: library.sha256, character: library.character, clip, facial: null,
      rate: 1, appearance: avatar.appearance, request: revision, modSettings: Object.keys(mods).length > 0 ? mods : null,
      loop: loop && clip !== null, ...(renderArgs && { renderArgs }),
      ...(avatar.hiddenLayers?.length ? { hiddenLayers: avatar.hiddenLayers } : {}) });
  }

  hide(): void {
    this.request += 1;
    this.placed = null;
    this.options.view.hide();
  }

  /** A package was published, removed or baked again (the avatar restarts after each): the next show reads the library anew. */
  packagesChanged(): void {
    this.libraries.clear();
  }

  sequence(clips: string[], blendSeconds: number[]): Promise<void> {
    return this.options.view.sequence(clips, blendSeconds);
  }

  view(v: CameraView): void {
    this.options.view.view(v);
  }
}
