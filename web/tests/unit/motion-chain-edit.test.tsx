// 链详情「编辑结构」: swapping and inserting clips, gaps re-measured from the graph's 17 key-bone poses, 检查, and
// 「应用到角色包（重建）」 with its confirmation and its failures.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import type { Toast } from '../../src/pages/character/feedback';
import { keyBoneGap, poseGap } from '../../src/pages/character/motions/chainEdit';
import { reasonText } from '../../src/pages/character/motions/chainReasons';
import { indexGraph } from '../../src/pages/character/motions/chainPath';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { MotionSettings } from '../../src/pages/character/motions/MotionSettings';

vi.mock('cytoscape', () => import('./cytoscapeHeadless'));

const IDLE = 'A_clip_birch_idle_loop';
const THINK = 'A_clip_birch_customized_state_think_start';
const PONDER = 'A_clip_birch_dialog_state_think_start';
const PONDER_LOOP = 'A_clip_birch_dialog_state_think_loop';
const PONDER_END = 'A_clip_birch_dialog_state_think_end';
const FIDGET = 'A_clip_birch_idle_fidget_01';
const WAVE = 'A_clip_birch_dialog_single_wave';
const SHA = 'ab'.repeat(32);

/** 17 key bones stacked 10 cm apart and moved `dx` cm sideways: two such poses are |dx₁ − dx₂| cm apart. */
const pose = (dx: number) => Array.from({ length: 17 }, (_, i) => [dx, i * 10, 0]);
const still = (dx: number) => ({ start: pose(dx), end: pose(dx) });
const POSES = {
  [IDLE]: still(0),
  [THINK]: still(1),
  [PONDER]: { start: pose(0), end: pose(5) },
  [PONDER_LOOP]: { start: pose(6), end: pose(9) },
  [PONDER_END]: { start: pose(7), end: pose(0) },
  [FIDGET]: still(5),
  [WAVE]: still(20),
};

let bridge: AgenticComplexBridge;
let toast: Mock<Toast>;

const click = (el: Element) => act(async () => void fireEvent.click(el));
const row = (key: string) => document.querySelector<HTMLElement>(`[data-chain="${key}"]`)!;
const detail = () => document.querySelector<HTMLElement>('[data-chain-detail]')!;
const seg = (clip: string) => detail().querySelector<HTMLElement>(`[data-seg="${clip}"]`)!;
const segs = () => [...detail().querySelectorAll<HTMLElement>('[data-seg]')].map((s) => s.dataset.seg);
const gaps = () => [...detail().querySelectorAll<HTMLElement>('[data-joint]')].map((j) => j.querySelector('span')!.textContent);
const button = (name: string | RegExp, root: HTMLElement = detail()) => within(root).getByRole('button', { name });

async function edit(key: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MotionSettings offline={false} toast={toast} />
    </QueryClientProvider>,
  );
  await screen.findByRole('radiogroup', { name: '动作视图' });
  await click(screen.getByRole('radio', { name: '清单' }));
  await click(within(row(key)).getByRole('button', { name: '详情' }));
  await click(button('编辑结构'));
}

beforeEach(() => {
  Object.assign(MOTION_GRAPH, { poses: POSES, package_sha256: SHA });
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  toast = vi.fn<Toast>();
});
afterEach(() => {
  cleanup();
  const g = MOTION_GRAPH as Record<string, unknown>;
  delete g.poses;
  delete g.package_sha256;
  delete window.agenticComplex;
  vi.restoreAllMocks();
});

