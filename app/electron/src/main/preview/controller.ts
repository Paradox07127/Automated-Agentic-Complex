// `avatar.preview.*` over the main window's preview: the current character, playing the
// first archive clip of the action or her idle.
import { BridgeFailure } from '../../common/bridge.ts';
import type { PreviewHost, PreviewRect } from '../ops/preview.ts';
import type { MotionLibrary } from './library.ts';
import type { PreviewSelection } from './session.ts';

/** The preview in the main window. */
export interface PreviewView {
  /** Shows the preview over `rect`, CSS px of the page's viewport; nothing without a window. */
  place(rect: PreviewRect): void;
  /** Plays `selection` in the placed preview; true once it is drawn, false without a preview. */
  load(selection: PreviewSelection): Promise<boolean>;
  /** Preview XPC v2 `sequence` in the drawn preview; `unavailable` without one. */
  sequence(clips: string[], blendSeconds: number[]): Promise<void>;
  hide(): void;
}

export interface PreviewControllerOptions {
  view: PreviewView;
  /** The avatar's character, null before one is known, and her appearance. */
  avatar(): { character: string | null; appearance: string | null };
  /** The character's motion library; null when the library does not have her. */
  library(character: string): Promise<MotionLibrary | null>;
  /** The character's remembered mod settings by appearance (`avatar.modSettings.*`). */
  modSettings?(character: string): Record<string, Record<string, number>>;
}

const hostError = (text: string) => new BridgeFailure('failed', text);

export class PreviewController implements PreviewHost {
  private readonly options: PreviewControllerOptions;
  private readonly libraries = new Map<string, Promise<MotionLibrary | null>>();
  private request = 0;

  constructor(options: PreviewControllerOptions) {
    this.options = options;
  }

  async show(rect: PreviewRect, action: string | null, loop: boolean, revision: number): Promise<boolean> {
    this.request += 1;
    const expected = this.request;
    this.options.view.place(rect);
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
      if (this.request === expected) this.libraries.delete(id);
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
    // The desktop's mod settings, so the preview draws her the same.
    const mods = this.options.modSettings?.(id) ?? {};
    return this.options.view.load({ bundle: library.bundle, sha256: library.sha256, character: library.character, clip, facial: null,
      rate: 1, appearance: avatar.appearance, request: revision, modSettings: Object.keys(mods).length > 0 ? mods : null,
      loop: loop && clip !== null });
  }

  hide(): void {
    this.request += 1;
    this.options.view.hide();
  }

  sequence(clips: string[], blendSeconds: number[]): Promise<void> {
    return this.options.view.sequence(clips, blendSeconds);
  }
}
