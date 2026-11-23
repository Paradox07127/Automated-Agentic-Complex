// Work rows as agentd sends them: tasks, ledger, goals, deliveries, approvals, interactions, sessions.
import type {
  WireApproval,
  WireDelivery,
  WireGoal,
  WireInteraction,
  WireLedgerTask,
  WireSession,
  WireTaskRow,
} from '../../../domain/wire';
import { atS, DAY, NOW } from '../clock';
import * as id from '../ids';

const hex = (canonical: string) => canonical.slice(canonical.indexOf(':') + 1);
const YESTERDAY_S = DAY / 1000;

// ---- deliveries ----

const artifact = (n: number, path: string, self_checked: boolean, version = 1) => ({
  artifact_id: `art-${n}`,
  path,
  absolute_path: path.replace(/^~\//, '/Users/me/'),
  version,
  self_checked,
  sha256: n.toString(16).padStart(64, '0'),
  opened_at: null,
});

const delivery = (d: Partial<WireDelivery> & Pick<WireDelivery, 'delivery_id' | 'canonical_task_id' | 'run_id' | 'generation' | 'revision' | 'state'>): WireDelivery => ({
  delivery_version: d.generation + 1,
  task_id: null,
  job_id: d.canonical_task_id.startsWith('job:') ? hex(d.canonical_task_id) : null,
  goal_id: null,
  conversation_id: null,
  character_id: id.CHARACTER,
  source_run_id: null,
  parent_run_id: null,
  scope_id: null,
  outcome: 'needs_review',
  verification_source: 'unverified',
  decision_source: null,
  title: '',
  summary: '',
  artifacts: [],
  produced_at: 0,
  presented_at: null,
  viewed_at: null,
  decided_at: null,
  redacted: false,
  schema_version: 1,
  kind: 'task_notice',
  material_is_instruction: false,
  ...d,
});

/** `personal_deliveries`. Timestamps only move forward: produced ≤ presented ≤ viewed ≤ decided; revision counts each step. */
export const WIRE_DELIVERIES: WireDelivery[] = [
  delivery({
    delivery_id: id.DLV_T1_V1,
    canonical_task_id: id.T1,
    run_id: 'run-71a2',
    conversation_id: id.C1,
    generation: 0,
    revision: 4,
    state: 'rejected',
    decision_source: 'user',
    title: '整理本周提交周报',
    summary: '按日期整理了 10-26 至 10-29 的 142 条提交。',
    artifacts: [artifact(1, '~/Documents/周报/2026-W44 周报.md', false)],
    produced_at: atS(14, 20),
    presented_at: atS(14, 20),
    viewed_at: atS(14, 21),
    decided_at: atS(14, 22),
  }),
  delivery({
    delivery_id: id.DLV_T1_V2,
    canonical_task_id: id.T1,
    run_id: 'run-8d03',
    conversation_id: id.C1,
    generation: 1,
    revision: 3,
    state: 'viewed',
    title: '整理本周提交周报',
    summary:
      '按项目分组整理了 10-26 至 10-29 的 142 条提交：Companion 58、agentd 41、渲染管线 29、其他 14。每个项目列出主要变更和未合入的分支。',
    artifacts: [artifact(2, '~/Documents/周报/2026-W44 周报.md', true, 2), artifact(3, '~/Documents/周报/项目分组明细.md', false)],
    produced_at: atS(14, 26),
    presented_at: atS(14, 27),
    viewed_at: atS(14, 30),
  }),
  delivery({
    delivery_id: id.DLV_T4_V1,
    canonical_task_id: id.T4,
    run_id: 'run-5b20',
    goal_id: id.G1,
    generation: 0,
    revision: 4,
    state: 'accepted',
    verification_source: 'automatic_checks',
    decision_source: 'user',
    title: '生成 Metal 渲染基准报告',
    summary: 'Metal 渲染基准：60 fps 下 p95 15.6 ms，GPU 6.1 ms。',
    artifacts: [artifact(4, '~/Documents/报告/metal-bench-1029.md', true)],
    produced_at: atS(10, 58),
    presented_at: atS(10, 58),
    viewed_at: atS(11, 0),
    decided_at: atS(11, 2),
  }),
];

const deliveryOf = (deliveryId: string) => WIRE_DELIVERIES.find((d) => d.delivery_id === deliveryId) ?? null;

// ---- tasks ----

const row = (r: Partial<WireTaskRow> & Pick<WireTaskRow, 'canonical_task_id' | 'title' | 'state' | 'created_at' | 'updated_at'>): WireTaskRow => {
  const d = r.delivery ?? null;
  return {
    task_id: r.canonical_task_id.startsWith('task:') ? hex(r.canonical_task_id) : null,
    job_id: r.canonical_task_id.startsWith('job:') ? hex(r.canonical_task_id) : null,
    goal_id: null,
    run_id: null,
    source_run_id: null,
    parent_run_id: null,
    conversation_id: null,
    character_id: r.canonical_task_id.startsWith('job:') ? id.CHARACTER : null,
    generation: 0,
    run_count: r.run_id ? 1 : 0,
    delivery: d,
    revision: d?.revision ?? 0,
    verification_source: d?.verification_source ?? null,
    redacted: d?.redacted ?? false,
    ...r,
  };
};

/** `GET /agent/tasks` page, newest first (deliveries.py `_canonical`): jobs plus every ledger row as `task:<id>`. */
export const WIRE_TASK_ROWS: WireTaskRow[] = [
  row({ canonical_task_id: id.T8, title: '给 agentd 的 /feed line 加 lane 字段', state: 'approved', created_at: atS(14, 32, 10), updated_at: atS(14, 32, 10) }),
  row({ canonical_task_id: id.T3, title: '汇总 10 月开销表', state: 'running', goal_id: id.G2, run_id: 'run-9c1e', created_at: atS(14, 26), updated_at: atS(14, 30) }),
  row({ canonical_task_id: id.T2, title: '修 HostLink 断线重连', state: 'running', created_at: atS(14, 20), updated_at: atS(14, 31, 38) }),
  row({
    canonical_task_id: id.T1,
    title: '整理本周提交周报',
    state: 'needs_review',
    run_count: 2,
    run_id: 'run-8d03',
    conversation_id: id.C1,
    generation: 1,
    delivery: deliveryOf(id.DLV_T1_V2),
    created_at: atS(14, 14),
    updated_at: atS(14, 26),
  }),
  row({
    canonical_task_id: id.T4,
    title: '生成 Metal 渲染基准报告',
    state: 'succeeded',
    goal_id: id.G1,
    run_id: 'run-5b20',
    delivery: deliveryOf(id.DLV_T4_V1),
    created_at: atS(10, 40),
    updated_at: atS(11, 2),
  }),
  row({ canonical_task_id: id.T6, title: '下载资源索引', state: 'failed', run_id: 'run-0f11', created_at: atS(10, 12), updated_at: atS(10, 15) }),
  row({ canonical_task_id: id.T7, title: '清理旧截图缓存', state: 'interrupted', created_at: atS(22, 31) - YESTERDAY_S, updated_at: atS(22, 40) - YESTERDAY_S }),
];

const ledger = (l: Pick<WireLedgerTask, 'task_id' | 'target' | 'cwd' | 'title' | 'state' | 'created_at' | 'updated_at'> & Partial<WireLedgerTask>): WireLedgerTask => ({
  mode: 'read_only',
  verify_cmd: null,
  session_id: null,
  result: null,
  requested_by: null,
  ...l,
});

/** `GET /tasks` ledger rows (tasks.py COLUMNS): only coding tasks dispatched from a card; external sessions are not here. */
export const WIRE_LEDGER: WireLedgerTask[] = [
  ledger({ task_id: id.T8_LEDGER, target: 'claude', cwd: '~/Endfield/agent', title: '给 agentd 的 /feed line 加 lane 字段', state: 'approved', created_at: atS(14, 32, 10), updated_at: atS(14, 32, 10) }),
  ledger({ task_id: id.T2_LEDGER, target: 'codex', cwd: '~/Endfield/app', title: '修 HostLink 断线重连', state: 'running', session_id: id.S_C07A, mode: 'workspace_write', created_at: atS(14, 20), updated_at: atS(14, 31, 38) }),
  ledger({ task_id: id.T7_LEDGER, target: 'claude', cwd: '~/Library/Caches', title: '清理旧截图缓存', state: 'interrupted', created_at: atS(22, 31) - YESTERDAY_S, updated_at: atS(22, 40) - YESTERDAY_S }),
];

/** `GET /agent/goals` (jobs.py:75). Tasks join a goal through their row's goal_id. */
export const WIRE_GOALS: WireGoal[] = [
  { goal_id: id.G1, title: '10 月底前把桌面层迁到新设计', objective: 'P4 浮窗栈与快速输入', state: 'active', revision: 3, created_at: atS(9, 0) - 5 * YESTERDAY_S, updated_at: atS(11, 2) },
  { goal_id: id.G2, title: '整理个人财务', objective: '暂停于 10月27日', state: 'paused', revision: 2, created_at: atS(20, 0) - 6 * YESTERDAY_S, updated_at: atS(21, 0) - 2 * YESTERDAY_S },
];

// ---- pending ----

const approval = (a: Partial<WireApproval> & Pick<WireApproval, 'request_id' | 'generation' | 'source' | 'session_id' | 'tool_name' | 'tool_summary' | 'window_s' | 'seconds_left'>): WireApproval & { created_at: number } => ({
  display_session: null,
  agent_id: null,
  kind: 'tool',
  dispatch: null,
  summary_truncated: false,
  summary_length: a.tool_summary?.length ?? null,
  summary_sha256: null,
  content_preview: null,
  content_preview_truncated: false,
  content_preview_length: 0,
  content_preview_sha256: null,
  cwd: null,
  dangerous: false,
  danger_rule: null,
  options: ['allow', 'allow_session', 'deny'],
  session_scope: { kind: 'tool', detail: a.tool_name ?? '' },
  status: 'pending',
  created_at: NOW / 1000 - (a.window_s - a.seconds_left),
  ...a,
});

/** `GET /approvals` read at NOW. Order is deliberately mixed; `sortPending` orders it. */
export const WIRE_APPROVALS: WireApproval[] = [
  approval({
    request_id: id.A2,
    generation: 7,
    display_session: id.S_C07A,
    source: 'codex',
    session_id: id.S_C07A,
    tool_name: 'Edit',
    tool_summary: 'Sources/CompanionCore/HostLink.swift',
    content_preview:
      '@@ -212,7 +212,7 @@ func reconnect() {\n-    let timeout: TimeInterval = 1.5\n+    let timeout: TimeInterval = 3.0\n     let backoff = Backoff(max: 30)',
    content_preview_length: 120,
    cwd: '~/Endfield/app',
    window_s: 55,
    seconds_left: 23,
  }),
  approval({
    request_id: id.A3,
    generation: 8,
    display_session: id.S_C07A,
    source: 'codex',
    session_id: id.S_C07A,
    tool_name: 'Bash',
    tool_summary: 'swift test --filter HostLinkTests',
    cwd: '~/Endfield/app',
    window_s: 50,
    seconds_left: 34,
  }),
  approval({
    request_id: id.A1,
    generation: 9,
    display_session: id.S_5E10,
    source: 'claude',
    session_id: id.S_5E10.slice('claude:'.length),
    tool_name: 'Bash',
    tool_summary: 'rm -rf build/ .build/release && swift build -c release',
    summary_truncated: true,
    summary_length: 212,
    cwd: '~/Endfield/app',
    dangerous: true,
    danger_rule: 'rm_recursive',
    options: ['allow', 'deny'],
    session_scope: null,
    window_s: 45,
    seconds_left: 41,
  }),
];

const interaction = (i: Partial<WireInteraction> & Pick<WireInteraction, 'request_id' | 'run_id' | 'kind' | 'created_at'>): WireInteraction => ({
  state: 'pending',
  revision: 1,
  data: null,
  answer: null,
  expires_at: 0,
  conversation_id: null,
  generation: 0,
  ...i,
});

/** `GET /agent/interactions` requests. Q1 has no deadline (expires_at 0), so cards show「不限时 · 等了 4 分钟」. */
export const WIRE_INTERACTIONS: WireInteraction[] = [
  interaction({
    request_id: id.Q1,
    run_id: 'run-8d03',
    kind: 'question',
    conversation_id: id.C1,
    generation: 1,
    created_at: atS(14, 27, 40),
    data: {
      questions: [{ id: 'scope', question: '周报里要不要包含外部会话的提交？', options: [{ label: '包含' }, { label: '不包含' }, { label: '单列一节', description: '放在最后' }] }],
      preview: null,
      character_id: id.CHARACTER,
      scope_id: null,
      user_text: '帮我整理这周的提交，出一份周报',
      job_id: id.T1.slice('job:'.length),
    },
  }),
];

/** A character exact-call approval (`kind: approval`) with its preview; not in the pending list, used by adapter tests. */
export const WIRE_INTERACTION_APPROVAL: WireInteraction = interaction({
  request_id: id.Q_APPROVAL,
  run_id: 'run-9c1e',
  kind: 'approval',
  conversation_id: null,
  created_at: atS(14, 31),
  expires_at: atS(14, 34),
  data: {
    questions: [{ id: 'decision', question: '允许写入 ~/Documents/开销/10 月.xlsx？', options: [{ label: '允许' }, { label: '拒绝' }] }],
    preview: { path: '~/Documents/开销/10 月.xlsx' },
    preview_text: '{\n  "path": "~/Documents/开销/10 月.xlsx"\n}',
    character_id: id.CHARACTER,
    scope_id: null,
    user_text: '',
    job_id: id.T3.slice('job:'.length),
  },
});

/** A character exact-call approval the policy judged dangerous (`rm_recursive`). */
export const WIRE_INTERACTION_APPROVAL_DANGER: WireInteraction = interaction({
  request_id: id.Q_APPROVAL_DANGER,
  run_id: 'run-9c1e',
  kind: 'approval',
  conversation_id: null,
  created_at: atS(14, 32),
  expires_at: atS(14, 35),
  data: {
    questions: [{ id: 'decision', question: '是否允许这一次操作？', options: [{ label: '允许' }, { label: '拒绝' }] }],
    preview: { server: 'shell', tool: 'run', arguments: { command: 'rm -rf ~/x' } },
    preview_text: '{\n  "server": "shell",\n  "tool": "run",\n  "arguments": {\n    "command": "rm -rf ~/x"\n  }\n}',
    dangerous: true,
    danger_rule: 'rm_recursive',
    character_id: id.CHARACTER,
    scope_id: null,
    user_text: '',
    job_id: id.T3.slice('job:'.length),
  },
});

// ---- sessions ----

/** `GET /sessions`: external rows (registry) then own rows (own.py to_dict). */
export const WIRE_SESSIONS: WireSession[] = [
  { session_id: id.S_5E10, own: false, target: 'claude', cwd: '~/Endfield', title: null, state: 'awaiting_approval', last_line: null, started_at: null, updated_at: atS(14, 32, 6), observed_at: atS(14, 32, 6), capabilities: ['observe'] },
  { session_id: id.S_9A41, own: false, target: 'codex', cwd: '~/Endfield/pipeline', title: null, state: 'running_tool', last_line: null, started_at: null, updated_at: atS(13, 32), observed_at: atS(14, 32), capabilities: ['observe'] },
  { session_id: id.S_D0C2, own: false, target: 'claude', cwd: '~/Endfield/docs', title: null, state: 'idle', last_line: null, started_at: null, updated_at: atS(14, 25), observed_at: atS(14, 31), capabilities: ['observe'] },
  {
    session_id: id.S_C07A,
    own: true,
    target: 'codex',
    cwd: '~/Endfield/app',
    title: '修 HostLink 断线重连',
    state: 'awaiting_approval',
    last_line: '待批准：Edit Sources/CompanionCore/HostLink.swift',
    started_at: atS(14, 20),
    updated_at: atS(14, 31, 38),
    task_id: id.T2_LEDGER,
    mode: 'workspace_write',
    pinned: false,
    archived: false,
    revision: 1,
    capabilities: ['observe', 'resume', 'control'],
  },
];
