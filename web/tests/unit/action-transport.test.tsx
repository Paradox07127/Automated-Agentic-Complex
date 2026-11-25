// The player of a desktop play (C3 rule 58): elapsed / total, a bar that follows her reports, pause and resume, a click or
// a drag on the bar to seek, ←/→ 5 s and Space; on the MMD page's timeline and in the character page's bottom bar.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionProgress, PreviewPlacement } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, MmdEntry } from '../../src/bridge/protocol';
import { CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator } from '../../src/pages/character/Operator';
import { Transport } from '../../src/pages/character/Transport';
import { MmdPage } from '../../src/pages/mmd/Page';

vi.mock('../../src/shell/toast', async (original) => ({ ...(await original<typeof import('../../src/shell/toast')>()), toast: vi.fn() }));

const RECT = { x: 40, y: 120, width: 300, height: 360, top: 120, left: 40, right: 340, bottom: 480, toJSON: () => ({}) } as DOMRect;
const EMPTY = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
/** The bar: 200 px wide from x 100. */
const BAR = { x: 100, y: 0, width: 200, height: 8, top: 0, left: 100, right: 300, bottom: 8, toJSON: () => ({}) } as DOMRect;
const noop = () => {};

let bridge: AgenticComplexBridge;
/** The page's progress listeners. */
const listeners = new Set<(p: ActionProgress | null) => void>();

function install() {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  listeners.clear();
  vi.spyOn(bridge.avatar, 'onActionProgress').mockImplementation((cb) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if ('transportBar' in this.dataset) return BAR;
    return 'previewStage' in this.dataset || 'previewLayer' in this.dataset ? RECT : EMPTY;
  });
  return {
    control: vi.spyOn(bridge.avatar, 'controlAction').mockResolvedValue(),
    play: vi.spyOn(bridge.avatar, 'playAction').mockResolvedValue(),
    show: vi.spyOn(bridge.avatar.preview, 'show').mockImplementation(async (_at: PreviewPlacement) => true),
  };
}
const push = (p: ActionProgress | null) => act(async () => listeners.forEach((l) => l(p)));
const player = () => screen.getByRole('group', { name: '播放器' });
const bar = () => within(player()).getByRole('slider', { name: '播放进度' });

beforeEach(() => void install());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.agenticComplex;
});

