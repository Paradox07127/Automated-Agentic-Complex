// 行为 → 动作 → 总览: a hand-drawn SVG in three columns, stances │ chains │ stances; chains take their group's colour and open their detail.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const IDLE = 'A_clip_birch_idle_loop';
const RELAX = 'A_clip_birch_relax_loop';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const FIDGET = 'A_clip_birch_idle_fidget_01';

const click = (el: Element) => act(async () => void fireEvent.click(el));
const x = (el: Element) => Number(/translate\(([-\d.]+)/.exec(el.getAttribute('transform') ?? '')?.[1]);
const nodes = () => [...document.querySelectorAll<SVGGElement>('[data-ov-chain]')];
const groupOf = (key: string) => MOTION_GRAPH.clips.find((c) => c.name === key)!.group;

async function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={vi.fn()} />
    </QueryClientProvider>,
  );
  await click(await screen.findByRole('radio', { name: '总览' }));
  return screen.getByRole('group', { name: '动作总览' });
}

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('总览', () => {
  it('draws entry stances, every chain and the stances they come back to in three columns', async () => {
    const svg = await mount();
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(nodes().map((n) => n.dataset.ovChain).sort()).toEqual(Object.keys(MOTION_GRAPH.chains).sort());
    const entry = [...svg.querySelectorAll<SVGGElement>('[data-side="entry"]')];
    const back = [...svg.querySelectorAll<SVGGElement>('[data-side="back"]')];
    expect(entry.map((b) => b.dataset.ovBase)).toEqual([IDLE]);
    expect(back.map((b) => b.dataset.ovBase)).toEqual([IDLE, RELAX]);
    const left = Math.max(...entry.map(x));
    const mid = nodes().map(x);
    const right = Math.min(...back.map(x));
    expect(new Set(mid).size).toBe(1);
    expect(left).toBeLessThan(mid[0]!);
    expect(mid[0]!).toBeLessThan(right);
    // One link per entry stance and per stance a chain comes back to: PONDER goes back to both.
    expect(svg.querySelectorAll('path').length).toBe(6 + 7);
    expect(screen.getByText('进入前的站姿')).toBeTruthy();
    expect(screen.getByText('回到的站姿')).toBeTruthy();
  });

  it('colours each chain by its group, as the legend shows', async () => {
    await mount();
    const color = new Map<string, string>();
    for (const n of nodes()) {
      const g = groupOf(n.dataset.ovChain!);
      expect(n.dataset.group).toBe(g);
      if (color.has(g)) expect(n.dataset.color).toBe(color.get(g));
      else color.set(g, n.dataset.color!);
    }
    expect(new Set(color.values()).size).toBe(color.size);
    const legend = screen.getByRole('list', { name: '分组颜色' });
    for (const g of MOTION_GRAPH.groups.filter((x) => color.has(x.id))) {
      expect(within(legend).getByText(new RegExp(g.title))).toBeTruthy();
    }
  });

  it('opens a chain detail on click or Enter, and back returns to the overview', async () => {
    await mount();
    await click(screen.getByRole('button', { name: 'dialog_state_think_start（思考）' }));
    expect(document.querySelector('[data-chain-detail]')?.getAttribute('data-chain-detail')).toBe(PONDER);
    await click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByRole('group', { name: '动作总览' })).toBeTruthy();
    const fidget = document.querySelector(`[data-ov-chain="${FIDGET}"]`)!;
    await act(async () => void fireEvent.keyDown(fidget, { key: 'Enter' }));
    expect(document.querySelector('[data-chain-detail]')?.getAttribute('data-chain-detail')).toBe(FIDGET);
  });
});
