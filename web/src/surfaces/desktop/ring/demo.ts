// Screenshot states of the icon ring under the fake bridge: `#/ring?ring=icons`, plus `hover=1` (pointer on her) and
// `pop=<icon>` (that icon's card open). The data is built here so the fake bridge's own presence stays as it is.
import type { DesktopState, StackPayload } from '../../../bridge/protocol';
import type { RingKey } from './items';

const MIN = 60_000;
const KEYS: RingKey[] = ['reminders', 'results', 'quiet', 'passthrough'];

export interface RingDemo {
  presence: unknown;
  state: Partial<DesktopState>;
  payload: StackPayload;
  hover: boolean;
  pop: RingKey | null;
}

/** Three icons: two reminders, one result and 免打扰 for 50 minutes; null without `ring=icons`. */
export function ringDemo(q: URLSearchParams): RingDemo | null {
  if (q.get('ring') !== 'icons') return null;
  const now = Date.now();
  const s = now / 1000;
  const pop = KEYS.find((k) => k === q.get('pop')) ?? null;
  return {
    presence: {
      sampled_at: s,
      sessions: [],
      additional_sessions: 0,
      pending: {
        questions: [],
        approvals: [],
        tasks: [],
        results: [{ id: 'ring-d1', generation: 1, revision: 1, title: '昨晚的观察简报：渲染管线构建 3 次，2 次失败', since: s - 8 * 60, state: 'presented', canonical_task_id: 'ring-t1' }],
        reminders: [
          { id: 'ring-c1', text: '三点和设计组开会', due_at: s + 10 * 60, state: 'armed' },
          { id: 'ring-c2', text: '给 HostLink 补一条断线回归测试', due_at: s + 150 * 60, state: 'armed' },
        ],
        questions_more: 0,
        approvals_more: 0,
        tasks_more: 0,
        results_more: 0,
        reminders_more: 0,
        observed_waiting: 0,
      },
      thought: null,
    },
    state: { quietUntil: now + 50 * MIN },
    payload: { now, cards: [], history: [] },
    hover: q.get('hover') === '1' || pop != null,
    pop,
  };
}
