// `resize.*`: the 调整大小 overlay page's state and input; only that page is served.
import type { Region } from './desktop';
import type { Unsubscribe } from './protocol';

export type ResizeCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface ResizeOverlayState {
  /** Her frame in page points. */
  frame: Region;
  scale: number;
  /** 最小 at 50 %, 最大 at 200 %. */
  limit: 'min' | 'max' | null;
  /** The handle being dragged. */
  dragging: ResizeCorner | null;
}

/** 恢复默认, 完成 and leaving without saving. */
export type ResizeAction = 'restoreDefault' | 'done' | 'cancel';

export interface ResizeOps {
  /** The current state first, then each change. */
  onState(cb: (s: ResizeOverlayState) => void): Unsubscribe;
  /** The pointer's travel since the press on `corner`'s handle, in page points (y down). */
  drag(corner: ResizeCorner, dx: number, dy: number): Promise<void>;
  endDrag(): Promise<void>;
  act(action: ResizeAction): Promise<void>;
}
