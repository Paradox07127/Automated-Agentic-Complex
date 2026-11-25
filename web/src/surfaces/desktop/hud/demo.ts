// Screenshot states of the status bar under the fake bridge: `#/hud?hud=three|standalone`, plus `expand=1` and `offline=1`.
// The data is built here so the fake bridge's own presence and cards stay as they are.
import type { StackPayload } from '../../../bridge/protocol';
import type { StackCard } from '../../stack/model';

const MIN = 60_000;

export interface HudDemo {
  presence: unknown;
  payload: StackPayload;
  expanded: boolean;
}

/** A presence `sessions[]` row with `doing` and `started_at` (epoch seconds). */
function session(now: number, id: string, backend: string, title: string, status: string, state: string, doing: string, startedMin: number, approvals: string[] = []) {
  return { id, backend, title, state, status, activity: '', doing, tool: null, target: null, approvals, updated_at: (now - MIN) / 1000, started_at: (now - startedMin * MIN) / 1000 };
}

function approval(now: number, id: string, sessionId: string, title: string, cmd: string): StackCard {
  return {
    id,
    kind: 'approval',
    at: now - 2 * MIN,
    session: 'terminal',
    task_id: null,
    item: {
      id,
      kind: 'approval',
      task_id: null,
      title,
      source: `Codex │ ${title}`,
      since: now - 2 * MIN,
      generation: 1,
      approval_kind: 'tool',
      agent: 'codex',
      display_session: sessionId,
      session_id: sessionId,
      tool: 'Bash',
      cmd,
      cwd: '~/Endfield',
      dangerous: false,
      options: ['allow', 'deny'],
      session_scope: null,
      dispatch: null,
      status: 'pending',
      window_s: 55,
      seconds_left: 48,
      fetched_at: now,
    },
  };
}

/** The demo the query names; null without `hud=`. */
export function hudDemo(q: URLSearchParams): HudDemo | null {
  const name = q.get('hud');
  if (name !== 'three' && name !== 'standalone') return null;
  const now = Date.now();
  const sessions = [
    session(now, 'hud-s1', 'claude', '修 HostLink 断线后不重连', 'running', 'running_tool', '正在执行 swift test HostLinkTests', 4),
    session(now, 'hud-s2', 'codex', '补桌面叠卡的设计说明', 'needs_you', 'awaiting_approval', '要删 build/ 目录，待批准', 7, ['hud-a1']),
    session(now, 'hud-s3', 'character', '整理渲染管线的构建脚本', 'error', 'error', '出错：3 项测试未通过', 12),
  ];
  const cards: StackCard[] = [approval(now, 'hud-a1', 'hud-s2', '删除构建目录', 'rm -rf build/')];
  if (name === 'standalone') cards.push(approval(now, 'hud-a2', 'hud-none', '推送发布分支', 'git push origin release'));
  return {
    presence: { sampled_at: now / 1000, sessions, additional_sessions: 0, thought: null, offline: q.get('offline') === '1' },
    payload: { now, cards, history: [] },
    expanded: q.get('expand') === '1',
  };
}
