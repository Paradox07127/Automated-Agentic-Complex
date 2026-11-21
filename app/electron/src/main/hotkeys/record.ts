// 录热键 for the settings page: the next hot key pressed in the main window, read from its
// contents' `before-input-event`, one recording at a time. Right Option alone counts once it is released with no modifier
// down, as the platform helper's `input.modifiers` reads them.
import type { Input, WebContents } from 'electron';
import { type KeyInput, recordedHotkey } from '../../common/desktop-hotkey.ts';
import type { HelperReply } from '../helper/client.ts';

/** Chromium's codes of the keys macOS reports as flagsChanged, which the recorder leaves to the page. */
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'CapsLock']);
const TIMEOUT_MS = 15_000;

export interface HotkeyRecorderOptions {
  /** The main window's contents; null while it is closed, which records nothing. */
  contents(): Pick<WebContents, 'on' | 'off' | 'isDestroyed'> | null;
  /** The C12 platform helper; null without one, which records no right Option. */
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperReply> } | null;
  clock?: { after(ms: number, fn: () => void): () => void };
}

export class HotkeyRecorder {
  private readonly o: HotkeyRecorderOptions;
  private session: { id: number; finish(name: string | null): void } | null = null;
  private lastId = 0;

  constructor(o: HotkeyRecorderOptions) {
    this.o = o;
  }

  /** The config.json name of the next hot key; null on Esc, after 15 s, when another recording starts, when the page goes
   *  (navigation, crash or close) and on `cancel`. */
  record(rightOption: boolean): Promise<string | null> {
    this.cancel();
    const contents = this.o.contents();
    if (!contents || contents.isDestroyed()) return Promise.resolve(null);
    this.lastId += 1;
    const id = this.lastId;
    const after = this.o.clock?.after ?? ((ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
    return new Promise((resolve) => {
      let pending = false;
      let stopTimer = () => {};
      const finish = (name: string | null) => {
        if (this.session?.id !== id) return;
        this.session = null;
        stopTimer();
        if (!contents.isDestroyed()) {
          contents.off('before-input-event', onInput);
          contents.off('did-start-navigation', onNavigation);
          contents.off('render-process-gone', gone);
          contents.off('destroyed', gone);
        }
        resolve(name);
      };
      const released = async () => {
        const reply = await this.o.helper?.request('input.modifiers');
        if (!reply?.ok) return;
        const { alt, shift, control, meta } = reply.result;
        if (!alt && !shift && !control && !meta) finish('right_option');
      };
      /** True keeps the event from the page. */
      const feed = (input: KeyInput): boolean => {
        if (rightOption && input.code === 'AltRight') {
          const alone = !input.control && !input.shift && !input.meta;
          if (input.type === 'keyDown' && input.alt && alone) {
            pending = true;
          } else {
            if (input.type === 'keyUp' && pending) void released();
            pending = false;
          }
          return false;
        }
        pending = false;
        if (input.type !== 'keyDown' || MODIFIER_CODES.has(input.code)) return false;
        if (input.code === 'Escape') {
          finish(null);
          return true;
        }
        const name = recordedHotkey(input);
        if (name !== null) finish(name);
        return true;
      };
      const onInput = (e: { preventDefault(): void }, input: Input) => {
        if (feed(input)) e.preventDefault();
      };
      const onNavigation = (d: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (d.isMainFrame && !d.isSameDocument) finish(null);
      };
      const gone = () => finish(null);
      this.session = { id, finish };
      contents.on('before-input-event', onInput);
      contents.on('did-start-navigation', onNavigation);
      contents.on('render-process-gone', gone);
      contents.on('destroyed', gone);
      stopTimer = after(TIMEOUT_MS, () => finish(null));
    });
  }

  /** Ends the recording in progress with null. */
  cancel(): void {
    this.session?.finish(null);
  }
}
