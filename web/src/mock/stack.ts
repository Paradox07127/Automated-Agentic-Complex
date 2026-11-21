// Desktop stack mocks. The fake bridge pushes these on `stack.onCards`: in the app the shell feeds the
// stack from /approvals, /agent/interactions, deliveries and notifications. Cards derive from PENDING.
import {
  APPROVALS,
  DELIVERIES,
  NOW,
  PENDING,
  pick,
  SECOND,
  TASKS,
  at,
  SESSIONS,
  WIRE_INTERACTION_APPROVAL,
  WIRE_INTERACTION_APPROVAL_DANGER,
} from './fixtures';
import type { BridgeError, DesktopStackCard, StackPayload } from '../bridge/protocol';
import { fromInteraction, type StackCard, type StackHistoryEntry } from '../domain';
import { presetFor } from '../surfaces/stack/demos';
import { A1, A2, A3, DLV_T4_V1, Q1, S_5E10, S_9A41, S_C07A, S_D0C2, T2, T3, T6 } from './fixtures/ids';

const t6 = pick(TASKS, T6);
const sessionTask = (sessionId: string | null) => SESSIONS.find((s) => s.own && s.id === sessionId)?.task_id ?? null;

function pendingCards(): StackCard[] {
  return PENDING.map((p): StackCard => {
    if (p.kind === 'approval') {
      const ext = p.task_id ? pick(TASKS, p.task_id).source === 'ext' : SESSIONS.find((s) => s.display_session === p.display_session)?.kind === 'ext';
      return { id: p.id, kind: 'approval', at: p.since, item: p, session: ext ? 'terminal' : 'task', task_id: sessionTask(p.session_id) };
    }
    if (p.kind === 'question') return { id: p.id, kind: 'question', at: p.since, item: p };
    return {
      id: p.id,
      kind: 'review',
      source: 'delivery',
      at: p.since,
      item: p,
      delivery: pick(DELIVERIES, p.delivery_id),
      summary: '按项目分组：Companion 58、agentd 41、渲染管线 29、其他 14。',
      lifeS: 36,
      lifeTotalS: 60,
    };
  });
}

const delivery: StackCard = {
  id: 'n-dlv-t4',
  kind: 'delivery',
  at: at(14, 31, 50),
  delivery: pick(DELIVERIES, DLV_T4_V1),
  title: 'Metal 渲染基准报告已完成',
  summary: '60 fps 下 P95 帧时间 17.9 ms，比上周降 2.1 ms。阴影精度「高」时 GPU 每帧 11.8 ms，建议默认用「中」。',
  lifeS: 20,
  lifeTotalS: 20,
};
const error: StackCard = { id: 'n-err-t6', kind: 'error', at: at(14, 31), task_id: T6, title: t6.title, reason: t6.failure?.reason ?? '' };
const reminder: StackCard = { id: 'n-rem', kind: 'notice', variant: 'reminder', at: at(14, 30), title: '16:00 组会：带上周报', commitment_id: 'c0f6a7b8c9d0' };
const look: StackCard = { id: 'n-look', kind: 'notice', variant: 'look', at: at(14, 32), title: '看到了：Terminal — endfield-companion' };

const roleApproval: StackCard = { id: WIRE_INTERACTION_APPROVAL.request_id, kind: 'question', at: at(14, 31), item: fromInteraction(WIRE_INTERACTION_APPROVAL, NOW) };
const roleDanger: StackCard = { id: WIRE_INTERACTION_APPROVAL_DANGER.request_id, kind: 'question', at: at(14, 32), item: fromInteraction(WIRE_INTERACTION_APPROVAL_DANGER, NOW) };
const t2 = pick(TASKS, T2);
const codingReview: StackCard = {
  id: `review-${T2}`,
  kind: 'review',
  source: 'coding',
  at: at(14, 31, 45),
  item: { id: `review-${T2}`, kind: 'review', task_id: T2, title: t2.title, source: `Codex │ ${t2.title}`, since: at(14, 31, 45), cwd: t2.cwd ?? null, verification_source: 'unverified' },
  summary: '断线后 2 秒内自动重连，补了 3 个单元测试；还没在真机上跑过。',
};

// Feed announces (done / brief) and the note native adds after a role-approval answer saved with resume_required.
const done: StackCard = {
  id: 'n-done',
  kind: 'notice',
  variant: 'done',
  at: at(14, 32, 10),
  title: '本周提交周报已整理好',
  body: '142 条提交按项目分组，放在 ~/Documents/周报/10-30.md。',
};
const brief: StackCard = { id: 'n-brief', kind: 'notice', variant: 'brief', at: at(14, 32, 20), title: '周报进度', body: '已读完 3 个仓库的提交，正在按项目分组。' };
const resume: StackCard = { id: `resume-${WIRE_INTERACTION_APPROVAL.request_id}`, kind: 'notice', variant: 'resume', at: at(14, 32, 30), title: '回答已保存 · 在主窗口继续', task_id: T3 };

