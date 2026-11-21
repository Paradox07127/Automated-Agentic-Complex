import { describe, expect, it } from 'vitest';
import { stateVisual, type ActiveRun, type Task, type VisualStateKey } from '../../src/domain';
import { buildCards } from '../../src/pages/tasks/board';
import type { TasksView } from '../../src/pages/tasks/model';
import { stateLabel } from '../../src/surfaces/desktop/tags/presence';

/** One word per session state (desktop_presence.py LABELS). */
const TABLE: Readonly<Record<string, string>> = {
  thinking: '在想',
  running_tool: '在跑',
  awaiting_approval: '待批准',
  awaiting_input: '待回答',
  compacting: '在整理上下文',
  subagent: '在派子任务',
  done: '完成',
  background: '在后台做',
  error: '出错了',
  stale: '没有新动静',
  idle: '空闲',
};

/** Session states whose `stateVisual` word is the session word; done and error there are task and run words. */
const DOMAIN_SESSION: readonly VisualStateKey[] = ['thinking', 'running_tool', 'awaiting_approval', 'awaiting_input', 'idle'];

describe('session state words', () => {
  it('presence labels every session state with the table word', () => {
    for (const [state, word] of Object.entries(TABLE)) expect(stateLabel(state), state).toBe(word);
  });

  it('stateVisual reads the session states with the table word', () => {
    for (const state of DOMAIN_SESSION) expect(stateVisual(state).label, state).toBe(TABLE[state]);
  });

  it('the board names the running tool when known', () => {
    const now = Date.now();
    const task = { id: 'tk-1', title: '修 HostLink', source: 'ext', target: 'claude', created_at: now - 60_000, updated_at: now } as unknown as Task;
    const view = { tasks: [task], sessions: [], pending: [], goals: [], effective: { 'tk-1': 'running' }, activeRuns: {} } as unknown as TasksView;
    const read = (activeRuns: TasksView['activeRuns']) => {
      const cards = buildCards({ ...view, activeRuns }, undefined, now);
      return cards[0]!.stateText;
    };
    expect(read({ 'tk-1': { state: 'running_tool', tool: 'Bash' } as ActiveRun })).toBe('在跑 │ Bash');
    expect(read({})).toBe('在跑');
  });
});
