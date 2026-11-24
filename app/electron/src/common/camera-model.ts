// The camera as config.json keeps it, as a gesture moves it and as 调整镜头's camera mode edits it, and the
// `set_render` groups of the saved settings.

export interface CameraValue { yaw: number; pitch: number; zoom: number }

const YAW: [number, number] = [-180, 180];
const PITCH: [number, number] = [-20, 20];
const ZOOM: [number, number] = [1, 4];
/** Degrees of yaw and pitch per point dragged. */
const DEGREES_PER_POINT = 0.4;
export const CAMERA_KEYS = ['render_camera_yaw', 'render_camera_pitch', 'render_camera_zoom'] as const;

const clamp = (x: number, [low, high]: [number, number]) => Math.min(Math.max(x, low), high);
/** Halves away from zero. */
const round = (x: number) => Math.sign(x) * Math.round(Math.abs(x));
const toHalf = (x: number) => round(x * 2) / 2;

export const clampCamera = (v: CameraValue): CameraValue => ({ yaw: clamp(v.yaw, YAW), pitch: clamp(v.pitch, PITCH), zoom: clamp(v.zoom, ZOOM) });

/** `v` after one C3 `camera_gesture` event (rule 49 (h)): `dx`, `dy` in screen points, right and down positive; `zoom`
 *  multiplies the zoom. Clamped. */
export function gestured(v: CameraValue, dx: number, dy: number, zoom: number): CameraValue {
  return clampCamera({ yaw: v.yaw + dx * DEGREES_PER_POINT, pitch: v.pitch - dy * DEGREES_PER_POINT, zoom: v.zoom * zoom });
}

/** Yaw and pitch to 0.5°, as 完成 stores them. */
export const committed = (v: CameraValue): CameraValue => clampCamera({ yaw: toHalf(v.yaw), pitch: toHalf(v.pitch), zoom: v.zoom });

/** The config.json values. */
export const cameraSettings = (v: CameraValue): Record<string, number> =>
  ({ render_camera_yaw: v.yaw, render_camera_pitch: v.pitch, render_camera_zoom: v.zoom });

/** Zoom grows by `exp(k · deltaY)` per scroll. */
const ZOOM_PER_SCROLL_POINT = 0.01;
/** Zoom grows by `1 + gain · magnification` per pinch event. */
const MAGNIFY_GAIN = 1;

export type CameraPhase = 'editing' | 'committed' | 'cancelled';

export interface CameraModeCallbacks {
  /** Every live value while editing. */
  onChange(v: CameraValue): void;
  /** The final value, yaw and pitch to 0.5°, once, on 完成 or Return. */
  onCommit(v: CameraValue): void;
  /** The entry value, once, on a cancel after something was sent live. */
  onCancel(v: CameraValue): void;
  /** After a commit or a cancel. */
  onFinish(): void;
}

/** Camera mode: a drag turns her, scroll and pinch zoom, 全身 / 近景 / 复位 / 完成. */
export class CameraMode {
  readonly initial: CameraValue;
  /** The host's close-up zoom, clamped; null until it reports one. */
  readonly closeupZoom: number | null;
  value: CameraValue;
  dragging = false;
  phase: CameraPhase = 'editing';
  private moved = false;
  private readonly c: CameraModeCallbacks;

  constructor(value: CameraValue, closeupZoom: number | null, callbacks: CameraModeCallbacks) {
    this.initial = this.value = clampCamera(value);
    this.closeupZoom = closeupZoom === null ? null : clamp(closeupZoom, ZOOM);
    this.c = callbacks;
  }

  get closeupEnabled(): boolean { return this.closeupZoom !== null && this.phase === 'editing'; }

  /** `dx`, `dy`: pointer movement since the last call, in points (y up). */
  drag(dx: number, dy: number): void {
    if (this.phase !== 'editing') return;
    this.dragging = true;
    this.apply(gestured(this.value, dx, -dy, 1));
  }

  endDrag(): void { this.dragging = false; }

  /** `deltaY` in points; positive zooms in. */
  scroll(deltaY: number): void { this.setZoom(this.value.zoom * Math.exp(deltaY * ZOOM_PER_SCROLL_POINT)); }

  /** `magnification` as `NSEvent.magnification` reports it. */
  magnify(magnification: number): void { this.setZoom(this.value.zoom * Math.max(1 + magnification * MAGNIFY_GAIN, 0)); }

  /** 全身. */
  fullBody(): void { this.setZoom(1); }

