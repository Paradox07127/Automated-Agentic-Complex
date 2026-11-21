import type { OnboardingPermissionKind } from '../../bridge';

export const ONBOARDING_PERMISSIONS: Array<{ kind: OnboardingPermissionKind; title: string; purpose: string; promptsOnFirstUse: boolean }> = [
  { kind: 'screenRecording', title: '屏幕录制', purpose: '用于屏幕识读和窗口截图，仅在屏幕识读时截取', promptsOnFirstUse: false },
  { kind: 'accessibility', title: '辅助功能', purpose: '读取焦点控件和选中文字；读取范围在隐私设置中另选', promptsOnFirstUse: false },
  { kind: 'microphone', title: '麦克风与语音识别', purpose: '按住右 Option 说话；首次按下热键时由系统询问', promptsOnFirstUse: true },
  { kind: 'automation', title: '自动化', purpose: '检测「终端」授权，用于跳转终端会话。Safari 和 Chrome 的授权独立。', promptsOnFirstUse: true },
  { kind: 'loginItem', title: '登录时启动', purpose: '开机后角色自动出现，可在 设置 › 启动与关于 关闭', promptsOnFirstUse: false },
];
