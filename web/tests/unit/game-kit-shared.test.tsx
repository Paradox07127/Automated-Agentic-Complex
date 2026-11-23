// ui/game shared display pieces: the wheel's keyboard, hold-and-release and centre cancel; the status lamp's shapes and words.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VisualStateKey } from '../../src/domain/states';
import { GameWheel, StateStrip, StatusLamp, wheelCentre, wheelPick, type GameWheelItem } from '../../src/ui/game';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ITEMS: GameWheelItem[] = [
  { id: 'chat', label: '对话页', icon: 'file', desc: '主窗口打开对话' },
  { id: 'pending', label: '待处理', icon: 'bell', desc: '2 项等你', count: 2 },
  { id: 'quiet', label: '免打扰', icon: 'moon' },
  { id: 'pass', label: '点穿', icon: 'hand' },
  { id: 'home', label: '放回原位', icon: 'loc' },
  { id: 'roam', label: '自由活动', icon: 'sync' },
  { id: 'gift', label: '送礼物', icon: 'redeem', off: '这个角色没有收礼的动作' },
  { id: 'char', label: '角色页', icon: 'user' },
];
const CENTER = { en: 'AGENTIC COMPLEX', name: '示例乙', desc: '待命' };

/** jsdom lays nothing out: the wheel's box is at 0,0, so pointer positions are offsets from its centre. */
function wheel(props: Partial<Parameters<typeof GameWheel>[0]> = {}) {
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(<GameWheel items={ITEMS} center={CENTER} onRun={onRun} onClose={onClose} {...props} />);
  return { onRun, onClose, menu: screen.getByRole('menu', { name: '快捷轮盘' }) };
}

const key = (el: Element, k: string, shiftKey = false) => act(() => void fireEvent.keyDown(el, { key: k, shiftKey }));
const pointer = (type: 'pointerMove' | 'pointerUp' | 'pointerDown', x: number, y: number, button = 0) =>
  act(() => void fireEvent[type](window, { clientX: x, clientY: y, button }));
const selected = () => document.querySelector('[role="menuitem"][data-sel]')?.getAttribute('aria-label') ?? null;

