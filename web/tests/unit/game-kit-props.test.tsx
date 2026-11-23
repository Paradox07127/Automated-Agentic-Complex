// ui/game: the props the home page, the menu bar popover and the desktop layer asked for; without them each piece looks and acts as before.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharCard, CharMeta, DarkRow, OptionStack, StatusMark, StatusRow, WatchKey, WhiteCapsule, YellowKey } from '../../src/ui/game';

afterEach(cleanup);

const KIT = resolve(__dirname, '../../src/ui/game');
const css = (f: string) => readFileSync(resolve(KIT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (f: string, sel: string) => [...css(f).matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => (m[1] ?? '').trim() === sel)?.[2] ?? null;
const noop = () => undefined;

describe('WatchKey compact', () => {
  it('marks the key and draws a smaller icon; without it the icon stays 32', () => {
    const { container, rerender } = render(<WatchKey box={{ width: 72, height: 58 }} icon="moonz" title="免打扰" sub="30 分钟" compact onClick={noop} />);
    expect(screen.getByRole('button', { name: '免打扰' }).hasAttribute('data-compact')).toBe(true);
    expect(container.querySelector('[data-g="icon"] svg')?.getAttribute('width')).toBe('16');
    expect(screen.getByText('30 分钟')).toBeTruthy();
    rerender(<WatchKey box={{ width: 72, height: 58 }} icon="moonz" title="免打扰" sub="30 分钟" onClick={noop} />);
    expect(screen.getByRole('button', { name: '免打扰' }).hasAttribute('data-compact')).toBe(false);
    expect(container.querySelector('[data-g="icon"] svg')?.getAttribute('width')).toBe('32');
  });
});

describe('DarkRow order and lead width', () => {
  it('subFirst puts the kind before the title; the default keeps the title first', () => {
    const { container, rerender } = render(<DarkRow title="重跑测试？" sub="批准" mark="new" compact subFirst />);
    const order = () => [...(container.querySelector('[data-stub="DarkRow"] span[class*="body"]')?.children ?? [])].map((c) => c.textContent);
    expect(order().slice(0, 2)).toEqual(['批准', '重跑测试？']);
    rerender(<DarkRow title="重跑测试？" sub="批准" mark="new" compact />);
    expect(order().slice(0, 2)).toEqual(['重跑测试？', '批准']);
  });

  it('leadWidth sets the lead cell width; the CSS falls back to 52 and compact 34', () => {
    const { container } = render(<DarkRow title="外套" leadWidth={44} />);
    expect((container.querySelector('[data-stub="DarkRow"]') as HTMLElement).style.getPropertyValue('--dr-lead-w')).toBe('44px');
    expect(rule('DarkRow.module.css', '.lead')).toMatch(/width:\s*var\(--dr-lead-w,\s*52px\)/);
    expect(rule('DarkRow.module.css', '.row[data-compact] .lead')).toMatch(/width:\s*var\(--dr-lead-w,\s*34px\)/);
  });
});

describe('CharCard and CharMeta', () => {
  it('CharMeta without fps draws only the outfit', () => {
    const { container } = render(<CharMeta outfit="夏装" />);
    expect(container.textContent).toBe('夏装');
    expect(container.textContent).not.toContain('FPS');
  });

  it('CharCard without en still draws the Operator line', () => {
    render(<CharCard box={{ width: 320, height: 66 }} compact name="示例乙" onClick={noop} />);
    expect(screen.getByText('Operator')).toBeTruthy();
  });

  it('the English line reads at 4.5:1 or more on the light card face', () => {
    const tokens = readFileSync(resolve(__dirname, '../../src/design/tokens.css'), 'utf8');
    const light = tokens.slice(tokens.indexOf('[data-theme="light"]'));
    const ink = /--ef-g-watch-ink:\s*#([0-9a-f]{6})/i.exec(light)?.[1] ?? '';
    const body = rule('CharCard.module.css', ":global([data-theme='light']) .charEn") ?? '';
    const share = Number(/color:\s*color-mix\(in srgb,\s*var\(--ef-g-watch-ink\)\s*([\d.]+)%,\s*transparent\)/.exec(body)?.[1] ?? NaN) / 100;
    expect(body).toMatch(/opacity:\s*1\b/);
    // The light card face where the line sits, as measured.
    const face = [204, 204, 204];
    const rgb = [0, 2, 4].map((i) => parseInt(ink.slice(i, i + 2), 16));
    const lum = (c: number[]) =>
      c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const text = rgb.map((v, i) => v * share + face[i]! * (1 - share));
    expect((lum(face) + 0.05) / (lum(text) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('YellowKey ref and autoFocus', () => {
  it('passes the ref to its button and takes focus when asked', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<YellowKey ref={ref} label="打开主窗口" block autoFocus onClick={noop} />);
    const key = screen.getByRole('button', { name: '打开主窗口' });
    expect(ref.current).toBe(key);
    expect(document.activeElement).toBe(key);
  });
});

describe('WhiteCapsule sm', () => {
  it('marks the small size, 24 high; the default is unmarked', () => {
    const { container } = render(
      <>
        <WhiteCapsule label="重试" icon="refresh" size="sm" />
        <WhiteCapsule label="关闭" icon="close" />
      </>,
    );
    expect([...container.querySelectorAll('[data-stub="WhiteCapsule"]')].map((b) => b.getAttribute('data-size'))).toEqual(['sm', null]);
    expect(rule('WhiteCapsule.module.css', ".cap[data-size='sm']")).toMatch(/height:\s*24px/);
  });
});

describe('CloseKey press', () => {
  it('sinks 1 px right and down and drops its shadow; its only shadow is --ef-shadow-btn', () => {
    const down = rule('CloseKey.module.css', '.close:active') ?? '';
    expect(down).toMatch(/translate:\s*1px 1px/);
    expect(down).toMatch(/box-shadow:\s*none/);
    const shadows = [...css('CloseKey.module.css').matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(shadows.filter((s) => s !== 'none')).toEqual(['var(--ef-shadow-btn)']);
  });
});

describe('StatusMark plug and mirror', () => {
  it('plug draws the plug in place of the state shape; mirror is marked', () => {
    const { container, rerender } = render(<StatusMark state="unreachable" cap="连不上后台" plug mirror />);
    const mark = container.querySelector('[data-stub="StatusMark"]');
    expect(mark?.querySelector('svg')?.getAttribute('data-shape')).toBe('plug');
    expect(mark?.hasAttribute('data-mirror')).toBe(true);
    expect(screen.getByRole('button', { name: '连不上后台' })).toBeTruthy();
    rerender(<StatusMark state="unreachable" cap="连不上后台" />);
    expect(container.querySelector('[data-stub="StatusMark"] svg')?.getAttribute('data-shape')).not.toBe('plug');
    expect(container.querySelector('[data-stub="StatusMark"]')?.hasAttribute('data-mirror')).toBe(false);
  });
});

describe('OptionStack press start and end', () => {
  const items = [
    { id: 'chat', label: '对话', icon: 'send' as const },
    { id: 'talk', label: '说话', icon: 'mic' as const },
    { id: 'look', label: '给角色看', icon: 'look' as const, off: '观察已暂停' },
  ];

  it('reports the press and the release of a row apart; a row it cannot use reports neither', () => {
    const start = vi.fn();
    const end = vi.fn();
    render(<OptionStack items={items} onPick={noop} onPressStart={start} onPressEnd={end} />);
    const talk = screen.getByRole('button', { name: '说话' });
    fireEvent.pointerDown(talk, { button: 0, pointerId: 1 });
    expect(start).toHaveBeenCalledWith('talk');
    expect(end).not.toHaveBeenCalled();
    fireEvent.pointerUp(talk, { button: 0, pointerId: 1 });
    expect(end).toHaveBeenCalledWith('talk');
    fireEvent.pointerDown(talk, { button: 0, pointerId: 2 });
    fireEvent.pointerCancel(talk, { pointerId: 2 });
    expect(end).toHaveBeenCalledTimes(2);
    const look = screen.getByRole('button', { name: '给角色看' });
    fireEvent.pointerDown(look, { button: 0, pointerId: 3 });
    fireEvent.pointerUp(look, { button: 0, pointerId: 3 });
    expect(start).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
  });
});

describe('StatusRow secondary text', () => {
  it('the name takes the text-2 colour, not an opacity', () => {
    render(<StatusRow items={[{ name: '后台', state: '运行中' }]} />);
    const body = rule('StatusRow.module.css', '.item b') ?? '';
    expect(body).toMatch(/color:\s*var\(--ef-text-2\)/);
    expect(body).not.toMatch(/opacity/);
  });
});
