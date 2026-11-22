// Section switches on 角色 (PhaseCharInfo.OnPageChange): the leaving section's out clip, a wait of max(200 ms, out), then the
// entering section's in clip; a new switch cuts the run, the stage stays the same node, reduced motion switches at once.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { gameClips } from '../../src/design/gameClips.generated';
import { CHARACTER_LOOKS } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';

const noop = () => {};
const characters = [
  { id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: CHARACTER_LOOKS.si ?? [] },
  { id: 'voice_a', name: '示例甲', en: 'VOICE_A', active: false, voice: true, appearances: CHARACTER_LOOKS.voice_a ?? [] },
];

function Op(over: Partial<OperatorProps> = {}) {
  return (
    <Operator
      roster={characters}
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
      {...over}
    />
  );
}

// jsdom has no Web Animations: each run is recorded and ends after its delay and duration on the fake clock.
interface FakeRun {
  el: Element;
  frames: Keyframe[];
  opts: KeyframeAnimationOptions;
  state: 'running' | 'finished' | 'cancelled';
  /** cancel() was called, finished or not: a finished `forwards` run holds its last frame until then. */
  dropped?: boolean;
}
let runs: FakeRun[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  runs = [];
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
  Object.assign(Element.prototype, {
    animate(this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      const run: FakeRun = { el: this, frames, opts, state: 'running' };
      runs.push(run);
      let done = () => {};
      const finished = new Promise<void>((resolve) => (done = resolve));
      const timer = setTimeout(() => {
        run.state = 'finished';
        done();
      }, Number(opts.delay ?? 0) + Number(opts.duration ?? 0));
      return {
        finished,
        playbackRate: 1,
        currentTime: 0,
        play() {},
        pause() {},
        finish() {},
        commitStyles() {},
        cancel() {
          clearTimeout(timer);
          if (run.state === 'running') run.state = 'cancelled';
          run.dropped = true;
        },
      };
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (Element.prototype as Partial<Element>).animate;
  delete window.agenticComplex;
  Reflect.deleteProperty(window, 'matchMedia');
});

const at = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const strip = () => screen.queryByRole('group', { name: '角色头像' });
const motions = () => screen.queryByRole('region', { name: '动作开关' });
const look = () => screen.queryByRole('region', { name: '角色外观与大小' });
const stage = () => document.querySelector('[data-preview-stage]');
const railAt = () => screen.getByRole('navigation', { name: '角色分区' }).querySelector('[aria-current="page"]')?.textContent;
const panel = () => document.querySelector('[data-switch="panel"]');

describe('character section switch', () => {
  it('总览 → 动作: the overview parts play their out clips, nothing is drawn at 150 ms, the panel comes in at 200 ms', async () => {
    const r = render(<Op pane="overview" />);
    const heads = strip();
    expect(heads).not.toBeNull();
    runs = [];
    r.rerender(<Op pane="motion" />);
    // The state changes at once: the rail lights 动作; the leaving parts stay, inert, while their out clips play.
    expect(railAt()).toContain('动作');
    expect(strip()).toBe(heads);
    expect(heads?.closest('[inert]')).not.toBeNull();
    expect(runs.find((x) => x.el === heads)?.opts).toMatchObject({ duration: gameClips.charListOut.duration, fill: 'forwards' });
    expect(motions()).toBeNull();

    await at(150);
    expect(strip()).toBeNull();
    expect(document.querySelector('[data-switch="brand"]')).toBeNull();
    expect(motions()).toBeNull();
    expect(document.querySelector('[data-stage]')?.getAttribute('data-mode')).toBe('overview');

    await at(50);
    expect(motions()).not.toBeNull();
    expect(document.querySelector('[data-stage]')?.getAttribute('data-mode')).toBe('detail');
    // charinfoweapon_right_in on the panel's blocks, 0 and 83 ms apart (charinfoprofile_in's block starts).
    const blocks = runs.filter((x) => x.el.parentElement === panel());
    expect([...new Set(blocks.map((x) => x.opts.delay))]).toEqual([0, 83]);
    expect(blocks.every((x) => x.opts.duration === gameClips.charRightIn.duration)).toBe(true);
    expect(blocks.every((x) => x.state === 'running')).toBe(true);

    await at(gameClips.charRightIn.duration + 83);
    expect(blocks.every((x) => x.state !== 'running')).toBe(true);
    expect(motions()).not.toBeNull();
  });

  it('a second switch mid-way cuts the run and ends on the second section, without a queue', async () => {
    const r = render(<Op pane="overview" />);
    r.rerender(<Op pane="motion" />);
    await at(100);
    r.rerender(<Op pane="look" />);
    // No wait for the cut run: 外观 is drawn at once with its in clip.
    expect(look()).not.toBeNull();
    expect(motions()).toBeNull();
    expect(strip()).toBeNull();
    await at(2000);
    expect(look()).not.toBeNull();
    expect(motions()).toBeNull();
    expect(railAt()).toContain('外观');
  });

  it('keeps the one stage node through out, wait and in', async () => {
    const r = render(<Op pane="overview" />);
    const node = stage();
    expect(node).not.toBeNull();
    r.rerender(<Op pane="motion" />);
    expect(stage()).toBe(node);
    await at(150);
    expect(stage()).toBe(node);
    await at(1000);
    expect(stage()).toBe(node);
    expect(runs.some((x) => x.el === node)).toBe(false);
  });

  it('the stage\'s name column that becomes its status slot is live again once the detail section is in', async () => {
    const r = render(<Op pane="overview" />);
    const info = document.querySelector('[data-stage] > [data-g="info"]');
    r.rerender(<Op pane="motion" />);
    expect(info?.hasAttribute('inert')).toBe(true);
    await at(2000);
    const slot = document.querySelector('[data-stage] > [data-g="info"]');
    expect(slot).toBe(info);
    expect(slot?.hasAttribute('inert')).toBe(false);
    expect(runs.filter((x) => x.el === slot).every((x) => x.state !== 'running')).toBe(true);
  });

  it('reduced motion turned on mid-switch leaves nothing of the leaving section inert or held by its out clip', async () => {
    const r = render(<Op pane="overview" />);
    runs = [];
    r.rerender(<Op pane="motion" />);
    await at(100);
    const outs = runs.filter((x) => x.opts.fill === 'forwards');
    expect(outs.length).toBeGreaterThan(0);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: noop, removeEventListener: noop }) });
    r.rerender(<Op pane="look" />);
    expect(look()).not.toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(outs.every((x) => x.dropped)).toBe(true);
  });

  it('switches at once under reduced motion, with no clips', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener: noop, removeEventListener: noop }) });
    const r = render(<Op pane="overview" />);
    runs = [];
    r.rerender(<Op pane="motion" />);
    expect(strip()).toBeNull();
    expect(motions()).not.toBeNull();
    expect(runs).toEqual([]);
  });
});
