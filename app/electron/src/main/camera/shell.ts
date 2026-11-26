// The camera and the poses as index.ts wires them to the host link: `camera_gesture` and 调整镜头 save the camera, the session panel drives
// the close-up, her lists and `pose_state` feed the poses.
import type { Box } from '../../common/c3.ts';
import { readObject } from '../ops/settings.ts';
import type { HostLink, OfferedCapability } from '../renderer/link.ts';
import { CameraCloseupDriver, type SessionsWindow, watchSessionsShown } from './closeup.ts';
import { AvatarCamera, type CameraOverlay, type CameraPorts } from './gesture.ts';
import type { CameraTarget } from './overlay.ts';
import { type AvatarPoses, linkPoses, poseMenuActions } from './pose.ts';

/** This shell sends `zoom`, `live` and `closeup`. */
export const CAMERA_OFFERS: readonly OfferedCapability[] = ['camera_free'];

export interface ShellCameraOptions {
  link: Pick<HostLink, 'connected' | 'capabilities' | 'lastPipeline' | 'sendCameraLive' | 'sendSetRender' | 'sendCloseup' | 'sendSetPose' | 'on'>;
  configPath: string;
  avatarPid(): number | null | undefined;
  /** Merges `values` into config.json as a settings save does; throws when not written. */
  save(values: Record<string, string | number>): void;
  /** Tells open settings pages which config.json keys changed. */
  settingsChanged?(keys: string[]): void;
  restartAvatar(): void;
  /** Her figure's box in C3 global points; null without one. */
  figure(): Box | null;
  /** Makes 调整镜头's window (overlay.ts `CameraOverlayWindow`) on the camera its values go to; null while there is none. */
  overlay: ((camera: CameraTarget) => CameraOverlay) | null;
  log(line: string): void;
}

export interface ShellCamera {
  camera: AvatarCamera;
  closeup: CameraCloseupDriver;
  /** Give its `state` the link's onPoseState. */
  poses: AvatarPoses;
  /** The menu's 姿态 items and 锁定当前姿态. */
  poseActions: ReturnType<typeof poseMenuActions>;
  /** Each main window: its sessions page drives the close-up. */
  mainWindow(win: SessionsWindow): void;
  stop(): void;
}

export function shellCamera(o: ShellCameraOptions): ShellCamera {
  const settings = () => {
    try {
      return readObject(o.configPath);
    } catch (e) {
      o.log(`camera: config.json unreadable: ${e instanceof Error ? e.message : String(e)}`);
      return {};
    }
  };
  const ports: CameraPorts = { link: o.link, settings, load: () => readObject(o.configPath), save: o.save, settingsChanged: o.settingsChanged,
    restartAvatar: o.restartAvatar, figure: o.figure, overlay: null, log: o.log };
  const camera = new AvatarCamera(ports);
  ports.overlay = o.overlay?.(camera) ?? null;
  const closeup = new CameraCloseupDriver({ setting: () => settings().render_camera_auto_closeup, link: o.link, avatarPid: o.avatarPid });
  const poses = linkPoses({ link: o.link, configPath: o.configPath, log: o.log });
  return {
    camera, closeup, poses, poseActions: poseMenuActions(poses, o.log),
    mainWindow: (win) => watchSessionsShown(win, (shown) => closeup.panel(shown)),
    stop: () => closeup.stop(),
  };
}