describe('gap 用 17 根关键骨骼重新量', () => {
  it('is the largest key-bone distance in cm to 0.1', () => {
    const a = pose(0);
    const b = pose(0).map((p, i) => (i === 3 ? [p[0]! + 3, p[1]! + 4, p[2]!] : i === 9 ? [p[0]!, p[1]!, p[2]! + 4.96] : p));
    expect(keyBoneGap(a, b)).toBe(5);
    expect(keyBoneGap(a, pose(0.04))).toBe(0);
    expect(keyBoneGap(a, pose(12.345))).toBe(12.3);
  });

  it('leaves a loop from its first frame and any other clip from its last, as motion_graph.py measured_gap does', () => {
    const g = { ...MOTION_GRAPH, poses: POSES } as unknown as MotionGraph;
    const ix = indexGraph(g);
    // PONDER_LOOP loops: its first frame (6) against FIDGET's first (5).
    expect(poseGap(g, ix, PONDER_LOOP, FIDGET)).toBe(1);
    // PONDER does not: its last frame (5) against WAVE's first (20).
    expect(poseGap(g, ix, PONDER, WAVE)).toBe(15);
    expect(poseGap(g, ix, PONDER, 'A_clip_birch_customized_single_headpat')).toBeNull();
  });
});

describe('编辑结构', () => {
  it('swaps a segment for a clip of the same stance and family, nearest first, and re-measures its joints', async () => {
    await edit(PONDER);
    const picker = button('换「dialog_state_think_end」或插在它前面的片段', seg(PONDER_END));
    await click(picker);
    const options = within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(options.slice(0, 3)).toEqual(['idle_fidget_01 │ 前 1 cm', 'customized_state_think_start │ 前 5 cm', 'idle_loop │ 前 6 cm']);
    // Unmeasured last, by name.
    expect(options.slice(-3)).toEqual(['customized_single_headpat │ 前 未测', 'relax_loop │ 前 未测', 'idle_to_relax │ 前 未测']);
    expect(options.some((o) => o!.startsWith('dialog_state_think'))).toBe(false);
    await click(screen.getByRole('option', { name: /customized_state_think_start/ }));
    await click(button('换成', seg(PONDER_END)));
    expect(segs()).toEqual([PONDER, PONDER_LOOP, THINK]);
    // Entry 12 (edge), 3.1 (edge), then the new joint measured from the poses: loop start 6 against THINK's 1.
    expect(gaps().slice(0, 3)).toEqual(['12 cm', '3.1 cm', '5 cm']);
    expect(detail().textContent).toContain('已改 1 处');
  });

  it('inserts the chosen clip before a segment and previews the proposed sequence', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence').mockResolvedValue(true);
    await edit(PONDER);
    await click(button('在此前插入', seg(PONDER_LOOP)));
    expect(segs()).toEqual([PONDER, FIDGET, PONDER_LOOP, PONDER_END]);
    expect(gaps().slice(0, 4)).toEqual(['12 cm', '0 cm', '1 cm', '0.4 cm']);
    await click(button('预览这条链'));
    expect(sequence).toHaveBeenLastCalledWith({ clips: [PONDER, FIDGET, PONDER_LOOP, PONDER_END], blend_s: [0.25, 0.25, 0.25] });
  });

  it('checks the proposal and lists its problems in Chinese beside their segments', async () => {
    const check = vi.spyOn(bridge.avatar.motionChain, 'check');
    await edit(PONDER);
    await act(async () => void fireEvent.change(within(seg(PONDER_LOOP)).getByRole('spinbutton', { name: '「dialog_state_think_loop」保持秒数' }), { target: { value: '3' } }));
    await click(button('在此前插入', seg(PONDER_LOOP)));
    await click(button('检查'));
    const sent = {
      schema: 'endfield-motion-chain-proposal/v1',
      character: 'si',
      package_sha256: SHA,
      edits: [
        { op: 'set', clip: PONDER_LOOP, hold: 3 },
        { op: 'insert', chain: PONDER, index: 1, clip: FIDGET },
      ],
    };
    expect(check).toHaveBeenLastCalledWith(sent);
    expect(detail().textContent).toContain('检查通过，会改动 1 条链');
    check.mockResolvedValueOnce({
      ok: false,
      problems: [
        { edit: 1, reason: `stance_breaks:${FIDGET}>${PONDER_LOOP}` },
        { edit: 0, reason: 'bad_hold' },
        { edit: null, reason: `no_return:${PONDER}` },
      ],
      graph_changes: { chains_added: [], chains_removed: [], chains_changed: [] },
    });
    await click(button('检查'));
    expect(seg(FIDGET).textContent).toContain('idle_fidget_01 接 dialog_state_think_loop 时站姿接不上');
    expect(seg(PONDER_LOOP).textContent).toContain('保持秒数只能给循环段，且不能小于 0');
    expect(detail().querySelector('[data-problems]')!.textContent).toContain('以 dialog_state_think_start 起头的链最后回不到起头的站姿');
  });

  it('names every reason motion_tool gives in Chinese', () => {
    const reasons = ['bad_proposal', 'stale', 'bad_edit', 'unknown_clip:a', 'unknown_chain:a', 'bad_index', 'bad_hold', 'bad_blend',
      'source_return:a', 'cycle:a', 'no_return:a', 'stance_breaks:a>b', 'chain_key_lost:a', 'pool_pose_unmeasured:a',
      'pool_start_family_unbridged:a', 'pool_chain_end_off_base:a'];
    for (const r of reasons) expect(reasonText(r)).toMatch(/[一-鿿]/);
    expect(reasonText('something_new:a')).toBe('something_new:a');
  });

  it('asks before rebuilding the pack, then applies the proposal and reads the graph again', async () => {
    const apply = vi.spyOn(bridge.avatar.motionChain, 'apply');
    const request = vi.spyOn(bridge.agentd, 'request');
    await edit(PONDER);
    await click(button('换成', seg(PONDER_END)));
    await click(button('应用到角色包（重建）'));
    const dialog = screen.getByRole('dialog', { name: '应用到角色包（重建）' });
    expect(dialog.textContent).toContain('重建');
    expect(dialog.textContent).toContain('一两分钟');
    expect(dialog.textContent).toContain('重新载入');
    expect(apply).not.toHaveBeenCalled();
    const reads = request.mock.calls.filter((c) => String(c[1]).endsWith('/motion-graph')).length;
    await click(within(dialog).getByRole('button', { name: '重建' }));
    expect(apply).toHaveBeenLastCalledWith({
      schema: 'endfield-motion-chain-proposal/v1',
      character: 'si',
      package_sha256: SHA,
      edits: [{ op: 'replace', chain: PONDER, index: 2, clip: FIDGET }],
    });
    expect(toast).toHaveBeenLastCalledWith('已应用到角色包（版本 1.2.43）');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(request.mock.calls.filter((c) => String(c[1]).endsWith('/motion-graph')).length).toBeGreaterThan(reads);
    expect(within(detail()).queryByRole('button', { name: '检查' })).toBeNull();
  });

  it('shows why the rebuild was refused, on the segment when the tool names its edit', async () => {
    const apply = vi.spyOn(bridge.avatar.motionChain, 'apply').mockRejectedValueOnce({
      code: 'chain_refused',
      detail: JSON.stringify([{ edit: 0, reason: `cycle:${PONDER}` }]),
    });
    await edit(PONDER);
    await click(button('换成', seg(PONDER_END)));
    await click(button('应用到角色包（重建）'));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(within(detail()).getByRole('alert').textContent).toContain('角色包没有接受这份改动');
    expect(seg(FIDGET).textContent).toContain('以 dialog_state_think_start 起头的链会绕回自己');
    apply.mockRejectedValueOnce({ code: 'stale', detail: '[{"edit": null, "reason": "stale"}]' });
    await click(button('应用到角色包（重建）'));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    expect(within(detail()).getByRole('alert').textContent).toContain('角色包在你编辑之后变过了');
    await click(button('放弃改动'));
    expect(segs()).toEqual([PONDER, PONDER_LOOP, PONDER_END]);
    expect(within(detail()).queryByRole('alert')).toBeNull();
  });

  it('greys out 检查 and 应用 when the graph does not name the pack it was read from', async () => {
    delete (MOTION_GRAPH as Record<string, unknown>).package_sha256;
    await edit(PONDER);
    await click(button('换成', seg(PONDER_END)));
    expect(button('检查').getAttribute('aria-disabled')).toBe('true');
    expect(button('应用到角色包（重建）').getAttribute('aria-disabled')).toBe('true');
    expect(detail().textContent).toContain('取不到当前角色包的版本');
  });
});
