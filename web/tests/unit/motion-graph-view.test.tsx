// 动作 → 图: 总览 › 分组 › 链 by tapping cards, and a palette clip put on a segment or a 「+」 (picked, or dropped) becoming the
// structure proposal's replace and insert edits, checked through the bridge.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const FIDGET = 'A_clip_birch_idle_fidget_01';
const WAVE = 'A_clip_birch_dialog_single_wave';
const SHA = 'ab'.repeat(32);

let bridge: AgenticComplexBridge;

const click = (el: Element) => act(async () => void fireEvent.click(el));
const card = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`);
  if (!el) throw new Error(`no card ${id}`);
  return el;
};
const clip = (name: string) => screen.getByRole('button', { name: `片段 ${name}` });

async function focus() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.findByRole('navigation', { name: '动作图位置' });
  await click(card('g:session.thinking'));
  await click(card(`k:${PONDER}|0`));
}

beforeEach(() => {
  Object.assign(MOTION_GRAPH, { package_sha256: SHA });
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete (MOTION_GRAPH as Record<string, unknown>).package_sha256;
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('图', () => {
  it('places the first layer’s cards on the canvas', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MotionSettings offline={false} toast={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByRole('navigation', { name: '动作图位置' });
    expect(card('g:session.thinking').style.left).not.toBe('');
  });

  it('opens on 图, goes down to a group and a chain, and back up by the crumbs', async () => {
    await focus();
    const nav = screen.getByRole('navigation', { name: '动作图位置' });
    expect(within(nav).getByText('思考')).toBeTruthy();
    expect(document.querySelector('[data-chain-graph]')!.getAttribute('data-chain-graph')).toBe('focus');
    expect([...document.querySelectorAll<HTMLElement>('[data-kind="seg"]')].map((c) => c.dataset.node)).toEqual(['c:0', 'c:1', 'c:2']);
    expect(screen.getByRole('list', { name: '衔接' }).querySelectorAll('li').length).toBe(4);
    await click(within(nav).getByRole('button', { name: '图' }));
    expect(document.querySelector('[data-chain-graph]')!.getAttribute('data-chain-graph')).toBe('overview');
  });

  it('puts a picked clip on a segment as a replace and on a 「+」 as an insert', async () => {
    const check = vi.spyOn(bridge.avatar.motionChain, 'check');
    await focus();
    await click(clip('idle_fidget_01'));
    expect(clip('idle_fidget_01').getAttribute('aria-pressed')).toBe('true');
    expect(card('c:0').dataset.replace).toBeUndefined();
    await click(card('c:0'));
    expect(card('c:0').dataset.changed).toBeUndefined();
    await click(card('c:2'));
    expect(card('c:2').dataset.changed).toBe('true');
    expect(card('c:2').textContent).toContain('idle_fidget_01');
    expect(clip('idle_fidget_01').getAttribute('aria-pressed')).toBe('false');
    await click(clip('dialog_single_wave'));
    await click(screen.getByRole('button', { name: '在「dialog_state_think_start」后面插入片段' }));
    expect(document.querySelectorAll('[data-kind="seg"]').length).toBe(4);
    expect(card('c:1').textContent).toContain('dialog_single_wave');
    await click(screen.getByRole('button', { name: '检查' }));
    expect(check).toHaveBeenLastCalledWith({
      schema: 'endfield-motion-chain-proposal/v1',
      character: 'si',
      package_sha256: SHA,
      edits: [
        { op: 'replace', chain: PONDER, index: 2, clip: FIDGET },
        { op: 'insert', chain: PONDER, index: 1, clip: WAVE },
      ],
    });
  });

  it('takes a clip dropped on a segment card as a replace', async () => {
    const check = vi.spyOn(bridge.avatar.motionChain, 'check');
    await focus();
    vi.spyOn(card('c:1'), 'getBoundingClientRect').mockReturnValue({ left: 100, right: 284, top: 100, bottom: 160, x: 100, y: 100, width: 184, height: 60 } as DOMRect);
    const canvas = screen.getByRole('img', { name: '动作衔接图' }).parentElement!;
    // jsdom has no DragEvent: a mouse event named drop carries the point and the dragged clip.
    const drop = Object.assign(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 150, clientY: 130 }), {
      dataTransfer: { getData: () => FIDGET },
    });
    await act(async () => void canvas.dispatchEvent(drop));
    await click(screen.getByRole('button', { name: '检查' }));
    expect(check.mock.lastCall![0].edits).toEqual([{ op: 'replace', chain: PONDER, index: 1, clip: FIDGET }]);
    expect(card('c:1').textContent).toContain('idle_fidget_01');
  });

  it('opens the chain detail and switches the chain from a segment card', async () => {
    await focus();
    await click(card('c:1'));
    const detail = document.querySelector<HTMLElement>('[data-graph-detail]')!;
    expect(detail.textContent).toContain(PONDER_LOOP);
    const sw = within(detail).getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(card('c:0').dataset.off).toBe('true');
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    await click(within(detail).getByRole('button', { name: '打开链详情' }));
    expect(document.querySelector('[data-chain-detail]')?.getAttribute('data-chain-detail')).toBe(PONDER);
    await click(screen.getByRole('button', { name: '返回' }));
    expect(document.querySelector('[data-chain-graph]')!.getAttribute('data-chain-graph')).toBe('focus');
  });
});
