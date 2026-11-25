// 编排 with the event pools agentd knows that the pack has no member for: their group, their cell, and 收下 into one.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MotionGroups } from '../../src/bridge/motionGroups';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { emptyPools } from '../../src/pages/character/motions/pools';
import { click, mount, PAT, pool, rows, save, WAVE } from './chainPage';

const use = (key: string, group: string) => ({ name: key, group, uses: [{ type: 'event', key, group, weight: 1, active: true }] });
const GRAPH: MotionGraph = {
  character: 'x',
  groups: [
    { id: 'idle', title: '空闲', parent: null },
    { id: 'click', title: '点击', parent: null },
    { id: 'session.subagent', title: '子任务', parent: 'session' },
  ],
  clips: [use('user.greet', 'idle'), use('click.head', 'click'), use('session.subagent', 'session.subagent')],
  edges: [],
  chains: {},
};
const empty = (posture = 'stand') => ({ posture, pack: [], proposal: [{ clip: 'c', weight: 1, why: 'meaning:x' }], rejected: [] });
const GROUPS: MotionGroups = {
  character: 'x',
  pools: {
    'user.hover': empty(),
    'look.left': empty(),
    'present.snap': empty(),
    'click.cheek': empty(),
    'session.subagent@sit': empty('sit'),
    'idle.t2': empty(),
    'click.head': { ...empty(), pack: [{ clip: 'click.head', weight: 1 }] },
    'click.nose': { ...empty(), proposal: [] },
    'click.ear': { ...empty(), proposal: [], rejected: [{ clip: 'c', reason: 'no_return' }] },
  },
  excluded: [],
  unclassified: [],
  counts: { clips: 0, pooled: 0, proposed: 0, rejected: 0, excluded: 0, unclassified: 0, proposals: 0 },
};

describe('emptyPools', () => {
  it('puts a pool next to its relatives: the group named by its key, else a pool of the same prefix, else idle', () => {
    const got = Object.fromEntries(emptyPools(GROUPS, GRAPH).map((p) => [p.key, p.group]));
    expect(got).toEqual({
      'user.hover': 'idle',
      'look.left': 'idle',
      'present.snap': 'idle',
      'click.cheek': 'click',
      'session.subagent@sit': 'session.subagent',
      'click.ear': 'click',
    });
  });

  it('gives an empty, overridable event pool in the posture agentd names', () => {
    const p = emptyPools(GROUPS, GRAPH).find((x) => x.key === 'session.subagent@sit');
    expect(p).toEqual({ key: 'session.subagent@sit', kind: 'event', group: 'session.subagent', posture: 'sit', locked: null, entries: [] });
  });
});

let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('an empty-pack pool on 编排', () => {
  it('has a 0 条 cell under 事件反应, shows her proposals, and saves the one taken', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    await mount();
    await click(screen.getByRole('radio', { name: /^事件反应/ }));
    const cell = await waitFor(() => {
      const c = document.querySelector<HTMLElement>('[data-pool-cell="click.cheek"]');
      expect(c).not.toBeNull();
      return c!;
    });
    expect(cell.textContent).toContain('0 条');
    expect(cell.querySelector('[data-proposed]')!.textContent).toBe('2');
    await click(cell);
    expect(pool().dataset.pool).toBe('click.cheek');
    expect(rows()).toEqual([]);
    expect(pool().textContent).toContain('角色建议');
    expect([...pool().querySelectorAll<HTMLElement>('[data-proposal]')].map((x) => x.dataset.proposal)).toEqual([PAT, WAVE]);
    await click(within(pool().querySelector(`[data-proposal="${PAT}"]`)!).getByRole('button', { name: '采纳' }));
    expect(rows()).toEqual([PAT]);
    await save();
    expect(set.mock.lastCall![1].pools).toEqual({ 'click.cheek': [{ clip: PAT, weight: 1 }] });
  });
});