describe('Transport', () => {
  const at = (o: Partial<ActionProgress> = {}): ActionProgress => ({ id: 'mmd_a', tS: 41.6, durationS: 184.2, paused: false, ...o });

  it('shows elapsed / total and the share played; the key pauses a play and resumes a paused one', () => {
    const onControl = vi.fn();
    const { rerender } = render(<Transport progress={at()} onControl={onControl} />);
    expect(player().textContent).toContain('0:41 / 3:04');
    expect(bar().getAttribute('aria-valuenow')).toBe('41.6');
    expect(bar().getAttribute('aria-valuemax')).toBe('184.2');
    expect(bar().getAttribute('aria-valuetext')).toBe('0:41 / 3:04');
    fireEvent.click(within(player()).getByRole('button', { name: '暂停' }));
    rerender(<Transport progress={at({ paused: true })} onControl={onControl} />);
    fireEvent.click(within(player()).getByRole('button', { name: '继续' }));
    expect(onControl.mock.calls).toEqual([['pause'], ['resume']]);
  });

  it('← and → seek 5 s within the clip; Space pauses or resumes', () => {
    const onControl = vi.fn();
    const { rerender } = render(<Transport progress={at({ tS: 2 })} onControl={onControl} />);
    fireEvent.keyDown(bar(), { key: 'ArrowRight' });
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' });
    fireEvent.keyDown(bar(), { key: ' ' });
    rerender(<Transport progress={at({ tS: 182, paused: true })} onControl={onControl} />);
    fireEvent.keyDown(bar(), { key: 'ArrowRight' });
    fireEvent.keyDown(bar(), { key: ' ' });
    expect(onControl.mock.calls).toEqual([['seek', 7], ['seek', 0], ['pause'], ['seek', 184.2], ['resume']]);
  });

  it('a click on the bar seeks there; a drag follows the pointer and seeks once, where it is let go', () => {
    const onControl = vi.fn();
    render(<Transport progress={at({ tS: 10, durationS: 100 })} onControl={onControl} />);
    fireEvent.pointerDown(bar(), { clientX: 150, pointerId: 1, button: 0 });
    fireEvent.pointerUp(bar(), { clientX: 150, pointerId: 1, button: 0 });
    expect(onControl.mock.calls).toEqual([['seek', 25]]);
    fireEvent.pointerDown(bar(), { clientX: 120, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar(), { clientX: 260, pointerId: 1 });
    expect(player().textContent).toContain('1:20 / 1:40');
    fireEvent.pointerMove(bar(), { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(bar(), { clientX: 400, pointerId: 1, button: 0 });
    expect(onControl.mock.calls).toEqual([['seek', 25], ['seek', 100]]);
  });
});

const DANCE: MmdEntry = { id: 'mmd_a', title: '舞蹈甲', durationS: 12.5, hasBgm: true, hasCamera: false, hasFace: false, project: null, role: null,
  createdAt: '2026-11-17T10:00:00+00:00', characters: [{ id: 'si', state: 'baked', reason: null }] };

async function mountMmd() {
  vi.spyOn(bridge.mmd, 'list').mockResolvedValue({ ok: true, entries: [DANCE] });
  vi.spyOn(bridge.avatar, 'actions').mockResolvedValue([{ id: 'mmd_a', label: '舞蹈甲', enabled: true, section: 'idle', durationS: 12.5, playable: true }]);
  const root = createRootRoute({ component: MmdPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/?still=1'] }) });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('region', { name: 'MMD 库' });
  await waitFor(() => expect(document.querySelector('[data-mmd-detail="mmd_a"]')).not.toBeNull());
}
const timeline = () => screen.getByRole('region', { name: '时间线' });
const seekBar = () => within(timeline()).getByRole('slider', { name: '播放进度' });
const clockText = () => within(timeline()).getByLabelText('时钟').textContent;

describe('MMD page timeline', () => {
  it('follows the dance the desktop plays while she reports it, and goes back to the preview at the end', async () => {
    const { control } = install();
    await mountMmd();
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    expect(seekBar().getAttribute('aria-disabled')).toBe('true');
    await push({ id: 'mmd_a', tS: 3.2, durationS: 12.5, paused: false });
    expect(clockText()).toBe('0:03.2/ 0:12.5');
    await act(async () => void fireEvent.click(within(timeline()).getByRole('button', { name: '暂停' })));
    expect(control).toHaveBeenCalledWith('pause');
    await act(async () => void fireEvent.keyDown(seekBar(), { key: 'ArrowRight' }));
    expect(control).toHaveBeenLastCalledWith('seek', 8.2);
    await push({ id: 'mmd_other', tS: 1, durationS: 9, paused: false });
    expect(clockText()).toBe('0:00.0/ 0:12.5');
    await push({ id: 'mmd_a', tS: 9, durationS: 12.5, paused: true });
    expect(within(timeline()).getByRole('button', { name: '继续' })).toBeTruthy();
    await push(null);
    expect(seekBar().getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps the playhead where it was let go until her next report after the seek', async () => {
    const { control } = install();
    let settle = noop;
    control.mockImplementation(() => new Promise<void>((resolve) => void (settle = resolve)));
    await mountMmd();
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    await push({ id: 'mmd_a', tS: 1, durationS: 10, paused: false });
    await act(async () => {
      fireEvent.pointerDown(seekBar(), { clientX: 250, pointerId: 1, button: 0 });
      fireEvent.pointerUp(seekBar(), { clientX: 250, pointerId: 1, button: 0 });
    });
    expect(control).toHaveBeenCalledWith('seek', 7.5);
    // A report sent before she took the seek does not pull the playhead back.
    await push({ id: 'mmd_a', tS: 1.25, durationS: 10, paused: false });
    expect(seekBar().getAttribute('aria-valuenow')).toBe('7.5');
    await act(async () => settle());
    await push({ id: 'mmd_a', tS: 7.5, durationS: 10, paused: false });
    await push({ id: 'mmd_a', tS: 7.75, durationS: 10, paused: false });
    expect(seekBar().getAttribute('aria-valuenow')).toBe('7.75');
  });
});

describe('character page bottom bar', () => {
  function Op() {
    return (
      <Operator
        roster={[{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [] }]}
        current="si"
        sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
        offline={false}
        backoff={null}
        onRestart={noop}
        actions={MOTIONS}
        motionsError={null}
        onRetryMotions={noop}
        charState={STATE_WITH_CAUSES}
        toast={noop}
      />
    );
  }
  const commit = () => document.querySelector('[data-commit]') as HTMLElement;

  it('plays the motion, then shows its player in the bar while she reports it; paused, the play does not end on its own', async () => {
    const { control } = install();
    render(<Op />);
    await act(async () => void fireEvent.click(screen.getByRole('grid', { name: '全部动作' }).querySelector('[data-motion="nod"] button')!));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /桌面预览/ })));
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    expect(within(commit()).queryByRole('group', { name: '播放器' })).toBeNull();
    await push({ id: 'nod', tS: 0.25, durationS: 1.2, paused: false });
    expect(within(commit()).getByRole('group', { name: '播放器' }).textContent).toContain('0:00 / 0:01');
    await push({ id: 'nod', tS: 0.5, durationS: 1.2, paused: true });
    await act(async () => void fireEvent.click(within(player()).getByRole('button', { name: '继续' })));
    expect(control).toHaveBeenCalledWith('resume');
    // Past the motion's 1.2 s: paused, it is still her play.
    await act(async () => void (await new Promise((r) => setTimeout(r, 1500))));
    const stage = document.querySelector('[data-stage]') as HTMLElement;
    expect(within(stage).getByRole('status').textContent).toContain('桌面播放中 │ 点头附和');
    await push(null);
    expect(within(commit()).queryByRole('group', { name: '播放器' })).toBeNull();
    await waitFor(() => expect(within(stage).queryByRole('status')).toBeNull());
  });
});
