// `photo.*`: the 拍照 overlay page's state and input; only that page is served.
import type { Region } from './desktop';
import type { Unsubscribe } from './protocol';

export interface PhotoOverlayState {
  /** Her figure in page points. */
  anchor: Region;
  /** Both her renderer and this app list C3 `photo` (aperture and focus) and `capture` (the shutter). */
  photo: boolean;
  capture: boolean;
}

/** The f-number (1.4–32) and the focus (`auto`, or 0.1–10 m). */
export interface PhotoSettings {
  aperture: number;
  focus: 'auto' | number;
}

export interface PhotoOps {
  /** The state of this opening first; the next opening sends another. */
  onState(cb: (s: PhotoOverlayState) => void): Unsubscribe;
  set(s: PhotoSettings): Promise<void>;
  /** Saves a PNG of her on a transparent background (C3 `capture`) and resolves with its file name. */
  capture(): Promise<{ file: string }>;
  /** Ends the photo state and hides the overlay. */
  close(): Promise<void>;
}
