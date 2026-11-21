// 今天的任务面板动效：格子入场、选中（missioncell_selecting_in）和追踪环只跑一轮，空闲时没有无限循环。
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBridge } from '../../src/bridge';
import { createDispatcher } from '../../src/bridge/fake/agentd';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { mockRoutes } from '../../src/mock';
import { NOW } from '../../src/mock/fixtures';
import { runRows } from '../../src/pages/overview/briefModel';
import type { OverviewSnapshot } from '../../src/pages/overview/load';
import { loadBrief, type OverviewBrief } from '../../src/pages/overview/loadBrief';
import { RunningSection } from '../../src/pages/overview/RunningSection';
import { loadOverview } from './overviewReads';

const READY = { status: 'success', data: true } as const;
let snap: OverviewSnapshot;
let brief: OverviewBrief;

beforeAll(async () => {
  const dispatch = createDispatcher([...exampleRoutes, ...mockRoutes]);
  const spy = vi.spyOn(getBridge().agentd, 'request').mockImplementation((method, path, body) => dispatch(method, path, body));
  snap = await loadOverview(null, false);
  brief = await loadBrief(NOW);
  spy.mockRestore();
});

interface Rec {
  el: Element;
  props: string[];
  iterations: number;
  playState: AnimationPlayState;
  finish: () => void;
  cancel: () => void;
}

// jsdom has no Web Animations: record what the clips start.
const live: Rec[] = [];
beforeEach(() => {
  live.length = 0;
  Object.assign(Element.prototype, {
    animate(this: Element, kf: Keyframe[], opts: KeyframeAnimationOptions) {
      let settle!: (v: unknown) => void;
      let fail!: (e: unknown) => void;
      const finished = new Promise((res, rej) => ((settle = res), (fail = rej)));
      finished.catch(() => undefined);
      const rec: Rec & { finished: Promise<unknown>; playbackRate: number; play: () => void; pause: () => void; currentTime: number } = {
        el: this,
        props: Object.keys(kf[0] ?? {}).filter((k) => k !== 'offset' && k !== 'easing'),
        iterations: opts.iterations ?? 1,
        playState: 'running',
        finished,
        playbackRate: 1,
        currentTime: 0,
        play() {},
        pause() {},
        finish() {
          rec.playState = 'finished';
          settle(rec);
        },
        cancel() {
          rec.playState = 'idle';
          live.splice(live.indexOf(rec), 1);
          fail(new DOMException('cancelled', 'AbortError'));
        },
      };
      live.push(rec);
      return rec;
    },
  });
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).animate;
  document.documentElement.classList.remove('still');
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const keyOf = (r: Rec) => r.el.getAttribute('data-g');

function mount() {
  const r = runRows(snap, brief.convs ?? []);
  return render(<RunningSection q={READY} rows={r.rows} convs={r.convs} code={r.code} activeRuns={snap.active_runs} now={NOW} lost={false} go={vi.fn()} onJumpSession={() => {}} />);
}

describe('今天 mission cells', () => {
  it('fades each cell in once and leaves nothing looping', async () => {
    const { container } = mount();
    await settle();
    const cells = container.querySelectorAll('[data-g="cell"]');
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(live.some((a) => a.el === c && a.props.includes('opacity'))).toBe(true);
    expect(live.every((a) => a.iterations === 1)).toBe(true);
  });

  it('selects a row on focus: band, glow bar and flicker play, the tracking rings run one cycle, blur drops it', async () => {
    const { container } = mount();
    await settle();
    const btn = container.querySelector<HTMLButtonElement>('[data-run] button')!;
    await act(async () => void fireEvent.focus(btn));
    await settle();
    expect(btn.hasAttribute('data-sel')).toBe(true);
    const keys = new Set(live.filter((a) => btn.contains(a.el)).map(keyOf));
    for (const k of ['band', 'bar', 'line', 'mask', 'twill', 'ring', 'ring1', 'ring2', 'ringOuter']) expect(keys).toContain(k);
    expect(live.find((a) => keyOf(a) === 'band')?.props).toEqual(['--size-x']);
    expect(live.every((a) => a.iterations === 1)).toBe(true);
    for (const a of live.filter((x) => keyOf(x)?.startsWith('ring'))) a.finish();
    await settle();
    expect(btn.querySelector('[data-g="ring"]')).toBeNull();
    expect(btn.querySelector('[data-g="band"]')).not.toBeNull();
    await act(async () => void fireEvent.blur(btn));
    expect(btn.hasAttribute('data-sel')).toBe(false);
    expect(btn.querySelector('[data-g="band"]')).toBeNull();
    // The label and role stay as they were.
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });

  it('in a still shot shows the selection at its end frame and skips the rings', async () => {
    document.documentElement.classList.add('still');
    const { container } = mount();
    await settle();
    const btn = container.querySelector<HTMLButtonElement>('[data-run] button')!;
    await act(async () => void fireEvent.focus(btn));
    await settle();
    const sel = live.filter((a) => btn.contains(a.el));
    expect(sel.length).toBeGreaterThan(0);
    expect(sel.every((a) => a.playState === 'finished')).toBe(true);
    expect(btn.querySelector('[data-g="ring"]')).toBeNull();
  });
});
