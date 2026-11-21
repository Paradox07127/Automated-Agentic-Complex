import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gameClips, type GameClip } from '../../src/design/gameClips.generated';
import { Archive } from '../../src/pages/memory/Archive';

// jsdom has no Web Animations: each started animation is recorded with the data-g key of its target.
class FakeAnimation {
  playState: AnimationPlayState = 'running';
  playbackRate = 1;
  currentTime: number | null = 0;
  readonly finished: Promise<FakeAnimation>;
  readonly key: string;
  readonly duration: number;
  private settle!: { resolve: (a: FakeAnimation) => void; reject: (e: unknown) => void };
  constructor(key: string, duration: number) {
    this.key = key;
    this.duration = duration;
    this.finished = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.finished.catch(() => undefined);
  }
  play() {
    if (this.playState !== 'finished') this.playState = 'running';
  }
  pause() {
    this.playState = 'paused';
  }
  finish() {
    this.playState = 'finished';
    this.settle.resolve(this);
  }
  cancel() {
    this.playState = 'idle';
    live.delete(this);
    this.settle.reject(new DOMException('cancelled', 'AbortError'));
  }
}

const live = new Set<FakeAnimation>();
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const keys = (d: number) => [...new Set([...live].filter((a) => a.duration === d).map((a) => a.key))].sort();
const finishAll = () => {
  for (const a of [...live]) if (a.playState === 'running') a.finish();
};
const trackKeys = (clip: GameClip, shown: string[]) => [...new Set(clip.tracks.map((t) => t.key))].filter((k) => shown.includes(k)).sort();

beforeEach(() => {
  live.clear();
  Object.assign(Element.prototype, {
    animate(this: Element, _kf: Keyframe[], opts: KeyframeAnimationOptions) {
      const a = new FakeAnimation(this.getAttribute('data-g') ?? '', Number(opts.duration));
      live.add(a);
      return a;
    },
  });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).animate;
});

const props = { tasks: [], about: { count: 2, asks: 1 }, knowledge: { count: 3, asks: 0 }, lastRun: null, onOpen: () => undefined };

describe('记忆 › 情报档案 motion', () => {
  it('plays prtsIn, then prtsInSettle, and leaves nothing attached at rest', async () => {
    const { container } = render(<Archive {...props} />);
    await settle();
    const shown = [...container.querySelectorAll('[data-g]')].map((e) => e.getAttribute('data-g') ?? '');
    expect(keys(gameClips.prtsIn.duration)).toEqual(trackKeys(gameClips.prtsIn, shown));
    expect(keys(gameClips.prtsInSettle.duration)).toEqual([]);
    finishAll();
    await settle();
    expect(keys(gameClips.prtsInSettle.duration)).toEqual(trackKeys(gameClips.prtsInSettle, shown));
    finishAll();
    await settle();
    expect(live.size).toBe(0);
  });

  it('runs the card hover forward on pointer in and backward on pointer out', async () => {
    const { getByRole } = render(<Archive {...props} />);
    await settle();
    finishAll();
    await settle();
    finishAll();
    await settle();
    const card = getByRole('button', { name: /用户档案/ });
    fireEvent.pointerEnter(card);
    expect(keys(gameClips.prtsCardHover.duration)).toEqual(['art', 'frame', 'icon', 'light']);
    fireEvent.pointerLeave(card);
    expect([...live].every((a) => a.playbackRate === -1)).toBe(true);
  });

  it('plays prtsOut when the page asks the panel to leave', async () => {
    const leave: { current: (() => Promise<void>) | null } = { current: null };
    render(<Archive {...props} leave={leave} />);
    await settle();
    expect(leave.current).not.toBeNull();
    let left = false;
    void act(() => leave.current!().then(() => void (left = true)));
    const out = [...live].filter((a) => a.duration === gameClips.prtsOut.duration);
    expect(out.length).toBeGreaterThan(0);
    for (const a of out) a.finish();
    await settle();
    expect(left).toBe(true);
  });
});