// Notices native raises itself (StackSource setComputerUse / setVoiceHint / setAvatarLoading).
const computer: DesktopStackCard = {
  id: 'computer-use',
  kind: 'notice',
  variant: 'computer',
  at: at(14, 31, 55),
  title: '正在操作',
  phase: 'executing',
  target_app: '访达',
  target_title: '下载',
  action: '整理下载文件夹：已移动 12 / 30 个文件',
  scopes: ['下载文件夹', '只移动不删除'],
};
const loadingFailed: DesktopStackCard = { id: 'avatar-loading', kind: 'notice', variant: 'loading', at: at(14, 31, 20), title: '加载资源失败：缺少待机动作', phase: 'failed' };
const recovering: DesktopStackCard = {
  id: 'avatar-loading',
  kind: 'notice',
  variant: 'loading',
  at: at(14, 32),
  title: '角色恢复中',
  phase: 'recovering',
  character: '示例甲',
  retry_at: NOW + 5 * SECOND,
};
const micDenied: DesktopStackCard = {
  id: 'voice-hint',
  kind: 'notice',
  variant: 'voice',
  at: at(14, 31, 10),
  title: '麦克风被拒',
  phase: 'mic_denied',
  text: 'Agentic Complex 没有麦克风权限，按住说话用不了',
};
const downloading: DesktopStackCard = {
  id: 'voice-hint',
  kind: 'notice',
  variant: 'voice',
  at: at(14, 32, 5),
  title: '第一次用，要先下载识别模型',
  phase: 'downloading',
  fraction: 0.42,
  received_mb: 63,
  total_mb: 150,
};

/** Native-card scenarios and the dangerous role approval; STACK_PRESETS has none for them, so `demo=` names them directly. */
const NATIVE_SCENARIOS = new Set(['desktop', 'desktop-progress', 'desktop-recovering', 'role-approval-danger']);

/** What native pushes on the card channel while agentd is not running. */
const OFFLINE: BridgeError = { code: 'offline', detail: '后台已断开' };

const history: StackHistoryEntry[] = [
  { id: 'h-review-v1', at: at(14, 22), title: '整理本周提交周报 v1 · 已退回', card: { ...pendingCards().find((c) => c.kind === 'review')!, id: 'h-r1' } },
  { id: 'h-look', at: at(13, 5), title: '看到了：Xcode — HostLink.swift', card: { ...look, id: 'h-look-card', title: '看到了：Xcode — HostLink.swift' } },
  { id: 'h-dlv', at: at(11, 2), title: 'Metal 渲染基准报告 · 已接受', card: { ...delivery, id: 'h-dlv-card' } },
  { id: 'h-err', at: at(10, 15), title: '下载资源索引出错', card: { ...error, id: 'h-err-card' } },
];

/** Cards per demo scenario; every scenario reads the shared fixtures. */
export function stackScenario(name: string): StackPayload {
  const pending = pendingCards();
  // q1, the review and a3 were set aside earlier (稍后), so they wait in the queue bar.
  const fold = (c: StackCard): StackCard => (c.kind === 'question' || c.kind === 'review' || c.id === A3 ? { ...c, collapsed: true } : c);
  const base = { now: NOW, history: [] as StackHistoryEntry[] };
  switch (name) {
    case 'question':
      return { ...base, cards: pending.filter((c) => c.kind === 'question') };
    case 'role-approval':
      return { ...base, cards: [roleApproval, ...pending.filter((c) => c.kind === 'question').slice(0, 1)] };
    case 'role-approval-danger':
      return { ...base, cards: [roleDanger] };
    case 'notices':
      return { ...base, cards: [resume, done, brief] };
    case 'coding-review':
      return { ...base, cards: [codingReview, ...pending.filter((c) => c.kind === 'review')] };
    case 'review':
      return { ...base, cards: [...pending.filter((c) => c.kind === 'review'), delivery] };
    case 'delivery':
      return { ...base, cards: [delivery, reminder] };
    case 'task-error':
      return { ...base, cards: [error, look] };
    case 'timeout': {
      const a3 = pick(APPROVALS, A3);
      const a2 = pick(APPROVALS, A2);
      return {
        ...base,
        cards: [
          { id: A3, kind: 'approval', at: a3.since, item: { ...a3, seconds_left: 0 }, session: 'task', task_id: sessionTask(a3.session_id) },
          { id: A2, kind: 'approval', at: a2.since, item: a2, session: 'task', task_id: sessionTask(a2.session_id), outcome: { kind: 'elsewhere', at: NOW - 20 * SECOND } },
        ],
      };
    }
    case 'history':
      return { ...base, cards: [reminder], history };
    // A2 waits on its own coding session, which presence lists (`stackSessions`).
    case 'session-approval':
      return { ...base, cards: pending.filter((c) => c.id === A2) };
    // Q1 on the session that asked it, and the dangerous A1 on its Claude session.
    case 'session-question':
      return { ...base, cards: pending.filter((c) => c.id === Q1) };
    case 'session-danger':
      return { ...base, cards: pending.filter((c) => c.id === A1) };
    // The prototype shot (shots/desktop.png): one plain approval above a delivery.
    case 'proto':
      return { ...base, cards: [...pending.filter((c) => c.id === A2), delivery] };
    case 'collapsed':
      return { ...base, cards: pending.map((c) => ({ ...c, collapsed: true })), history };
    case 'empty':
      return { ...base, cards: [] };
    // 电脑操作 (P0) ahead of a plain approval, then 麦克风被拒.
    case 'desktop':
      return { ...base, cards: [...pending.filter((c) => c.id === A2), micDenied, computer] };
    case 'desktop-progress':
      return { ...base, cards: [loadingFailed, downloading, look] };
    case 'desktop-recovering':
      return { ...base, cards: [recovering] };
    default:
      return { ...base, cards: [...pending.map(fold), delivery], history };
  }
}

