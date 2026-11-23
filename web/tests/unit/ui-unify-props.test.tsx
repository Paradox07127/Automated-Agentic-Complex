import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Btn, Fold, IconBtn, SecHead, Tabs } from '../../src/ui';

afterEach(cleanup);

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/ui');
const read = (f: string) => readFileSync(resolve(ui, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = readFileSync(resolve(ui, '../design/tokens.css'), 'utf8');

/** Declarations of every rule whose selector list contains `sel` exactly. */
function rules(css: string, sel: string): string {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.trim() === sel || m[1]!.split(',').some((s) => s.trim() === sel))
    .map((m) => m[2]!)
    .join('');
}

/** A token's value in one theme block of tokens.css. */
function token(theme: 'dark' | 'light', name: string): string {
  const block = tokens.split(`[data-theme="${theme}"] {`)[1]!.split('\n}')[0]!;
  return new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)![1]!;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('IconBtn', () => {
  it('writes aria-expanded and sinks like a pressed Btn while expanded', () => {
    const { rerender } = render(<IconBtn icon="more" label="更多操作" />);
    expect(screen.getByRole('button').hasAttribute('aria-expanded')).toBe(false);
    rerender(<IconBtn icon="more" label="更多操作" expanded />);
    expect(screen.getByRole('button', { name: '更多操作' }).getAttribute('aria-expanded')).toBe('true');
    expect(rules(read('IconBtn.module.css'), ".btn[aria-expanded='true']")).toMatch(/translate\(1px,\s*1px\)/);
  });

  it('stays focusable when disabled with a reason, says why on hover and focus, and ignores clicks', () => {
    const onClick = vi.fn();
    render(<IconBtn icon="refresh" label="重新检测" disabled disabledReason="后台没有运行" onClick={onClick} />);
    const b = screen.getByRole('button', { name: '重新检测' }) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(b);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('后台没有运行');
    expect(b.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.mouseLeave(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(b);
    expect(screen.getByRole('tooltip').textContent).toBe('后台没有运行');
    fireEvent.blur(b);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps the native disabled button when no reason is given', () => {
    render(<IconBtn icon="refresh" label="重新检测" disabled />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('has a 24 px round badge shape', () => {
    render(<IconBtn icon="plus" label="新建" shape="round" />);
    expect(screen.getByRole('button').getAttribute('data-shape')).toBe('round');
    const round = rules(read('IconBtn.module.css'), ".btn[data-shape='round']");
    expect(round).toMatch(/width:\s*24px/);
    expect(round).toMatch(/height:\s*24px/);
  });

  it('dims disabled keys on a dark island instead of lighting them, with tokens only', () => {
    const dark = rules(read('IconBtn.module.css'), ":global([data-theme='dark']) .btn:not([data-icon='close']):is(:disabled, [aria-disabled='true'])");
    expect(dark).toMatch(/--plate:\s*var\(--ef-/);
    expect(dark).toMatch(/color:\s*var\(--ef-text-disabled\)/);
    expect(dark).not.toMatch(/#|rgb/);
    expect(dark).not.toMatch(/--ef-btn-disabled/);
  });
});

describe('Btn', () => {
  const css = readdirSync(ui)
    .filter((f) => /^Btn.*\.module\.css$/.test(f))
    .map(read)
    .join('\n');

  it('writes aria-pressed and sinks right-down without its shadow while pressed', () => {
    const { rerender } = render(<Btn>固定</Btn>);
    expect(screen.getByRole('button').hasAttribute('aria-pressed')).toBe(false);
    rerender(<Btn pressed>固定</Btn>);
    const b = screen.getByRole('button', { name: '固定' });
    expect(b.getAttribute('aria-pressed')).toBe('true');
    const sel = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.includes("[aria-pressed='true']")).map((m) => m[2]!).join('');
    expect(sel).toMatch(/translate\(1px,\s*1px\)/);
    expect(sel).toMatch(/--btn-shadow:\s*0 0 transparent/);
  });

  it('draws a secondary button’s icon once', () => {
    render(
      <Btn variant="secondary" icon="refresh">
        重试
      </Btn>,
    );
    expect(screen.getByRole('button').querySelectorAll('svg[data-icon="refresh"]')).toHaveLength(1);
  });
});

describe('Fold', () => {
  beforeEach(() => {
    sessionStorage.clear();
    location.hash = '#/overview';
  });
  const items = (n: number) => Array.from({ length: n }, (_, i) => <p key={i}>第 {i + 1} 条</p>);

  it('follows open when given, reports toggles, and leaves sessionStorage alone', () => {
    const onToggle = vi.fn();
    sessionStorage.setItem('ef.fold:/overview:done', '0');
    const { rerender } = render(
      <Fold id="done" label="做完了" rows={6} open onToggle={onToggle}>
        {items(6)}
      </Fold>,
    );
    const head = screen.getByRole('button', { name: /做完了/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(sessionStorage.getItem('ef.fold:/overview:done')).toBe('0');
    rerender(
      <Fold id="done" label="做完了" rows={6} open={false} onToggle={onToggle}>
        {items(6)}
      </Fold>,
    );
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('第 1 条')).toBeNull();
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(sessionStorage.getItem('ef.fold:/overview:done')).toBe('0');
  });

  it('drops the hairline after the title with rule={false}', () => {
    const { container, rerender } = render(
      <Fold variant="head" label="前一天的" rows={8}>
        {items(8)}
      </Fold>,
    );
    const head = () => container.querySelector('[data-stub="SecHead"]')!;
    expect(head().hasAttribute('data-rule')).toBe(false);
    rerender(
      <Fold variant="head" label="前一天的" rows={8} rule={false}>
        {items(8)}
      </Fold>,
    );
    expect(head().getAttribute('data-rule')).toBe('off');
    expect(rules(read('SecHead.module.css'), ".head[data-rule='off'] .right::before")).toMatch(/content:\s*none/);
  });

  it('takes a text count', () => {
    render(
      <Fold label="步骤" count="3/5" rows={6}>
        {items(6)}
      </Fold>,
    );
    expect(screen.getByRole('button', { name: /步骤/ }).textContent).toContain('3/5');
  });
});

describe('SecHead', () => {
  it('puts the ⓘ right after the title text', () => {
    render(<SecHead title="进程" count={4} info="只列后台自己起的进程。" right="4 个" />);
    const h = screen.getByRole('heading', { name: '进程' });
    const next = h.nextElementSibling!;
    expect(next.getAttribute('data-stub')).toBe('InfoTip');
    expect(next.querySelector('[role="tooltip"]')?.textContent).toBe('只列后台自己起的进程。');
  });

  it('marks developer groups with DEV, readable on the light theme', () => {
    const { container, rerender } = render(<SecHead title="画质" />);
    expect(container.textContent).not.toContain('DEV');
    rerender(<SecHead title="画质" dev />);
    expect(screen.getByText('DEV')).toBeTruthy();
    const light = rules(read('SecHead.module.css'), ":global([data-theme='light']) .dev");
    const ink = /(?:^|;)\s*color:\s*var\((--ef-[\w-]+)\)/.exec(light)?.[1];
    expect(ink).toBeDefined();
    for (const bg of ['--ef-canvas', '--ef-base', '--ef-surface-1']) expect(contrast(token('light', ink!), token('light', bg))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'a', label: '甲' },
    { id: 'b', label: '乙' },
    { id: 'c', label: '丙' },
  ];

  it('wraps Q / E at the ends by default and stops there with loop={false}', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Tabs tabs={tabs} value="a" onChange={onChange} />);
    fireEvent.keyDown(window, { key: 'q' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    onChange.mockClear();
    rerender(<Tabs tabs={tabs} value="a" loop={false} onChange={onChange} />);
    fireEvent.keyDown(window, { key: 'q' });
    expect(onChange).not.toHaveBeenCalled();
    rerender(<Tabs tabs={tabs} value="c" loop={false} onChange={onChange} />);
    fireEvent.keyDown(window, { key: 'e' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'q' });
    expect(onChange).toHaveBeenLastCalledWith('b');
  });

  it('keeps step cells from shrinking and Q / E clear of the selected block', () => {
    const css = read('TabsSteps.module.css');
    render(<Tabs variant="steps" tabs={[{ id: 'a', label: '模型账号', icon: 'user', step: 'done' }]} value="a" />);
    expect(screen.getByRole('tablist').className).toContain('steps');
    expect(rules(css, ".steps > [role='tab']")).toMatch(/flex:\s*none|flex-shrink:\s*0/);
    const margin = /margin:\s*0\s+(\d+)px/.exec(rules(css, ".steps > [aria-hidden='true']"))?.[1];
    // The selected block hangs 13 px past the first and last cell.
    expect(Number(margin)).toBeGreaterThan(13);
  });
});
