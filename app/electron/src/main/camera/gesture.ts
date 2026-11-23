// Her camera as the user moves it: ⌘ drag, ⌘ wheel or pinch on her (C3 rule 49 (h)
// `camera_gesture`) and 调整镜头's camera mode go out as live values and are saved to config.json at the end.
import type { Box, C3Message } from '../../common/c3.ts';
import { CAMERA_KEYS, type CameraValue, cameraSettings, committed, gestured, savedCamera } from '../../common/camera-model.ts';
import type { CameraGesture, CommandResult } from '../renderer/link.ts';
import { sendLiveRender } from '../renderer/saved.ts';

/** 调整镜头's window; it calls `live`, `cancelled` and `commit` of AvatarCamera. */
export interface CameraOverlay {
  /** Camera mode is open. */
  readonly open: boolean;
  /** Enters camera mode on her `visual` box in C3 global points; `closeupZoom` is null until the host reports one. */
  begin(visual: Box, value: CameraValue, closeupZoom: number | null): void;
}

export interface CameraPorts {
  link: {
    /** The avatar's hello capabilities. */
    readonly capabilities: string[];
    readonly lastPipeline: C3Message | null;
    sendCameraLive(yaw: number, pitch: number, zoom: number): boolean;
    sendSetRender(payload: Record<string, unknown>, onResult?: (r: CommandResult) => void): boolean;
  } | null;
  /** config.json as saved now; `{}` when it cannot be read. */
  settings(): Record<string, unknown>;
  /** config.json; throws when it cannot be read. */
  load(): Record<string, unknown>;
  /** Merges `values` into config.json as a settings save does; throws when it is not written. */
  save(values: Record<string, string | number>): void;
  /** Tells open settings pages which config.json keys changed. */
  settingsChanged?(keys: string[]): void;
  restartAvatar(): void;
  /** Her figure's box in C3 global points; null without one. */
  figure(): Box | null;
  overlay: CameraOverlay | null;
  log(line: string): void;
}

export class AvatarCamera {
  private readonly ports: CameraPorts;
  /** The camera of the open `camera_gesture`; null between gestures. */
  private gestureValue: CameraValue | null = null;

  constructor(ports: CameraPorts) {
    this.ports = ports;
  }

  /** 调整镜头: camera mode starts on her figure at the camera config.json holds. False when the
   *  avatar does not list `camera_free` or has no figure. */
  begin(): boolean {
    const { link, overlay } = this.ports;
    const visual = this.ports.figure();
    if (!link?.capabilities.includes('camera_free') || overlay === null || visual === null) return false;
    const zoom = ((link.lastPipeline?.render as { camera?: { closeup_zoom?: unknown } } | undefined)?.camera)?.closeup_zoom;
    overlay.begin(visual, savedCamera(this.ports.settings()), typeof zoom === 'number' && zoom >= 1 && zoom <= 4 ? zoom : null);
    return true;
  }

  /** Starts at the camera config.json holds, goes out as camera mode's live values do and is saved at `ended` as 完成
   *  saves. Ignored while camera mode is open. */
  gesture(g: CameraGesture): void {
    if (this.ports.overlay?.open) {
      this.gestureValue = null;
      return;
    }
    const start = g.phase !== 'began' && this.gestureValue !== null ? this.gestureValue : savedCamera(this.ports.settings());
    const value = gestured(start, g.dx, g.dy, g.zoom);
    if (g.phase === 'ended') {
      this.gestureValue = null;
      this.commit(committed(value));
      return;
    }
    this.gestureValue = value;
    if (value.yaw !== start.yaw || value.pitch !== start.pitch || value.zoom !== start.zoom) this.live(value);
  }

  /** Camera mode's live value. */
  live(v: CameraValue): void {
    this.ports.link?.sendCameraLive(v.yaw, v.pitch, v.zoom);
  }

  /** Camera mode cancelled after a live value went out: the saved camera again. */
  cancelled(): void {
    this.sendSaved([], this.ports.settings());
  }

  /** 完成: writes the camera keys to config.json, tells open settings pages and sends the saved settings live. */
  commit(v: CameraValue): void {
    let old: Record<string, unknown>;
    try {
      old = this.ports.load();
    } catch {
      return this.ports.log('camera: config.json unreadable, not saved');
    }
    const changes = Object.fromEntries(Object.entries(cameraSettings(v)).filter(([key, value]) => old[key] !== value));
    if (Object.keys(changes).length > 0) {
      try {
        this.ports.save(changes);
      } catch (e) {
        return this.ports.log(`camera: config.json not written: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.ports.settingsChanged?.(Object.keys(changes).sort());
    }
    // Live samples moved her even when the save changed nothing.
    this.sendSaved(CAMERA_KEYS.filter((key) => key in changes), { ...old, ...changes });
  }

  /** The saved settings as one `set_render` with `req`; restarts the avatar when that fails, as a settings save does. */
  private sendSaved(keys: string[], settings: Record<string, unknown>): void {
    sendLiveRender(this.ports.link, settings, keys, () => this.ports.restartAvatar(), (line) => this.ports.log(`camera ${line}`));
  }
}
