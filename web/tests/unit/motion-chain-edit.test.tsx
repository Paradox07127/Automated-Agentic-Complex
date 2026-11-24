// 编排 → 编辑结构: picking a segment or a 「+」, swapping and inserting clips from the candidate list, gaps re-measured from the
// graph's 17 key-bone poses, the hold, 检查, and 「应用到角色包（重建）」 with its confirmation and its failures.
import { focusManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';
import type { Toast } from '../../src/pages/character/feedback';
import { keyBoneGap, poseGap } from '../../src/pages/character/motions/chainEdit';
import { reasonText } from '../../src/pages/character/motions/chainReasons';
import { indexGraph } from '../../src/pages/character/motions/chainPath';
import type { MotionGraph } from '../../src/pages/character/motions/graph';
import { click, detail, FIDGET, IDLE, mount, openChain, PAT, PONDER, PONDER_END, PONDER_LOOP, RELAX, THINK, TO_RELAX, WAVE } from './chainPage';

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

const seg = (clip: string) => detail().querySelector<HTMLElement>(`[data-seg="${clip}"]`)!;
const segs = () => [...detail().querySelectorAll<HTMLElement>('[data-seg]')].map((s) => s.dataset.seg);
const gaps = () => [...detail().querySelectorAll<HTMLElement>('[data-joint]')].map((j) => j.children[2]!.textContent);
const cands = () => [...detail().querySelectorAll<HTMLElement>('[data-cand]')];
const cand = (clip: string) => detail().querySelector<HTMLElement>(`[data-cand="${clip}"]`)!;
const band = () => screen.getByRole('group', { name: '结构提案' });

async function edit(key: string) {
  await mount(toast);
  await openChain(key);
  await click(within(detail()).getByRole('button', { name: '编辑结构' }));
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
  g.package_sha256 = 'a'.repeat(64);
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
    expect(poseGap(g, ix, PONDER_LOOP, FIDGET)).toBe(1);
    expect(poseGap(g, ix, PONDER, WAVE)).toBe(15);
    expect(poseGap(g, ix, PONDER, PAT)).toBeNull();
  });
});