  /** 近景: nothing before the host reports a close-up zoom. */
  closeup(): void { if (this.closeupZoom !== null) this.setZoom(this.closeupZoom); }

  /** 复位. */
  reset(): void { if (this.phase === 'editing') this.apply({ yaw: 0, pitch: 0, zoom: 1 }); }

  /** Esc or a click outside: back to the entry value, no commit. */
  cancel(): void {
    if (this.phase !== 'editing') return;
    this.dragging = false;
    this.value = this.initial;
    this.phase = 'cancelled';
    if (this.moved) this.c.onCancel(this.initial);
    this.c.onFinish();
  }

  /** 完成 or Return. */
  commit(): void {
    if (this.phase !== 'editing') return;
    this.dragging = false;
    this.value = committed(this.value);
    this.phase = 'committed';
    this.c.onCommit(this.value);
    this.c.onFinish();
  }

  private setZoom(zoom: number): void {
    if (this.phase === 'editing') this.apply({ ...this.value, zoom });
  }

  private apply(next: CameraValue): void {
    const v = clampCamera(next), old = this.value;
    if (v.yaw === old.yaw && v.pitch === old.pitch && v.zoom === old.zoom) return;
    this.value = v;
    this.moved = true;
    this.c.onChange(v);
  }
}

/** The receiving area is her visual box grown by this. */
const AREA_OUTSET = 24;

/** The receiving area in the top-left space of a page covering `visible`; both rects y up. */
export function cameraArea(visual: { x: number; y: number; w: number; h: number }, visible: { x: number; y: number; w: number; h: number }):
  { x: number; y: number; width: number; height: number } {
  const x = visual.x - AREA_OUTSET, top = visual.y + visual.h + AREA_OUTSET;
  return { x: x - visible.x, y: visible.y + visible.h - top, width: visual.w + 2 * AREA_OUTSET, height: visual.h + 2 * AREA_OUTSET };
}

/** A number in `range` to the nearest 0.5; 0 otherwise. */
function degrees(raw: unknown, range: [number, number]): number {
  const value = typeof raw === 'number' ? raw : NaN;
  const half = toHalf(value);
  return Number.isFinite(half) && half >= range[0] && half <= range[1] ? half : 0;
}

const zoomOf = (s: Record<string, unknown>) => {
  const z = s.render_camera_zoom;
  return typeof z === 'number' && z >= ZOOM[0] && z <= ZOOM[1] ? z : 1;
};

/** The camera config.json holds. */
export const savedCamera = (s: Record<string, unknown>): CameraValue =>
  ({ yaw: degrees(s.render_camera_yaw, YAW), pitch: degrees(s.render_camera_pitch, PITCH), zoom: zoomOf(s) });

/** The `set_render` groups (C3 rules 43, 49) with the values the renderer's launch arguments take from the same settings;
 *  HostLink.sendSetRender drops what the avatar does not list. */
export function liveRenderPayload(s: Record<string, unknown>): Record<string, unknown> {
  const option = (key: string, allowed: string[], fallback: string) => (allowed.includes(s[key] as string) ? s[key] as string : fallback);
  const flag = (key: string, fallback: boolean) => (typeof s[key] === 'boolean' ? s[key] as boolean : fallback);
  const camera = savedCamera(s);
  return {
    camera: { mode: option('render_camera_mode', ['show', 'overview', 'document'], 'show'), yaw: camera.yaw, pitch: camera.pitch,
      zoom: camera.zoom, sway: flag('render_camera_sway', false), track: option('render_camera_track', ['off', 'stage'], 'stage'),
      framing: s.stay_mode === 'bust' ? 'bust' : 'full' },
    light: { yaw: Number(option('render_light_yaw', ['-15', '0', '15'], '0')), pitch: Number(option('render_light_pitch', ['-10', '0', '10'], '0')),
      strength: Number(option('render_light_strength', ['0.5', '0.75', '1', '1.25', '1.5'], '1')) },
    outline: option('render_outline', ['original', 'subtle', 'contrast'], 'original'),
    facing: option('render_facing_mode', ['auto', 'front', 'side', 'back'], 'auto'),
    grounding: { mode: option('render_ground_shadow', ['off', 'contact', 'cast'], 'cast') },
    ambient: { mode: option('render_ambient', ['off', 'wallpaper', 'screen'], 'off'), light_wrap: flag('render_light_wrap', false) },
    dof: { mode: option('render_dof', ['off', 'closeup'], 'off') },
  };
}
