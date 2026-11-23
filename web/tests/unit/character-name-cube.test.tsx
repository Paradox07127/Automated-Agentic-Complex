// 角色名字完整显示（不省略、不裁切，长名字换行降档）；舞台右上角的视角方块：点面转到那一面，拖它和拖舞台一样转镜头。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge, PreviewView } from '../../src/bridge/protocol';
import { MOTIONS } from '../../src/mock/character';
import { NameBlock } from '../../src/pages/character/NameBlock';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';
import { Roster } from '../../src/pages/character/Roster';
import { HeaderSlotContext } from '../../src/shell/headerSlot';

const LONG_CJK = '佩丽卡・终末地协议第七号测试员';
const LONG_LATIN = 'Perlica Endfield Protocol Unit';
const LONG_EN = 'PERLICA ENDFIELD PROTOCOL SEVEN';

const here = dirname(fileURLToPath(import.meta.url));
const css = (file: string) => readFileSync(resolve(here, '../../src/pages', file), 'utf8');
/** The declarations of `selector`'s first top-level rule in `text`. */
const rule = (text: string, selector: string) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(text);
  if (!m) throw new Error(`no rule ${selector}`);
  return m[1]!;
};
/** A rule that cuts its text: an ellipsis, or one line with the overflow hidden. */
const cuts = (decl: string) => /text-overflow:\s*ellipsis/.test(decl) || (/white-space:\s*nowrap/.test(decl) && /overflow:\s*hidden/.test(decl));

const view = (v: PreviewView | undefined) => v && { turn: v.turn, tilt: v.tilt };

let bridge: AgenticComplexBridge;
let sendView: MockInstance<AgenticComplexBridge['avatar']['preview']['view']>;
let frames: Map<number, FrameRequestCallback>;
const flush = () =>
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(performance.now());
  });
const last = () => sendView.mock.calls.at(-1)?.[0];

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
  sendView = vi.spyOn(bridge.avatar.preview, 'view');
  frames = new Map();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.set(++id, cb), id));
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((n) => void frames.delete(n));
  vi.stubGlobal('devicePixelRatio', 2);
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
  delete window.agenticComplex;
});

