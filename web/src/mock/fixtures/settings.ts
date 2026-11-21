import type { PermissionRow, RuntimeInfo } from '../../domain';
import { fromRuntimePublic } from '../../domain/adapt';
import { WIRE_RUNTIME } from './wire/system';

const runtime = fromRuntimePublic(WIRE_RUNTIME);

/** Kernel runtimes, one per backend (`/character/runtime` available_backends + installed_runtimes). */
export const RUNTIMES: RuntimeInfo[] = runtime.runtimes;

/** Selected kernel; must be one of RUNTIMES. */
export const SELECTED_RUNTIME = runtime.selected;

/**
 * System permissions. Screen recording is granted because today's screenshot budget is in use;
 * automation is the one open issue that diag links to.
 */
export const PERMISSIONS: PermissionRow[] = [
  { kind: 'screenRecording', label: '屏幕录制', purpose: '用于屏幕识读', state: 'granted', features: ['屏幕识读', '附上截图', '今日截图额度'] },
  { kind: 'accessibility', label: '辅助功能', purpose: '读窗口文字、操作电脑', state: 'granted', features: ['读窗口文字', '操作电脑'] },
  { kind: 'microphone', label: '麦克风与语音识别', purpose: '按住说话', state: 'granted', features: ['按住说话'] },
  { kind: 'automation', label: '自动化', purpose: '读浏览器网址、跳到终端', state: 'denied', features: ['读浏览器网址', '跳到终端'] },
  { kind: 'notifications', label: '通知', purpose: '系统通知', state: 'granted', features: ['系统通知'] },
];

/** Saved settings values (prototype SDEF), keyed by setting id. */
export const SETTINGS: Record<string, string | number | boolean> = {
  mute: false,
  tts: '远端',
  proactive: '适中',
  speakUp: true,
  rest: true,
  n_done: '只出卡',
  n_appr: '出声',
  n_err: '出声',
  n_brief: '只出卡',
  n_remind: '出声',
  sysnotify: true,
  wintext: true,
  grain: 'focused',
  web: true,
  typing: false,
  agent_sessions: true,
  shot: true,
  keys: true,
  micapp: true,
  mask: true,
  login: true,
  k_ask: true,
  kernel: SELECTED_RUNTIME,
  runsrc: '本机 CLI',
  exe: '/opt/homebrew/bin/codex',
  acct: '本机登录',
  provider: 'OpenAI',
  mainModel: 'gpt-5-codex',
  maxCost: WIRE_RUNTIME.max_budget_usd,
  archive: '不清理',
  svc: 'Anthropic',
  apiBase: 'api.anthropic.com',
  chatModel: 'claude-sonnet-4-5',
  think: '中',
};

/** Settings that need a backend restart to apply (⟳). */
export const RESTART_REQUIRED = ['wintext', 'web', 'typing', 'agent_sessions'];

/** Rows that delete collected data when switched off, with how much. */
export const DESTRUCTIVE_COUNTS: Record<string, number> = { wintext: 214, web: 37, typing: 0, agent_sessions: 0 };


/** Redaction counts since this launch. */
export const REDACTIONS: Array<{ label: string; count: number }> = [
  { label: '密钥', count: 2 },
  { label: '邮箱', count: 5 },
  { label: '电话', count: 0 },
];

export { SETTING_GROUPS } from '../../pages/settings/groups';
