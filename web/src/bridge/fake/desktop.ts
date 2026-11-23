import type { PendingItem } from '../../domain';
import type { DesktopPresenceResponse } from '../agentd-routes.generated';
import type { CmdMode, DesktopAnchor, DesktopCommand, DesktopPanel, DesktopState, DockReason, AgenticComplexBridge, ProcessState, RecentAnnouncement, Unsubscribe } from '../protocol';
import { CHARACTERS, PAUSE, PENDING, PRESENCE_ROLE, SESSIONS, WIRE_TASK_ROWS } from '../../mock/fixtures';
import { demoPlugins } from '../../mock/settings';
import { stackSessions } from '../../mock/stack';
import { NOW } from '../../mock/fixtures/clock';
import { C1 } from '../../mock/fixtures/ids';
import { pluginState } from '../../shell/plugins';
import { PLUGINS } from '../plugins.generated';

const HASH_PANELS: Record<string, DesktopPanel> = { '/cmd': 'cmd', '/console': 'console', '/bubble': 'bubble', '/chip': 'chip', '/dock': 'dock', '/hud': 'hud' };

/** The desktop panel the hash path names: `#/cmd`, `#/console`, `#/bubble`, `#/chip`, `#/dock`, else the stack cards' page (`#/hud`). */
export function hashPanel(): DesktopPanel {
  const path = (globalThis.location?.hash ?? '').replace(/^#/, '').split('?')[0];
  return HASH_PANELS[path ?? ''] ?? 'hud';
}

/** Hands `value` to `cb` once, after the subscriber has returned. */
function once<T>(value: () => T, cb: (v: T) => void): Unsubscribe {
  let live = true;
  queueMicrotask(() => live && cb(value()));
  return () => void (live = false);
}

/** 最近播报 as native keeps it, newest first. */
const RECENT: RecentAnnouncement[] = [
  { id: 'announce-41', text: '「周报草稿」已交付，在任务里看', time: '14:01', unread: true },
  { id: 'announce-40', text: '编码会话 fix-login 跑完了 · 3 个测试没过', time: '13:47', unread: true },
  { id: 'announce-38', text: '提醒：15:00 和设计组过评审', time: '13:30', unread: true },
  { id: 'announce-35', text: '「晨间简报」已交付', time: '08:30', unread: false },
];

const DOCK_REASONS: DockReason[] =['hidden', 'fullscreen', 'offscreen', 'stale', 'noroom'];

/** desktop_presence.py LABELS for the session states the fake has. */
const ACTIVITY: Record<string, string> = {
  thinking: '在想', running_tool: '在跑', awaiting_approval: '待批准', awaiting_input: '待回答',
  compacting: '在整理上下文', subagent: '在派子任务', done: '完成', background: '在后台做', error: '出错了', stale: '没有新动静', idle: '空闲',
};

/** desktop_presence.py `_status` for the session states the fake has; the rest run. */
const STATUS: Record<string, string> = { awaiting_approval: 'needs_you', awaiting_input: 'needs_you', error: 'error' };

/**
 * She stands settled at the right of one screen; the bubble and her hover buttons sit on her left, the command layer
 * and the stack cards' page under her.
 * `demo=<dock reason>` docks every panel for that reason; `demo=far` leaves the panel dragged away from her.
 */
export function fakeAnchor(panel: DesktopPanel, demo: string | null): DesktopAnchor {
  const room = { width: 456, height: 820 };
  const reason = DOCK_REASONS.find((r) => r === demo);
  if (reason) {
    const side = panel === 'bubble' && (reason === 'hidden' || reason === 'fullscreen') ? 'menubar' : 'corner';
    return { panel, state: 'docked', side, docked: reason, far: true, toHead: reason === 'noroom' ? { dx: -560, dy: 340 } : null, room };
  }
  const side = panel === 'console' ? 'status' : panel === 'cmd' || panel === 'hud' ? 'below' : 'left';
  if (demo === 'far') return { panel, state: 'settled', side, docked: null, far: true, toHead: { dx: 380, dy: -150 }, room };
  const toHead = panel === 'hud' ? { dx: 0, dy: -420 } : { dx: 220, dy: -36 };
  return { panel, state: 'settled', side, docked: null, far: false, toHead, room };
}

/**
 * `window.onAnchor` and `desktop.*` over demo data; `mode=` picks what the cmd page opens (`at=x,y` its wheel's centre),
 * and the console page opens itself. Besides the anchor demos,
 * `demo=hidden` and `demo=passthrough` set the desktop state, `plugins=` its plug-ins as for settings, `demo=empty` leaves
 * presence with no sessions or pending items; `dock=left|right|above|compact|closed` sets her hover buttons, open on
 * the right by default; `demo=quiet` turns quiet on.
 */
export function createFakeDesktop(
  query: () => URLSearchParams,
  pips: { agentd: ProcessState; avatar: ProcessState },
  computerUseActive: () => boolean,
): { onAnchor: AgenticComplexBridge['window']['onAnchor']; desktop: AgenticComplexBridge['desktop'] } {
  const demo = () => query().get('demo');
  const state = (): DesktopState => {
    const active = CHARACTERS.find((c) => c.active);
    return {
      hidden: demo() === 'hidden',
      clickThroughAll: demo() === 'passthrough',
      freeRoam: false,
      quietUntil: demo() === 'quiet' ? Date.now() + 45 * 60_000 : PAUSE.quiet_until,
      hiddenUntil: demo() === 'hidden' ? Date.now() + 30 * 60_000 : null,
      dock: {
        open: query().get('dock') !== 'closed',
        side: (['left', 'above'] as const).find((s) => s === query().get('dock')) ?? 'right',
        compact: query().get('dock') === 'compact',
      },
      character: active ? { id: active.id, name: active.name } : null,
      characters: CHARACTERS.map((c) => ({ id: c.id, name: c.name })),
      screens: [{ id: '1', name: '内建显示器', current: true }, { id: '2', name: 'LG HDR 4K', current: false }],
      hotkeys: { hk_quick: '⌃Space', hk_ptt: '右 ⌥', hk_look: '⌃⌥L', hk_hide: '⌃⌥H', hk_pass: '⌃⌥P', hk_wheel: '⌃⌥R' },
      pips: { ...pips, voice: 'on' },
      computerUseActive: computerUseActive(),
      plugins: PLUGINS.filter((p) => pluginState(demoPlugins(query().get('plugins')))[p.id]).map((p) => p.id),
    };
  };
  // The shape of agentd's `/desktop/presence` (desktop_presence.py `snapshot`): epoch seconds, at most 3 rows per list.
  const presence = () => {
    // `demo=chip-run|chip-done|chip-failed|chip-offline`: the status chip's states (`#/chip`), with nothing pending.
    const chip = demo()?.match(/^chip-(run|done|failed|offline)$/)?.[1] ?? null;
    if (chip === 'offline') return { offline: true };
    const empty = demo() === 'empty' || chip != null;
    const sessions = empty ? [] : SESSIONS;
    const of = <K extends PendingItem['kind']>(kind: K) =>
      (empty ? [] : PENDING.filter((p): p is Extract<PendingItem, { kind: K }> => p.kind === kind)).sort((a, b) => b.since - a.since);
    const row = (p: { id: string; generation: number; title: string; since: number }) => ({ id: p.id, generation: p.generation, title: p.title, since: p.since / 1000 });
    // agentd lists the jobs in these states (desktop_presence.py `snapshot`).
    const jobs = empty ? [] : WIRE_TASK_ROWS.filter((t) => t.job_id && ['queued', 'running', 'interrupted', 'needs_review'].includes(t.state)).sort((a, b) => b.created_at - a.created_at);
    const questions = of('question');
    const approvals = of('approval');
    const results = of('review');
    const pending: DesktopPresenceResponse['pending'] = {
      questions: questions.slice(0, 3).map(row),
      approvals: approvals.slice(0, 3).map(row),
      tasks: jobs.slice(0, 3).map((t) => ({ id: t.job_id ?? '', generation: t.generation, title: t.title, since: t.created_at, state: t.state })),
      results: results.slice(0, 3).map((p) => ({ ...row(p), id: p.delivery_id, revision: p.revision, state: 'presented', canonical_task_id: p.task_id })),
      reminders: [],
      questions_more: Math.max(0, questions.length - 3),
      approvals_more: Math.max(0, approvals.length - 3),
      tasks_more: Math.max(0, jobs.length - 3),
      results_more: Math.max(0, results.length - 3),
      reminders_more: 0,
      observed_waiting: 0,
    };
    const stackRows = stackSessions(query());
    const rows = (stackRows?.sessions ?? sessions.slice(0, 3).map((s) => ({
      id: s.id, backend: s.target, title: s.title, state: s.state, updated_at: s.since / 1000, tool: null, target: null, approvals: [],
      status: STATUS[s.state] ?? 'running',
    }))) as Array<Omit<DesktopPresenceResponse['sessions'][number], 'doing' | 'started_at' | 'activity' | 'own_app'>>;
    const verbs: Record<string, string> = {
      Edit: '改', MultiEdit: '改', NotebookEdit: '改', apply_patch: '改', Write: '写入', Read: '读取',
      Bash: '运行', shell: '运行', exec_command: '运行', local_shell: '运行', WebFetch: '访问', WebSearch: '搜索', Glob: '查找', Grep: '搜索',
    };
    const doing = (state: string, tool: string | null, target: string | null): string => {
      const label = ACTIVITY[state] ?? '状态不明';
      if (state === 'awaiting_approval') return [label, target].filter(Boolean).join(' ');
      if (state !== 'running_tool' || !tool) return label;
      if (['Bash', 'Task', 'Agent'].includes(tool) && target && (tool !== 'Bash' || target.includes(' '))) return target;
      if (tool.startsWith('mcp__')) {
        const [server = '', ...parts] = tool.slice(5).split('__');
        if (server.startsWith('ccd_') || server === 'agentic_complex') return label;
        return `用 ${server}${parts.length ? ` 的 ${parts.join('__')}` : ''}`;
      }
      return [verbs[tool] ?? `用 ${tool}`, target].filter(Boolean).join(' ');
    };
    return {
      sampled_at: NOW / 1000,
      character_id: CHARACTERS.find((c) => c.active)?.id ?? null,
      role: empty && chip !== 'run' ? { state: 'idle', activity: '空闲', doing: '空闲', intention: null, backend: null, mood: null, background_runs: 0, background: [] } : {
        ...PRESENCE_ROLE, since: PRESENCE_ROLE.since / 1000, activity: ACTIVITY[PRESENCE_ROLE.state], doing: ACTIVITY[PRESENCE_ROLE.state],
        intention: '我在处理任务所需的资料和操作。', backend: 'codex', mood: null,
        conversation_id: C1, generation: 1, outcome: null, additional_runs: 0, background_runs: 0, background: [],
      },
      sessions: rows.map((s) => {
        const target = s.target == null ? null : s.target.trim().split(/\s+/).join(' ');
        return { ...s, target, started_at: null, own_app: false, activity: ACTIVITY[s.state] ?? '状态不明', doing: doing(s.state, s.tool, target) };
      }),
      additional_sessions: stackRows?.additional_sessions ?? Math.max(0, sessions.length - 3),
      pending,
      ritual: null,
      agent: chip === 'done' || chip === 'failed' ? { state: chip, since: NOW / 1000, count: 1 } : { state: 'working', since: PRESENCE_ROLE.since / 1000, count: 1 },
      focus: null,
      proactive_speech: true,
      thought: null,
      voice: { state: 'off', muted: false },
      observation: { paused: false },
    };
  };
  const commands = new Set<(c: DesktopCommand) => void>();
  let opened = false;
  return {
    onAnchor: (cb) => once(() => fakeAnchor(hashPanel(), demo()), cb),
    desktop: {
      onState: (cb) => once(state, cb),
      onPresence: (cb) => once(presence, cb),
      onCommand: (cb) => {
        const panel = hashPanel();
        const mode = (query().get('mode') ?? 'ring') as CmdMode;
        // The console page has its own channel and gets only its own opening command.
        if (panel === 'console') return once(() => ({ kind: 'openConsole' }) as const, cb);
        // The bubble page takes only 快速输入's opening command.
        if (panel !== 'cmd' && !(panel === 'bubble' && mode === 'input')) return () => {};
        commands.add(cb);
        // Native does not replay commands (DesktopPushSource replay: false): one opening command, to the pages there are.
        if (!opened) {
          opened = true;
          const at = query().get('at')?.split(',').map(Number);
          const open: DesktopCommand = at?.length === 2 && at.every(Number.isFinite) ? { kind: 'open', mode, at: { x: at[0]!, y: at[1]! } } : { kind: 'open', mode };
          queueMicrotask(() => commands.forEach((c) => c(open)));
        }
        return () => void commands.delete(cb);
      },
      // `demo=agentdoff`: agentd is gone, so nothing is sent.
      say: async (r) => {
        if (!r.text.trim()) return { ok: false, reason: 'rejected' };
        return demo() === 'agentdoff' ? { ok: false, reason: 'agentd' } : { ok: true };
      },
      // `demo=console-unread`: three unread announcements and a read one; otherwise only the read one.
      onRecent: (cb) => once(() => (demo() === 'console-unread' ? RECENT : RECENT.filter((r) => !r.unread)), cb),
      openAnnouncement: async () => {},
      markAllRead: async () => {},
      notice: () => {},
      // `quickInput` sends 快速输入's opening to the subscribed pages, with the drop scope its `arg` names first, as native does.
      action: async (name, arg) => {
        if (name !== 'quickInput') return;
        const scope = arg ? (JSON.parse(arg) as { scopeId: string; files: number }) : null;
        commands.forEach((cb) => {
          if (scope) cb({ kind: 'scope', ...scope });
          cb({ kind: 'open', mode: 'input' });
        });
      },
    },
  };
}
