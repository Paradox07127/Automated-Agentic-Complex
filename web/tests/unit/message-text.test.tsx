import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MessageText } from '../../src/pages/chat/MessageText';

let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

describe('MessageText', () => {
  it('shows a Markdown link as its label, without the brackets or the target', () => {
    const { container } = render(<MessageText text="喏，[summary.md](../outputs/run-1/summary.md) 已生成。" />);
    expect(container.textContent).toBe('喏，summary.md 已生成。');
    expect(container.querySelector('span')?.textContent).toBe('summary.md');
  });

  it('copies a code block, trimmed at the end, through its 复制代码 button', () => {
    const write = vi.spyOn(bridge.clipboard, 'writeText');
    render(<MessageText text={'试试这个：\n```sh\nls -la ~/Desktop\n\n```\n好了。'} />);
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
    expect(write).toHaveBeenCalledWith('ls -la ~/Desktop');
  });

  it('gives each code block its own button that copies its own code', () => {
    const write = vi.spyOn(bridge.clipboard, 'writeText');
    render(<MessageText text={'先：\n```\nnpm ci\n```\n再：\n```ts\nconst a = 1;\nconst b = 2;\n```'} />);
    const buttons = screen.getAllByRole('button', { name: '复制代码' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(write).toHaveBeenLastCalledWith('const a = 1;\nconst b = 2;');
    fireEvent.click(buttons[0]!);
    expect(write).toHaveBeenLastCalledWith('npm ci');
  });

  it('has no copy button while the reply is streaming', () => {
    render(<MessageText text={'试试：\n```\nnpm ci\n```\n'} streaming />);
    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull();
  });

  it('has no copy button on a reply without code blocks', () => {
    render(<MessageText text="只是一句话，带 `npm ci` 行内代码。" />);
    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull();
  });
});