/** What the fake bridge pushes on `stack.onCards` for a `demo=` query. */
export function stackPush(query: URLSearchParams): StackPayload | { error: BridgeError } {
  const demo = query.get('demo');
  const scenario = demo && NATIVE_SCENARIOS.has(demo) ? demo : presetFor(demo).scenario;
  return scenario === 'offline' ? { error: OFFLINE } : stackScenario(scenario);
}

/** A presence `sessions[]` row (desktop_presence.py `snapshot`, epoch seconds); `between` is a running one between tools. */
function sessionRow(id: string, backend: string, title: string, status: string, agoS: number, tool: string | null, target: string | null, approvals: string[] = [], between = false) {
  const activity = between ? '思考中' : ({ needs_you: '待批准', error: '遇到问题', done: '已完成', running: '在跑' }[status] ?? '状态未知');
  const state = between ? 'thinking' : ({ needs_you: 'awaiting_approval', error: 'error', done: 'done', running: 'running_tool' }[status] ?? 'running');
  return { id, backend, title, state, updated_at: (NOW - agoS * SECOND) / 1000, tool, target, approvals, status, activity };
}

/** The session rows a stack demo names (`sessions` in its preset), in presence's order; null keeps the shared fixtures. */
export function stackSessions(query: URLSearchParams): { sessions: unknown[]; additional_sessions: number } | null {
  switch (presetFor(query.get('demo')).sessions) {
    case 'one':
      return { sessions: [sessionRow(S_9A41, 'codex', '整理渲染管线的构建脚本', 'running', 40, 'Bash', '跑一遍 host 单元测试')], additional_sessions: 0 };
    case 'between':
      return { sessions: [sessionRow(S_9A41, 'codex', '整理渲染管线的构建脚本', 'running', 12, 'Bash', '跑一遍 host 单元测试', [], true)], additional_sessions: 0 };
    case 'three':
      return {
        sessions: [
          sessionRow(S_5E10, 'claude', 'HostLink 断线后不重连', 'error', 90, 'Bash', '跑一遍 host 单元测试'),
          sessionRow(S_D0C2, 'claude', '补桌面叠卡的设计说明', 'done', 5, 'Write', 'DESIGN.md'),
          sessionRow(S_9A41, 'codex', '整理渲染管线的构建脚本', 'running', 40, 'Bash', '跑一遍 host 单元测试'),
        ],
        additional_sessions: 2,
      };
    case 'approval':
      return {
        sessions: [
          sessionRow(S_C07A, 'codex', '修 HostLink 断线重连', 'needs_you', 24, 'Edit', 'HostLink.swift', [A2]),
          sessionRow(S_9A41, 'codex', '整理渲染管线的构建脚本', 'running', 40, 'Bash', '跑一遍 host 单元测试'),
        ],
        additional_sessions: 0,
      };
    case 'question':
      return { sessions: [sessionRow(S_D0C2, 'claude', '整理这周的提交，出一份周报', 'needs_you', 240, null, null, [Q1])], additional_sessions: 0 };
    case 'danger':
      return { sessions: [sessionRow(S_5E10, 'claude', 'HostLink 断线后不重连', 'needs_you', 4, 'Bash', 'rm', [A1])], additional_sessions: 0 };
    default:
      return null;
  }
}
