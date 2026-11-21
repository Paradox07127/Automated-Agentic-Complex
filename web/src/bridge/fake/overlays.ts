// What the fake bridge shows on the 调整镜头, 调整大小 and 电脑操作 pages, which native fills with its own state.
import type { CameraOverlayState } from '../camera';
import type { ComputerUsePanel } from '../computerUse';
import type { ResizeOverlayState } from '../resize';

/** Her frame on a 960×640 page. */
const FRAME = { x: 450, y: 40, width: 180, height: 280 };

export const CAMERA_DEMO: CameraOverlayState = {
  area: FRAME,
  value: { yaw: 12, pitch: -4, zoom: 1.6 },
  editing: true,
  closeup: true,
};

export const RESIZE_DEMO: ResizeOverlayState = { frame: FRAME, scale: 1.2, limit: null, dragging: null };

export const COMPUTER_DEMO: ComputerUsePanel = {
  phase: 'waitingPermission',
  targetApp: 'Safari',
  action: '在「设置」里打开「通知」，关掉邮件的横幅提醒',
  scopeChips: ['Safari 当前窗口', '本次会话', '15 分钟'],
  permissions: { observation: 'allowed', text: 'off', image: 'off', control: 'off' },
  pendingGrants: [],
  showsPermissionChoices: true,
  canResume: false,
  challenge: 'demo',
};