describe('a long character name', () => {
  it.each([LONG_CJK, LONG_LATIN])('shows %s whole on the name block, wrapping and sized down instead of cut', (name) => {
    render(<NameBlock name={name} en={LONG_EN} active activity={null} offline={false} />);
    const plate = document.querySelector('[data-nameplate]') as HTMLElement;
    expect(plate.querySelector('b')!.textContent).toBe(name);
    expect(plate.textContent).toContain(LONG_EN);
    const nb = css('character/NameBlock.module.css');
    expect(cuts(rule(nb, '.name'))).toBe(false);
    expect(rule(nb, '.name')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(cuts(rule(nb, '.en'))).toBe(false);
    // Longer names take a smaller size: the share of the column a size fits goes with the name's width.
    const len = (n: string) => {
      cleanup();
      render(<NameBlock name={n} activity={null} offline={false} />);
      return Number((document.querySelector('[data-nameplate]') as HTMLElement).style.getPropertyValue('--nb-len'));
    };
    expect(len(name)).toBeGreaterThan(len('示例乙'));
  });

  it('shows the whole name on its roster card and in MMD', () => {
    render(<Roster characters={[{ id: 'si', name: LONG_CJK, en: LONG_EN, active: true }]} current="si" pending={null} offline={false} onPick={() => {}} />);
    expect(screen.getByRole('navigation', { name: '角色名册' }).textContent).toContain(LONG_CJK);
    expect(cuts(rule(css('character/Roster.module.css'), '.name'))).toBe(false);
    expect(cuts(rule(css('mmd/Setlist.module.css'), '.who'))).toBe(false);
    expect(cuts(rule(css('mmd/Detail.module.css'), '.chn'))).toBe(false);
  });
});

describe('the view cube', () => {
  const props: OperatorProps = {
    roster: [{ id: 'si', name: '示例乙', en: 'SI', active: true, voice: true, appearances: [] }],
    current: 'si',
    sw: { state: { phase: 'idle' }, request: () => {}, retry: () => {}, dismiss: () => {} },
    offline: false,
    backoff: null,
    onRestart: () => {},
    actions: MOTIONS,
    motionsError: null,
    onRetryMotions: () => {},
    charState: null,
    toast: () => {},
    pane: 'overview',
  };

  function inShell(p: OperatorProps) {
    const bottom = document.createElement('div');
    document.body.append(bottom);
    const ui = render(
      <QueryClientProvider client={new QueryClient()}>
        <HeaderSlotContext.Provider value={{ setSub: () => {}, right: null, action: null, bottom }}>
          <Operator {...p} />
        </HeaderSlotContext.Provider>
      </QueryClientProvider>,
    );
    return { ui, done: () => bottom.remove() };
  }
  const cube = () => screen.queryByRole('group', { name: '视角方块' });
  const face = (name: string) => screen.getByRole('button', { name });

  it('stands on the stage with a key for each face, apart from 镜头回正', () => {
    const { done } = inShell(props);
    const c = cube()!;
    expect(c.closest('[data-preview-stage]')).not.toBeNull();
    for (const f of ['正面', '右面', '背面', '左面', '顶面', '底面']) expect(c.contains(face(`镜头转到${f}`))).toBe(true);
    expect(c.textContent).toBe('XYZ');
    expect(c.contains(screen.queryByRole('button', { name: '镜头回正', hidden: true }))).toBe(false);
    done();
  });

  it.each([
    ['without a character', { current: '' }],
    ['while she is not running', { offline: true }],
    ['during a switch', { switching: true }],
  ])('is absent %s', (_why, extra) => {
    const { done } = inShell({ ...props, ...extra });
    expect(cube()).toBeNull();
    done();
  });

  it('turns the camera to the face pressed, the short way round, and follows the view', () => {
    const { done } = inShell(props);
    fireEvent.click(face('镜头转到右面'));
    flush();
    expect(view(last())).toEqual({ turn: -90, tilt: 0 });
    fireEvent.click(face('镜头转到顶面'));
    flush();
    expect(view(last())).toEqual({ turn: -90, tilt: 80 });
    fireEvent.click(face('镜头转到左面'));
    flush();
    expect(view(last())).toEqual({ turn: 90, tilt: 0 });
    fireEvent.click(face('镜头转到底面'));
    flush();
    expect(view(last())).toEqual({ turn: 90, tilt: -80 });
    fireEvent.click(face('镜头转到背面'));
    flush();
    expect(view(last())).toEqual({ turn: 180, tilt: 0 });
    // From the back 右面 is a quarter turn on, and 正面 one more.
    fireEvent.click(face('镜头转到右面'));
    flush();
    expect(view(last())).toEqual({ turn: 270, tilt: 0 });
    fireEvent.click(face('镜头转到正面'));
    flush();
    expect(view(last())).toEqual({ turn: 360, tilt: 0 });
    done();
  });

  it('turns the camera when dragged, as a drag on the stage does, and a drag is not a press', () => {
    const { ui, done } = inShell(props);
    const c = cube()!;
    const right = face('镜头转到右面');
    fireEvent.pointerDown(right, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 40, clientY: 0 });
    fireEvent.pointerMove(c, { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(c, { pointerId: 1 });
    fireEvent.click(right, { detail: 1 });
    flush();
    expect(view(last())).toEqual({ turn: 60, tilt: 10 });
    // The same drag on the stage turns it as far.
    const grip = ui.container.querySelector<HTMLElement>('[data-inspect]')!;
    fireEvent.pointerDown(grip, { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(grip, { pointerId: 2 });
    flush();
    expect(view(last())).toEqual({ turn: 120, tilt: 20 });
    done();
  });
});
