// `camera.*`: the 调整镜头 overlay page's state and input; only that page is served.
import type { Region } from './desktop';
import type { Unsubscribe } from './protocol';

/** The camera as config.json keeps it: degrees and a zoom of 1 to 4. */
export interface CameraValue {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface CameraOverlayState {
  /** The receiving area over her, in page points. */
  area: Region;
  value: CameraValue;
  /** 全身, 复位 and 完成 may be clicked. */
  editing: boolean;
  /** 近景 may be clicked: the host reported a close-up zoom. */
  closeup: boolean;
}

/** 全身, 近景, 复位, 完成 and leaving without saving. */
export type CameraAction = 'fullBody' | 'closeup' | 'reset' | 'commit' | 'cancel';

export interface CameraOps {
  /** The current state first, then each change. */
  onState(cb: (s: CameraOverlayState) => void): Unsubscribe;
  /** Pointer travel since the last call over the area, in page points (y down). */
  drag(dx: number, dy: number): Promise<void>;
  endDrag(): Promise<void>;
  /** Points; positive zooms in. */
  scroll(deltaY: number): Promise<void>;
  /** A pinch step, positive zooms in. */
  magnify(magnification: number): Promise<void>;
  act(action: CameraAction): Promise<void>;
}
