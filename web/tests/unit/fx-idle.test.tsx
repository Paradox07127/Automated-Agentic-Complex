import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiCatalog } from '../fixtures/catalog/catalog';
import { gameClips, type GameClip } from '../../src/design/gameClips.generated';
import { useGameClip } from '../../src/ui';
import { WatchSample } from '../../src/ui/fx/samples';
import { Sway } from '../../src/pages/home/watchMotion';

// jsdom has no Web Animations: a small stand-in records every animation the kit starts.
class FakeAnimation {
  playState: AnimationPlayState = 'running';
  playbackRate = 1;
  currentTime: number | null = 0;
  readonly finished: Promise<FakeAnimation>;
  readonly iterations: number;
  private readonly live: Set<FakeAnimation>;
  private settle!: { resolve: (a: FakeAnimation) => void; reject: (e: unknown) => void };
  constructor(iterations: number, registry: Set<FakeAnimation>) {
    this.iterations = iterations;
    this.live = registry;
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
    if (this.iterations === Infinity) throw new DOMException('infinite', 'InvalidStateError');
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
let visible = true;
const FX = ['GameClip', 'Stage3D', 'GlowLayer', 'Frosted', 'RadialFill', 'MaskSweep', 'GlitchIn', 'Breath'];

beforeEach(() => {
  live.clear();
  visible = true;
  Object.assign(Element.prototype, {
    animate(this: Element, _kf: Keyframe[], opts: KeyframeAnimationOptions) {
      const a = new FakeAnimation(opts.iterations ?? 1, live);
      live.add(a);
      return a;
    },
  });
  Object.assign(document, { getAnimations: () => [...live] });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        this.cb([{ target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (Element.prototype as Partial<Element>).animate;
  delete (document as Partial<Document>).getAnimations;
  document.documentElement.classList.remove('still');
});

function WatchSampleForTest({ clip }: { clip: GameClip }) {
  const ref = useRef<HTMLDivElement>(null);
  useGameClip(clip, ref, { autoplay: true });
  return (
    <div ref={ref}>
      <WatchSample />
    </div>
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

function finishEntrances() {
  for (const a of [...live]) if (a.iterations !== Infinity && a.playState === 'running') a.finish();
}

function mountAllDemos() {
  const entries = uiCatalog.filter((e) => FX.includes(e.name));
  expect(entries.map((e) => e.name).sort()).toEqual([...FX].sort());
  return render(
    <div>
      {entries.flatMap((e) => e.demos.map((d) => <e.component key={`${e.name}-${d.name}`} {...d.props} />))}
    </div>,
  );
}

describe('fx kit at rest', () => {
  it('leaves no infinite animation once the entrances end; only the visible Breath dots loop', async () => {
    const { container } = mountAllDemos();
    await settle();
    expect(live.size).toBeGreaterThan(0);
    finishEntrances();
    await settle();
    const infinite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity);
    expect(infinite).toEqual([]);
    const dots = container.querySelectorAll('[data-stub="Breath"]');
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) expect(d.hasAttribute('data-live')).toBe(true);
  });

  it('keeps Breath still while it is off screen', async () => {
    visible = false;
    const { container } = mountAllDemos();
    await settle();
    for (const d of container.querySelectorAll('[data-stub="Breath"]')) expect(d.hasAttribute('data-live')).toBe(false);
  });
});

describe('useGameClip', () => {
  it('jumps to the end frame in still mode and leaves a loop at rest', async () => {
    document.documentElement.classList.add('still');
    render(<WatchSampleForTest clip={gameClips.watchIn} />);
    await settle();
    expect(live.size).toBeGreaterThan(0);
    expect([...live].every((a) => a.playState === 'finished')).toBe(true);
    cleanup();
    live.clear();
    render(<WatchSampleForTest clip={gameClips.watchLoop} />);
    await settle();
    expect(live.size).toBe(0);
  });

  it('pauses a loop while the document is hidden', async () => {
    render(<WatchSampleForTest clip={gameClips.watchLoop} />);
    await settle();
    const loops = [...live];
    expect(loops.length).toBeGreaterThan(0);
    expect(loops.every((a) => a.iterations === Infinity)).toBe(true);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(loops.every((a) => a.playState === 'paused')).toBe(true);
    hidden.mockReturnValue(false);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(loops.every((a) => a.playState === 'running')).toBe(true);
  });

  it('holds the watch loop where it stands while the window is away and goes on from there', async () => {
    function Watch({ on }: { on: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <WatchSample />
          <Sway root={ref} on={on} />
        </div>
      );
    }
    const { rerender } = render(<Watch on />);
    await settle();
    const loops = [...live];
    expect(loops.length).toBeGreaterThan(0);
    rerender(<Watch on={false} />);
    expect(loops.every((a) => a.playState === 'paused' && live.has(a))).toBe(true);
    rerender(<Watch on />);
    expect([...live]).toEqual(loops);
    expect(loops.every((a) => a.playState === 'running')).toBe(true);
  });

  it('drives every data-g node a track names and plays hover backwards on reverse', async () => {
    let controls: ReturnType<typeof useGameClip> | undefined;
    function Hover() {
      const ref = useRef<HTMLDivElement>(null);
      controls = useGameClip(gameClips.keyboardBtnHover, ref);
      return (
        <div ref={ref}>
          {['btn', 'face', 'icon', 'label'].map((k) => (
            <span key={k} data-g={k} />
          ))}
        </div>
      );
    }
    render(<Hover />);
    expect(live.size).toBe(0);
    act(() => void controls!.play());
    expect(live.size).toBe(gameClips.keyboardBtnHover.tracks.length);
    act(() => void controls!.reverse());
    expect([...live].every((a) => a.playbackRate === -1)).toBe(true);
  });
});
