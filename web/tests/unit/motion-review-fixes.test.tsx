// 编排 review fixes 11-22: a 1-segment chain's structure, ghosts measured from the chain's own last segment, a character switch,
// edits while 保存 is in flight, the blend step, the wedge drag, and the 重建 confirmation going offline.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import type { Toast } from '../../src/pages/character/feedback';
import { ChainEditBar } from '../../src/pages/character/motions/ChainEditBar';
import { fixBlend } from '../../src/pages/character/motions/ChainStrip';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';
import { click, detail, FIDGET, IDLE, mount, openChain, PONDER, PONDER_END, PONDER_LOOP, row, save, setWeight, THINK, weight } from './chainPage';

const pose = (dx: number) => Array.from({ length: 17 }, (_, i) => [dx, i * 10, 0]);
const still = (dx: number) => ({ start: pose(dx), end: pose(dx) });
const POSES = {
  [IDLE]: still(0),
  [THINK]: still(1),
  [PONDER]: { start: pose(0), end: pose(5) },
  [PONDER_LOOP]: { start: pose(6), end: pose(9) },
  [PONDER_END]: { start: pose(7), end: pose(0) },
  [FIDGET]: still(5),
};

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const segs = () => [...detail().querySelectorAll<HTMLElement>('[data-seg]')].map((s) => s.dataset.seg);
const ghost = (clip: string) => detail().querySelector<HTMLElement>(`[data-ghost="${clip}"]`);
const band = () => screen.getByRole('group', { name: '结构提案' });

async function edit(key: string) {
  await mount(toast);
  await openChain(key);
  await click(within(detail()).getByRole('button', { name: '编辑结构' }));
}

