import type { VisualStateKey } from '../../domain/states';

/** Run states of /memory/runs (memory_service.py). */
export const RUN_STATE: Readonly<Record<string, string>> = {
  running: '进行中',
  completed: '完成',
  committed: '已写入',
  no_new_knowledge: '无新增',
  rejected: '校验未通过',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const RUN_LAMP: Readonly<Record<string, VisualStateKey>> = {
  running: 'running',
  completed: 'ok',
  committed: 'ok',
  no_new_knowledge: 'idle',
  rejected: 'failed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

/** The result lamp of a memory run. */
export const runLamp = (state: string): { state: VisualStateKey; label: string } => ({ state: RUN_LAMP[state] ?? 'idle', label: RUN_STATE[state] ?? '其他状态' });

export const isBad = (state: string) => state === 'failed' || state === 'rejected';

/** Runtime backends (integration.py available_backends). */
export const BACKEND: Readonly<Record<string, string>> = { claude_agent_sdk: 'Claude Agent SDK', codex: 'Codex', pi: 'Pi', acp: 'ACP', claude: 'Claude Code' };

/** Observation request modes and results (server.py OBSERVED, capture.py settle reasons). */
export const MODE: Readonly<Record<string, string>> = { image: '截图', text: '窗口文字', ocr: '识字' };
export const OBS_RESULT: Readonly<Record<string, { state: VisualStateKey; label: string }>> = {
  ready: { state: 'ok', label: '成功' },
  failed: { state: 'failed', label: '失败' },
  declined: { state: 'idle', label: '拒绝' },
  unavailable: { state: 'idle', label: '不可用' },
  expired: { state: 'cancelled', label: '过期' },
  cancelled: { state: 'cancelled', label: '取消' },
};
export const OBS_REASON: Readonly<Record<string, string>> = {
  blacklisted: '命中排除名单',
  incognito: '隐私/无痕窗口',
  budget: '截图额度已用尽',
  timeout: '超时',
  paused: '观察暂停中',
  secure_input: '正在输入密码',
  capture_failed: '截图失败',
  permission_denied: '未授予截图权限',
  window_gone: '窗口已关闭',
  vision_error: '视觉模型异常',
  policy_changed: '隐私设置已变更',
  turn_cancelled: '本轮已取消',
  deleted: '已删除',
};
