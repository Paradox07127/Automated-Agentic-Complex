import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelMark } from '../../src/pages/chat/motion';

// jsdom has no Web Animations: record each animation with its iteration count.
class FakeAnimation {
  playState: AnimationPlayState = 'running';
  playbackRate = 1;
  currentTime: number | null = 0;
  readonly finished: Promise<FakeAnimation>;
  readonly iterations: number;
  private readonly live: Set<FakeAnimation>;
  private settle!: { resolve: (a: FakeAnimation) => void; reject: (e: unknown) => void };
  constructor(iterations: number, live: Set<FakeAnimation>) {
    this.iterations = iterations;
    this.live = live;
    this.finished = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.finished.catch(() => undefined);
  }
  get effect() {
    return { getComputedTiming: () => ({ iterations: this.iterations }) };
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
    this.live.delete(this);
    this.settle.reject(new DOMException('cancelled', 'AbortError'));
  }
}

const live = new Set<FakeAnimation>();
let focused = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const loops = () => [...live].filter((a) => a.iterations === Infinity);

beforeEach(() => {
  live.clear();
  focused = true;
  Object.assign(Element.prototype, {
    animate(_kf: Keyframe[], opts: KeyframeAnimationOptions) {
      const a = new FakeAnimation(opts.iterations ?? 1, live);
      live.add(a);
      return a;
    },
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).animate;
  document.documentElement.classList.remove('still');
});

describe('chat selected cell frame', () => {
  it('runs the selected loop only after the in clip, and only while the window has focus', async () => {
    render(<SelMark />);
    await settle();
    expect(live.size).toBeGreaterThan(0);
    expect(loops()).toEqual([]);
    for (const a of [...live]) a.finish();
    await settle();
    expect(loops().length).toBeGreaterThan(0);
    focused = false;
    await act(async () => void window.dispatchEvent(new Event('blur')));
    expect(loops()).toEqual([]);
  });

  it('shows the end frame with no loop in still mode', async () => {
    document.documentElement.classList.add('still');
    render(<SelMark />);
    await settle();
    await settle();
    expect([...live].every((a) => a.playState === 'finished')).toBe(true);
    expect(loops()).toEqual([]);
  });
});
