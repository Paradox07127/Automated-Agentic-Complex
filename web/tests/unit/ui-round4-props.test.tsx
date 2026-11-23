import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountBadge, Empty, Field, Kbd, Pill, Receipt, Skel, TextArea } from '../../src/ui';
import { StatusLamp } from '../../src/ui/game';
import { formatClock } from '../../src/domain';

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

/** A token's hex value in one theme block of tokens.css. */
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

describe('Field', () => {
  it('names the input, passes value, placeholder and max length, and reports text', () => {
    const onChange = vi.fn();
    render(<Field label="服务地址" value="http://" placeholder="填地址" maxLength={200} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '服务地址' }) as HTMLInputElement;
    expect(box.value).toBe('http://');
    expect(box.placeholder).toBe('填地址');
    expect(box.maxLength).toBe(200);
    fireEvent.change(box, { target: { value: 'http://x' } });
    expect(onChange).toHaveBeenCalledWith('http://x');
  });

  it('is 32 high, 24 at sm', () => {
    const { container, rerender } = render(<Field label="a" value="" />);
    expect(container.querySelector('[data-stub="Field"]')?.getAttribute('data-size')).toBe('md');
    rerender(<Field label="a" value="" size="sm" />);
    expect(container.querySelector('[data-stub="Field"]')?.getAttribute('data-size')).toBe('sm');
    const css = read('Field.module.css');
    expect(rules(css, '.box')).toMatch(/height:\s*var\(--ef-h-md\)/);
    expect(rules(css, ".field[data-size='sm'] .box")).toMatch(/height:\s*var\(--ef-h-sm\)/);
  });

  it('says why it is disabled under the box and links the reason', () => {
    render(<Field label="令牌" value="" disabled disabledReason="后台没有运行" />);
    const box = screen.getByRole('textbox', { name: '令牌' }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    const why = screen.getByText('后台没有运行');
    expect(box.getAttribute('aria-describedby')).toBe(why.id);
  });

  it('marks an invalid value and links its error text', () => {
    render(<Field label="端口" value="abc" invalid error="端口要是数字" />);
    const box = screen.getByRole('textbox', { name: '端口' });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    const err = screen.getByText('端口要是数字');
    expect(box.getAttribute('aria-describedby')).toBe(err.id);
    expect(box.getAttribute('aria-errormessage')).toBe(err.id);
  });

  it('puts the prefix and suffix inside the box and passes other input attributes through', () => {
    const onKeyDown = vi.fn();
    const { container } = render(<Field label="API Key" value="" type="password" prefix={<b>KEY</b>} suffix={<i>s</i>} onKeyDown={onKeyDown} />);
    const box = container.querySelector('[data-stub="Field"] input') as HTMLInputElement;
    expect(box.type).toBe('password');
    expect(box.parentElement?.querySelector('b')?.textContent).toBe('KEY');
    expect(box.parentElement?.querySelector('i')?.textContent).toBe('s');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
  });
});

