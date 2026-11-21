import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBlock, RawFold, TraceGroup, TraceLine } from '../../src/features/trace';

afterEach(cleanup);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const shownLines = (root: ParentNode) => root.querySelectorAll('[data-line]').length;

describe('CodeBlock', () => {
  it('previews 20 lines and offers 全部 N 行', () => {
    const { container } = render(<CodeBlock code={lines(45)} />);
    expect(shownLines(container)).toBe(20);
    fireEvent.click(screen.getByRole('button', { name: '全部 45 行' }));
    expect(shownLines(container)).toBe(45);
  });

  it('shows short code whole, without the expand button', () => {
    const { container } = render(<CodeBlock code={lines(12)} />);
    expect(shownLines(container)).toBe(12);
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull();
  });

  it('numbers lines and toggles wrapping', () => {
    const { container } = render(<CodeBlock code={lines(3)} />);
    expect([...container.querySelectorAll('[data-ln]')].map((n) => n.textContent)).toEqual(['1', '2', '3']);
    const wrap = screen.getByRole('button', { name: '自动换行' });
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(wrap);
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-stub="CodeBlock"]')?.getAttribute('data-wrap')).toBeNull();
  });
});

describe('RawFold', () => {
  it('keeps the raw text folded by default and shows it in a CodeBlock on demand', () => {
    const { container } = render(<RawFold summary={['3 个阶段，最慢 模型调用 1.1 s']} raw={lines(30)} rawLabel="运行输出" />);
    const toggle = screen.getByRole('button', { name: /运行输出/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-stub="CodeBlock"]')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shownLines(container)).toBe(20);
  });

  it('shows at most 3 summary lines', () => {
    const { container } = render(<RawFold summary={['a', 'b', 'c', 'd']} raw="x" />);
    expect(container.querySelectorAll('[data-summary] li')).toHaveLength(3);
  });
});

describe('TraceLine', () => {
  it('expands and collapses from the keyboard', () => {
    render(
      <TraceLine title="执行命令" desc="git log --since=monday" state="completed" durationMs={400}>
        <p>输出</p>
      </TraceLine>,
    );
    const row = screen.getByRole('button', { name: /执行命令/ });
    expect(row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('输出')).toBeNull();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('输出')).toBeTruthy();
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('is a plain row without detail, and reads its duration through formatMs', () => {
    const { container } = render(<TraceLine title="读取目录" state="completed" durationMs={1250} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toContain('1.3 s');
  });

  it('groups lines under one expandable head', () => {
    render(<TraceGroup title="运行步骤" state="completed" items={[{ title: 'a', state: 'completed' }, { title: 'b', state: 'failed' }]} />);
    const head = screen.getByRole('button', { name: /运行步骤/ });
    expect(screen.queryByText('b')).toBeNull();
    fireEvent.keyDown(head, { key: 'Enter' });
    expect(screen.getByText('b')).toBeTruthy();
  });
});