describe('GameWheel keyboard', () => {
  it('takes focus; 1–8 run that slot at once', () => {
    const { onRun, menu } = wheel();
    expect(document.activeElement).toBe(menu);
    key(menu, '3');
    expect(onRun).toHaveBeenLastCalledWith('quiet', 2);
  });

  it('→ ↓ Tab go clockwise, ← ↑ Shift+Tab back; Enter runs the selected slot; the centre names it', () => {
    const { onRun, menu } = wheel();
    key(menu, 'ArrowRight');
    expect(selected()).toBe('1 对话页');
    key(menu, 'Tab');
    key(menu, 'ArrowDown');
    expect(selected()).toBe('3 免打扰');
    key(menu, 'ArrowLeft');
    key(menu, 'Tab', true);
    key(menu, 'ArrowUp');
    expect(selected()).toBe('8 角色页');
    expect(menu.textContent).toContain('角色页');
    key(menu, 'Enter');
    expect(onRun).toHaveBeenLastCalledWith('char', 7);
  });

  it('Esc closes; a slot that cannot run stays open and the centre says why', () => {
    const { onRun, onClose, menu } = wheel();
    key(menu, '7');
    expect(onRun).not.toHaveBeenCalled();
    expect(selected()).toBe('7 送礼物');
    expect(menu.textContent).toContain('这个角色没有收礼的动作');
    key(menu, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('GameWheel pointer', () => {
  it('held: pointing selects by angle at any distance; release after 200 ms runs the slot under the pointer', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { onRun, onClose } = wheel({ held: true });
    pointer('pointerMove', 0, -60);
    expect(selected()).toBe('1 对话页');
    pointer('pointerMove', 400, 0);
    expect(selected()).toBe('3 免打扰');
    now.mockReturnValue(1350);
    pointer('pointerUp', 400, 0);
    expect(onRun).toHaveBeenCalledWith('quiet', 2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('held: releasing in the centre cancels', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { onRun, onClose, menu } = wheel({ held: true });
    pointer('pointerMove', 10, 8);
    expect(menu.textContent).toContain('取消');
    expect(document.querySelector('[role="menuitem"][data-sel]')).toBeNull();
    now.mockReturnValue(1400);
    pointer('pointerUp', 10, 8);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('a short press leaves the wheel open; the next click runs a slot, a click in the centre or a right press closes', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { onRun, onClose } = wheel({ held: true });
    now.mockReturnValue(1120);
    pointer('pointerUp', 0, -80);
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    pointer('pointerDown', 70, 70);
    expect(onRun).toHaveBeenLastCalledWith('pass', 3);
    pointer('pointerDown', 0, 0);
    expect(onClose).toHaveBeenCalledTimes(1);
    pointer('pointerDown', 300, 300, 2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('GameWheel forwarded press (C3 rule 56)', () => {
  type Press = NonNullable<Parameters<typeof GameWheel>[0]['press']>;
  /** The wheel, re-rendered with each press the shell forwards. */
  function pressed() {
    const onRun = vi.fn();
    const onClose = vi.fn();
    const view = render(<GameWheel items={ITEMS} center={CENTER} onRun={onRun} onClose={onClose} />);
    const send = (press: Press) => act(() => void view.rerender(<GameWheel items={ITEMS} center={CENTER} onRun={onRun} onClose={onClose} press={press} />));
    return { onRun, onClose, send };
  }

  it('a move lights the slot under it; the release there runs it, however soon', () => {
    const { onRun, onClose, send } = pressed();
    send({ phase: 'move', x: 400, y: 0 });
    expect(selected()).toBe('3 免打扰');
    send({ phase: 'up', x: 400, y: 0, ms: 120 });
    expect(onRun).toHaveBeenCalledWith('quiet', 2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a release in the centre within 250 ms that never left it keeps the wheel for a click', () => {
    const { onRun, onClose, send } = pressed();
    send({ phase: 'move', x: 5, y: 5 });
    send({ phase: 'up', x: 6, y: 5, ms: 240 });
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    pointer('pointerDown', 70, 70);
    expect(onRun).toHaveBeenLastCalledWith('pass', 3);
  });

  it('a release in the centre after holding, or after leaving it, closes without running', () => {
    const late = pressed();
    late.send({ phase: 'up', x: 0, y: 0, ms: 250 });
    expect(late.onClose).toHaveBeenCalledTimes(1);
    expect(late.onRun).not.toHaveBeenCalled();
    cleanup();
    const back = pressed();
    back.send({ phase: 'move', x: 0, y: -80 });
    back.send({ phase: 'move', x: 3, y: 2 });
    back.send({ phase: 'up', x: 3, y: 2, ms: 180 });
    expect(back.onClose).toHaveBeenCalledTimes(1);
    expect(back.onRun).not.toHaveBeenCalled();
  });

  it('a release runs once: the window\'s own pointer up after it does nothing more', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const onRun = vi.fn();
    const view = render(<GameWheel items={ITEMS} center={CENTER} held onRun={onRun} onClose={vi.fn()} />);
    act(() => void view.rerender(<GameWheel items={ITEMS} center={CENTER} held onRun={onRun} onClose={vi.fn()} press={{ phase: 'up', x: 400, y: 0, ms: 400 }} />));
    now.mockReturnValue(1400);
    pointer('pointerUp', 400, 0);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

describe('GameWheel geometry', () => {
  it('the centre 30 px cancels; outside it the nearest 45° sector, none past the last item', () => {
    expect(wheelPick(0, -29, 8)).toBe('cancel');
    expect(wheelPick(0, -31, 8)).toBe(0);
    expect(wheelPick(-200, 0, 8)).toBe(6);
    expect(wheelPick(-200, 0, 5)).toBeNull();
  });

  it('near an edge the centre moves inward so the wheel and its help line stay on screen', () => {
    expect(wheelCentre({ x: 20, y: 880 }, { width: 1440, height: 900 })).toEqual({ x: 186, y: 682 });
    expect(wheelCentre({ x: 700, y: 400 }, { width: 1440, height: 900 })).toEqual({ x: 700, y: 400 });
  });
});

describe('StatusLamp', () => {
  const states: VisualStateKey[] = ['ok', 'running', 'awaiting_approval', 'warning', 'failed', 'idle', 'stopped'];

  it('every tone has its own lamp shape and a visible word from domain/status', () => {
    const { container } = render(
      <>
        {states.map((s) => (
          <StatusLamp key={s} state={s} />
        ))}
      </>,
    );
    const lamps = [...container.querySelectorAll('[data-stub="StatusLamp"]')];
    expect(lamps.map((l) => l.textContent)).toEqual(['成功', '进行中', '待批准', '注意', '失败', '空闲', '已停止']);
    expect(new Set(lamps.map((l) => l.getAttribute('data-shape'))).size).toBe(states.length);
    for (const l of lamps) expect(l.querySelector('i[aria-hidden="true"]')).not.toBeNull();
  });

  it('a page may name the state in its own words; the shape stays the state’s', () => {
    render(<StatusLamp state="broken" label="没有响应" />);
    const lamp = screen.getByText('没有响应').closest('[data-stub="StatusLamp"]');
    expect(lamp?.getAttribute('data-tone')).toBe('failed');
    expect(lamp?.getAttribute('data-shape')).toBe('square');
  });
});

describe('StateStrip', () => {
  it('failed, warning and stopped draw the whole band; running, idle and waiting the thin line', () => {
    const { container } = render(
      <>
        <StateStrip state="failed" label="出错了" why="整理失败" />
        <StateStrip state="warning" label="堵住" />
        <StateStrip state="stopped" label="已暂停" />
        <StateStrip state="running" label="在跑" />
        <StateStrip state="idle" />
        <StateStrip state="waiting" label="待确认" />
      </>,
    );
    const strips = [...container.querySelectorAll('[data-stub="StateStrip"]')];
    expect(strips.map((s) => s.hasAttribute('data-band'))).toEqual([true, true, true, false, false, false]);
    expect(strips[0]!.textContent).toBe('出错了│ 整理失败');
    expect(strips.every((s) => s.querySelector('[data-shape]'))).toBe(true);
  });
});