describe('TextArea', () => {
  it('names the text area, defaults to 3 rows and reports text', () => {
    const onChange = vi.fn();
    render(<TextArea label="要求" value="" placeholder="要做什么" maxLength={500} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '要求' }) as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.rows).toBe(3);
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: '写周报' } });
    expect(onChange).toHaveBeenCalledWith('写周报');
  });

  it('grows from one line to at most maxRows lines', () => {
    const { container } = render(<TextArea label="消息" value="" autoGrow maxRows={5} />);
    const box = screen.getByRole('textbox', { name: '消息' }) as HTMLTextAreaElement;
    expect(box.rows).toBe(1);
    const root = container.querySelector('[data-stub="TextArea"]') as HTMLElement;
    expect(root.hasAttribute('data-autogrow')).toBe(true);
    expect(root.style.getPropertyValue('--max-rows')).toBe('5');
    const css = read('Field.module.css');
    const grow = rules(css, '.field[data-multi][data-autogrow] textarea');
    expect(grow).toMatch(/field-sizing:\s*content/);
    expect(grow).toMatch(/max-height:\s*calc\([^;]*var\(--max-rows\)/);
  });

  it('shares the disabled reason and error line with Field', () => {
    render(<TextArea label="内容" value="" disabled disabledReason="只读" />);
    const box = screen.getByRole('textbox', { name: '内容' }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('aria-describedby')).toBe(screen.getByText('只读').id);
    cleanup();
    render(<TextArea label="内容" value="" invalid error="不能为空" />);
    expect(screen.getByRole('textbox', { name: '内容' }).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Empty', () => {
  it('has a compact size for a card and an inline row for a list', () => {
    const { container, rerender } = render(<Empty title="今天没有提醒" size="compact" />);
    const el = () => container.querySelector('[data-stub="Empty"]') as HTMLElement;
    expect(el().getAttribute('data-size')).toBe('compact');
    rerender(<Empty title="今天没有提醒" inline />);
    expect(el().hasAttribute('data-inline')).toBe(true);
    // An inline row draws an icon only when given one.
    expect(el().querySelector('svg')).toBeNull();
    rerender(<Empty title="今天没有提醒" />);
    expect(el().querySelector('svg')).not.toBeNull();
    const css = read('Empty.module.css');
    expect(rules(css, ".empty[data-size='compact']")).toMatch(/max-width:\s*none/);
    const inline = rules(css, '.empty[data-inline]');
    expect(inline).toMatch(/flex-direction:\s*row/);
    expect(inline).toMatch(/border:\s*0/);
    expect(inline).toMatch(/background:\s*none/);
  });
});

describe('Pill', () => {
  it('comes in 20 and 24 high', () => {
    const { container } = render(<Pill size="lg">标签</Pill>);
    expect(container.querySelector('[data-stub="Pill"]')?.getAttribute('data-size')).toBe('lg');
    const css = read('Pill.module.css');
    expect(rules(css, '.pill')).toMatch(/height:\s*20px/);
    expect(rules(css, ".pill[data-size='lg']")).toMatch(/height:\s*24px/);
  });

  it('has accent and warn tones whose words keep 4.5:1 in both themes', () => {
    const { container } = render(
      <>
        <Pill tone="accent">推荐</Pill>
        <Pill tone="warn">响应慢</Pill>
      </>,
    );
    expect([...container.querySelectorAll('[data-stub="Pill"]')].map((p) => p.getAttribute('data-tone'))).toEqual(['accent', 'warn']);
    const css = read('Pill.module.css');
    expect(rules(css, ".pill[data-tone='accent']")).toMatch(/--pill-fg:\s*var\(--ef-accent-text\)/);
    const warn = rules(css, ".pill[data-tone='warn']");
    expect(warn).toMatch(/--pill-bg:\s*var\(--ef-badge-dot\)/);
    expect(warn).toMatch(/--pill-fg:\s*var\(--ef-on-accent\)/);
    // Warn is not told by colour alone: a ▲ flag leads it.
    expect(rules(css, ".pill[data-tone='warn']::before")).toMatch(/content:\s*'▲'/);
    for (const theme of ['dark', 'light'] as const) {
      expect(contrast(token(theme, '--ef-accent-text'), token(theme, '--ef-base'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(theme, '--ef-badge-dot'), token(theme, '--ef-on-accent'))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('Kbd bar', () => {
  it('joins each hint’s keys into one strip with its words after it', () => {
    const { container } = render(
      <Kbd
        variant="bar"
        items={[
          { keys: ['Q', 'E'], label: '切页签' },
          { keys: ['esc'], label: '主页', more: true },
        ]}
      />,
    );
    const bar = container.querySelector('[data-stub="Kbd"]') as HTMLElement;
    expect(bar.getAttribute('data-variant')).toBe('bar');
    const items = [...bar.querySelectorAll('[data-item]')];
    expect(items.map((i) => [...i.querySelectorAll('kbd')].map((k) => k.textContent))).toEqual([['Q', 'E'], ['esc']]);
    expect(items.map((i) => i.textContent)).toEqual(['QE切页签', 'esc主页']);
    expect(items[1]!.hasAttribute('data-more')).toBe(true);
    const css = read('Kbd.module.css');
    expect(rules(css, '.caps')).toMatch(/gap:\s*1px/);
    expect(css).toMatch(/@media \(max-width: 1199px\), \(max-height: 620px\)\s*\{\s*\.item\[data-more\]\s*\{\s*display:\s*none/);
  });

  it('shows only while ⌘ / Ctrl is held when asked', () => {
    const { container } = render(<Kbd variant="bar" held items={[{ keys: ['Q'], label: '切页签' }]} />);
    expect(container.querySelector('[data-stub="Kbd"]')?.hasAttribute('data-held')).toBe(true);
    expect(rules(read('Kbd.module.css'), ':global(html:not([data-keys])) .bar[data-held]')).toMatch(/opacity:\s*0/);
  });
});

describe('Receipt', () => {
  it('reads as one status line: mark, words, then the time', () => {
    const at = new Date(2026, 10, 22, 12, 30).getTime();
    const { container } = render(<Receipt at={at}>已批准</Receipt>);
    const r = screen.getByRole('status');
    expect(r.getAttribute('data-stub')).toBe('Receipt');
    expect(r.getAttribute('data-tone')).toBe('ok');
    expect(r.textContent).toBe(`已批准 │ ${formatClock(at)}`);
    expect(container.querySelector('[aria-hidden="true"] svg, svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('marks danger with its own shape, not only colour', () => {
    const { container } = render(
      <>
        <Receipt tone="neutral">已取消</Receipt>
        <Receipt tone="danger">没能送达</Receipt>
      </>,
    );
    const marks = [...container.querySelectorAll('[data-stub="Receipt"]')].map((r) => r.querySelector('[data-mark]')?.getAttribute('data-mark'));
    expect(marks).toEqual(['check', 'close']);
  });
});

describe('Skel', () => {
  it('has an avatar shape: a face and two lines per row', () => {
    const { container } = render(<Skel shape="avatar" rows={3} />);
    const rows = container.querySelectorAll('[data-skel="avatar"]');
    expect(rows.length).toBe(3);
    expect(rows[0]!.querySelectorAll('i').length).toBe(3);
  });

  it('takes a row height for list-row slots', () => {
    const { container } = render(<Skel rows={2} height={58} />);
    expect([...container.querySelectorAll('i')].map((b) => (b as HTMLElement).style.height)).toEqual(['58px', '58px']);
  });

  it('sweeps while loading and stands still in still mode and reduced motion', () => {
    const css = read('Skel.module.css');
    expect(rules(css, '.bar')).toMatch(/animation:/);
    expect(css).toMatch(/:global\(\.still\)[^{]*\.bar[^{]*\{\s*animation:\s*none/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.bar[^{]*\{\s*animation:\s*none/);
  });
});

describe('StatusLamp sm', () => {
  it('draws an 8 px mark whose shape follows the state', () => {
    const { container } = render(<StatusLamp state="warning" size="sm" label="响应慢" />);
    const lamp = container.querySelector('[data-stub="StatusLamp"]') as HTMLElement;
    expect(lamp.getAttribute('data-size')).toBe('sm');
    expect(lamp.getAttribute('data-shape')).toBe('triangle');
    const css = read('game/StatusLamp.module.css');
    expect(rules(css, ".lamp[data-size='sm'] .light")).toMatch(/width:\s*8px/);
    const shapes = ['check', 'square', 'triangle', 'diamond', 'ring', 'dot', 'hollow-square'];
    const drawn = shapes.map((s) => rules(css, `.lamp[data-size='sm'][data-shape='${s}'] .light`));
    for (const [i, d] of drawn.entries()) expect(d, shapes[i]).not.toBe('');
    expect(new Set(drawn).size).toBe(shapes.length);
  });
});

describe('CountBadge', () => {
  it('has a red square count and an ink square for a selected yellow block', () => {
    const { container } = render(
      <>
        <CountBadge count={4} kind="square" label="出错" />
        <CountBadge count={2} kind="ink" label="待确认" />
      </>,
    );
    const b = [...container.querySelectorAll('[data-stub="CountBadge"]')];
    expect(b.map((x) => [x.getAttribute('data-kind'), x.textContent, x.getAttribute('aria-label')])).toEqual([
      ['square', '4', '出错 4'],
      ['ink', '2', '待确认 2'],
    ]);
    const css = read('CountBadge.module.css');
    expect(rules(css, ".badge:is([data-kind='square'], [data-kind='ink'])")).toMatch(/border-radius:\s*0/);
    const ink = rules(css, ".badge[data-kind='ink']");
    expect(ink).toMatch(/background:\s*var\(--ef-on-accent\)/);
    expect(ink).toMatch(/color:\s*var\(--ef-accent\)/);
  });
});