describe('编辑结构', () => {
  it('swaps a picked segment for a clip of the same stance and family, nearest first, and re-measures its joints', async () => {
    await edit(PONDER);
    // The first segment cannot be swapped: the pick starts on the second.
    expect(seg(PONDER_LOOP).getAttribute('aria-pressed')).toBe('true');
    expect(seg(PONDER).tagName).toBe('DIV');
    await click(seg(PONDER_END));
    expect(detail().textContent).toContain('第 3 段：换成或插在它前面');
    expect(cands().slice(0, 3).map((c) => [c.dataset.cand, c.children[1]!.textContent])).toEqual([
      [FIDGET, '前 1 cm'],
      [THINK, '前 5 cm'],
      [IDLE, '前 6 cm'],
    ]);
    // Unmeasured last, by name; clips already in the chain are not offered.
    expect(cands().slice(-3).map((c) => c.dataset.cand)).toEqual([PAT, RELAX, TO_RELAX]);
    expect(cands().some((c) => c.dataset.cand!.includes('dialog_state_think'))).toBe(false);
    await click(within(cand(THINK)).getByRole('button', { name: '换成' }));
    expect(segs()).toEqual([PONDER, PONDER_LOOP, THINK]);
    expect(seg(THINK).hasAttribute('data-new')).toBe(true);
    // Entry 12 (edge), 3.1 (edge), then the new joint measured from the poses: loop start 6 against THINK's 1.
    expect(gaps().slice(0, 3)).toEqual(['12 cm', '3.1 cm', '5 cm']);
    expect(band().textContent).toContain('结构提案 │ 1 处');
  });

  it('inserts before the segment a 「+」 picks and previews the proposed sequence', async () => {
    const sequence = vi.spyOn(bridge.avatar.preview, 'sequence').mockResolvedValue(true);
    await edit(PONDER);
    await click(within(detail()).getByRole('button', { name: '在「dialog_state_think_loop」前插入' }));
    await click(within(cand(FIDGET)).getByRole('button', { name: '在此前插入' }));
    expect(segs()).toEqual([PONDER, FIDGET, PONDER_LOOP, PONDER_END]);
    expect(gaps().slice(0, 4)).toEqual(['12 cm', '0 cm', '1 cm', '0.4 cm']);
    await click(within(detail()).getByRole('button', { name: /舞台预览/ }));
    expect(sequence).toHaveBeenLastCalledWith({ clips: [PONDER, FIDGET, PONDER_LOOP, PONDER_END], blend_s: [0.25, 0.25, 0.25] });
  });

  it('sets a loop’s hold, checks the proposal and lists its problems in Chinese beside their segments', async () => {
    const check = vi.spyOn(bridge.avatar.motionChain, 'check');
    await edit(PONDER);
    const hold = within(detail()).getByRole('spinbutton', { name: '「dialog_state_think_loop」保持秒数' }) as HTMLInputElement;
    expect(hold.value).toBe('2.0');
    await act(async () => {
      fireEvent.change(hold, { target: { value: '3' } });
      fireEvent.blur(hold);
    });
    await click(within(cand(FIDGET)).getByRole('button', { name: '在此前插入' }));
    await click(within(band()).getByRole('button', { name: '检查' }));
    expect(check).toHaveBeenLastCalledWith({
      schema: 'endfield-motion-chain-proposal/v1',
      character: 'si',
      package_sha256: SHA,
      edits: [
        { op: 'set', clip: PONDER_LOOP, hold: 3 },
        { op: 'insert', chain: PONDER, index: 1, clip: FIDGET },
      ],
    });
    expect(band().textContent).toContain('检查通过，会改动 1 条链');
    check.mockResolvedValueOnce({
      ok: false,
      problems: [
        { edit: 1, reason: `stance_breaks:${FIDGET}>${PONDER_LOOP}` },
        { edit: 0, reason: 'bad_hold' },
        { edit: null, reason: `no_return:${PONDER}` },
      ],
      graph_changes: { chains_added: [], chains_removed: [], chains_changed: [] },
    });
    await click(within(band()).getByRole('button', { name: '检查' }));
    expect(seg(FIDGET).textContent).toContain('idle_fidget_01 接 dialog_state_think_loop 时站姿接不上');
    expect(seg(PONDER_LOOP).textContent).toContain('保持秒数只能给循环段，且不能小于 0');
    expect(band().querySelector('[data-problems]')!.textContent).toContain('以 dialog_state_think_start 起头的链最后回不到起头的站姿');
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
    await click(seg(PONDER_END));
    await click(within(cand(FIDGET)).getByRole('button', { name: '换成' }));
    await click(within(band()).getByRole('button', { name: '应用到角色包（重建）' }));
    const dialog = screen.getByRole('dialog', { name: '应用到角色包（重建）' });
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
    expect(screen.queryByRole('group', { name: '结构提案' })).toBeNull();
  });

  it('shows why the rebuild was refused, on the segment when the tool names its edit', async () => {
    const apply = vi.spyOn(bridge.avatar.motionChain, 'apply').mockRejectedValueOnce({
      code: 'chain_refused',
      detail: JSON.stringify([{ edit: 0, reason: `cycle:${PONDER}` }]),
    });
    await edit(PONDER);
    await click(seg(PONDER_END));
    await click(within(cand(FIDGET)).getByRole('button', { name: '换成' }));
    await click(within(band()).getByRole('button', { name: '应用到角色包（重建）' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(within(band()).getByRole('alert').textContent).toContain('角色包没有接受这份改动');
    expect(seg(FIDGET).textContent).toContain('以 dialog_state_think_start 起头的链会绕回自己');
    apply.mockRejectedValueOnce({ code: 'stale', detail: '[{"edit": null, "reason": "stale"}]' });
    await click(within(band()).getByRole('button', { name: '应用到角色包（重建）' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    expect(within(band()).getByRole('alert').textContent).toContain('角色包在你编辑之后变过了');
    await click(within(band()).getByRole('button', { name: '放弃改动' }));
    expect(segs()).toEqual([PONDER, PONDER_LOOP, PONDER_END]);
    expect(within(band()).queryByRole('alert')).toBeNull();
  });

  it('applies no edit against a pack that changed since the edit was made, and says so', async () => {
    const apply = vi.spyOn(bridge.avatar.motionChain, 'apply');
    const real = bridge.agentd.request.bind(bridge.agentd);
    const request = vi.spyOn(bridge.agentd, 'request');
    await edit(PONDER);
    await click(seg(PONDER_END));
    await click(within(cand(FIDGET)).getByRole('button', { name: '换成' }));
    const reads = request.mock.calls.filter((c) => String(c[1]).endsWith('/motion-graph')).length;
    // A motion import rebuilt the pack.
    request.mockImplementation(async (method, path, body) => {
      const r = await real(method, path, body);
      return String(path).endsWith('/motion-graph') ? ({ ...r, body: { ...(r.body as object), package_sha256: 'cd'.repeat(32) } } as typeof r) : r;
    });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(request.mock.calls.filter((c) => String(c[1]).endsWith('/motion-graph')).length).toBeGreaterThan(reads));
    await waitFor(() => expect(band().textContent).toContain('角色包在你编辑之后变过了'));
    await click(within(band()).getByRole('button', { name: '应用到角色包（重建）' }));
    const dialog = screen.queryByRole('dialog');
    if (dialog) await click(within(dialog).getByRole('button', { name: '重建' }));
    expect(apply).not.toHaveBeenCalled();
    focusManager.setFocused(undefined);
  });

  it('takes no new edit while an apply is out', async () => {
    let answer!: () => void;
    vi.spyOn(bridge.avatar.motionChain, 'apply').mockImplementationOnce(
      (p) => new Promise((r) => (answer = () => r({ ok: true, character: p.character, version: '1.2.43' }))),
    );
    await edit(PONDER);
    await click(seg(PONDER_END));
    await click(within(cand(FIDGET)).getByRole('button', { name: '换成' }));
    await click(within(band()).getByRole('button', { name: '应用到角色包（重建）' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: '重建' }));
    for (const b of within(detail().querySelector<HTMLElement>('[data-candidates]')!).getAllByRole('button', { name: '换成' })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => answer());
  });

  it('greys out 检查 and 应用 when the graph does not name the pack it was read from', async () => {
    delete (MOTION_GRAPH as Record<string, unknown>).package_sha256;
    await edit(PONDER);
    await click(within(cand(FIDGET)).getByRole('button', { name: '换成' }));
    expect((within(band()).getByRole('button', { name: '检查' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(band()).getByRole('button', { name: '应用到角色包（重建）' }) as HTMLButtonElement).disabled).toBe(true);
    expect(band().textContent).toContain('取不到当前角色包的版本');
  });
});