/** Mounts with a client the test holds, `voice_a`'s graph read as `graphOf(si's)`. */
async function mountSwitchable(graphOf: (g: MotionGraph) => MotionGraph = (g) => g) {
  const real = bridge.agentd.request.bind(bridge.agentd);
  const request = vi.spyOn(bridge.agentd, 'request').mockImplementation(async (method, path, body) => {
    const other = path.includes('/characters/voice_a/');
    const r = await real(method, other ? path.replace('/characters/voice_a/', '/characters/si/') : path, body);
    return other && path.endsWith('/motion-graph') ? ({ ...r, body: graphOf(r.body as MotionGraph) } as typeof r) : r;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MotionSettings offline={false} toast={toast} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radiogroup', { name: '池子类型' });
  return async () => {
    await bridge.character.switchTo('voice_a');
    await act(async () => void (await qc.invalidateQueries({ queryKey: ['character', 'list'] })));
    await waitFor(() => {
      expect(request.mock.calls.some((c) => c[1] === '/characters/voice_a/motion-graph')).toBe(true);
      expect(screen.queryByRole('status', { name: '正在读取动作' })).toBeNull();
      screen.getByRole('radiogroup', { name: '池子类型' });
    });
  };
}

beforeEach(() => {
  Object.assign(MOTION_GRAPH, { poses: POSES });
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  toast = vi.fn<Toast>();
});
afterEach(() => {
  cleanup();
  delete (MOTION_GRAPH as Record<string, unknown>).poses;
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('编辑结构 on a chain of one segment', () => {
  it('has a trailing 「+」 and lists the clips that can follow it', async () => {
    await edit(THINK);
    expect(segs()).toEqual([THINK]);
    const plus = within(detail()).getByRole('button', { name: '在「customized_state_think_start」后插入' });
    expect(plus.getAttribute('aria-pressed')).toBe('true');
    expect(ghost(FIDGET)).not.toBeNull();
    expect(detail().querySelector('[data-candidates]')!.textContent).not.toContain('段间的橙色 +');
  });

  it('measures the ghosts from the chain’s own last segment, not the stance it rests on, and inserts before that stance', async () => {
    const check = vi.spyOn(bridge.avatar.motionChain, 'check');
    await edit(THINK);
    // THINK leaves at 1 cm, FIDGET starts at 5: 4 cm after segment 1 (IDLE would give 5 cm after segment 2).
    expect(ghost(FIDGET)!.textContent).toContain('接在第 1 段后 │ 4 cm');
    await click(within(ghost(FIDGET)!).getByRole('button', { name: '插在它后面' }));
    expect(segs()).toEqual([THINK, FIDGET]);
    await click(within(band()).getByRole('button', { name: '检查' }));
    expect(check.mock.lastCall![0].edits).toEqual([{ op: 'insert', chain: THINK, index: 1, clip: FIDGET }]);
  });

  it('picks the slot after the last segment of a longer chain from its trailing 「+」', async () => {
    await edit(PONDER);
    await click(within(detail()).getByRole('button', { name: '在「dialog_state_think_end」后插入' }));
    expect(within(detail()).getByRole('button', { name: '在「dialog_state_think_end」后插入' }).getAttribute('aria-pressed')).toBe('true');
    expect(detail().querySelector('[data-cand]')).toBeNull();
    expect(ghost(FIDGET)).not.toBeNull();
  });
});

describe('a character switch on 编排', () => {
  it('leaves 事件反应 for a character whose pack has no event pools', async () => {
    const switchTo = await mountSwitchable((g) => ({ ...g, clips: g.clips.map((c) => ({ ...c, uses: c.uses.filter((u) => u.type !== 'event') })) }));
    await click(screen.getByRole('radio', { name: /^事件反应/ }));
    await switchTo();
    expect(screen.getByRole('radio', { name: /^待机/ }).getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).not.toContain('角色包里没有能改的池子');
  });

  it('drops the unsaved draft, the open chain and the structure edits of the character left', async () => {
    const set = vi.spyOn(bridge.avatar.motionOverrides, 'set');
    const switchTo = await mountSwitchable();
    await setWeight(FIDGET, '7');
    await openChain(PONDER);
    await click(within(detail()).getByRole('button', { name: '编辑结构' }));
    await click(within(detail()).getByRole('button', { name: '在「dialog_state_think_loop」前插入' }));
    await switchTo();
    expect(document.querySelector('[data-chain-detail]')).toBeNull();
    expect(screen.queryByRole('group', { name: '结构提案' })).toBeNull();
    expect(screen.getByRole('group', { name: '保存动作设置' }).textContent).toContain('已保存');
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('保存 in flight', () => {
  it('holds the draft inputs until the avatar answers, so no edit is dropped', async () => {
    let answer!: () => void;
    vi.spyOn(bridge.avatar.motionOverrides, 'set').mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve({ applied: { chains: 0, pools: 1, blend_in: 0 }, adjusted: [] }))),
    );
    await mount(toast);
    await setWeight(FIDGET, '7');
    await save();
    expect(weight(FIDGET).disabled).toBe(true);
    await act(async () => answer());
    expect(weight(FIDGET).disabled).toBe(false);
    expect(row(FIDGET)).toBeTruthy();
  });
});

describe('blend wedge', () => {
  it('rounds to the 0.05 s step exactly', () => {
    for (const s of [0.15, 0.3, 0.35, 0.6, 0.7, 1.2, 1.4]) expect(fixBlend(s)).toBe(s);
    expect(fixBlend(0.27)).toBe(0.25);
    expect(fixBlend(3)).toBe(2);
    expect(fixBlend(-1)).toBe(0);
  });

  it('comes back to where a drag started once it has moved', async () => {
    await mount(toast);
    await openChain(PONDER);
    const wedge = () => within(detail()).getByRole('button', { name: /^进入「dialog_state_think_loop」的衔接/ });
    await act(async () => {
      fireEvent.pointerDown(wedge(), { pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(wedge(), { pointerId: 1, clientX: 120 });
    });
    expect(wedge().textContent).toContain('0.45 s');
    await act(async () => void fireEvent.pointerMove(wedge(), { pointerId: 1, clientX: 101 }));
    expect(wedge().textContent).toContain('0.25 s');
    await act(async () => void fireEvent.pointerUp(wedge(), { pointerId: 1, clientX: 101 }));
  });
});

describe('重建 confirmation', () => {
  it('does not rebuild when the avatar went offline while it was open', async () => {
    const onApply = vi.fn();
    const props = { n: 1, busy: null, outcome: null, general: [], onCheck: () => {}, onApply, onDiscard: () => {} };
    const { rerender } = render(<ChainEditBar {...props} block={null} />);
    await click(screen.getByRole('button', { name: '应用到角色包（重建）' }));
    rerender(<ChainEditBar {...props} block="角色未运行" />);
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    expect(onApply).not.toHaveBeenCalled();
  });
});
