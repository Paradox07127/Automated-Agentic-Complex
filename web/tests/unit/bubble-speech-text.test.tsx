import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Bar, Phase } from '../../src/surfaces/desktop/comm/commReducer';
import { Speech } from '../../src/surfaces/desktop/bubble/Speech';

afterEach(cleanup);

const bar = (text: string, phase: Phase = 'linger'): Bar => ({
  id: 'l1', kind: 'main', text, phase, reason: null, pinned: false, held: false, left: 0, total: 0, seq: 1,
});

const say = (text: string, phase?: Phase) => {
  render(<Speech bar={bar(text, phase)} name="" onOpen={() => {}} />);
  return screen.getByRole('status');
};

describe('her line in the bubble', () => {
  it('draws a fenced code block as code, without the fence or a copy button', () => {
    const line = say('试试这个：\n```sh\nls -la ~/Desktop\n```\n好了。');
    expect(line.querySelector('pre code')?.textContent).toBe('ls -la ~/Desktop');
    expect(line.textContent).not.toContain('```');
    expect(screen.queryByRole('button', { name: '复制代码' })).toBeNull();
  });

  it('draws inline code as code, without its backticks', () => {
    const line = say('先跑 `npm ci` 再说。');
    expect(line.querySelector('code')?.textContent).toBe('npm ci');
    expect(line.textContent).toBe('先跑 npm ci 再说。');
  });

  it('shows a Markdown link as its label only, with no a element', () => {
    const line = say('看 [这份说明](https://example.com/a/very/long/path?q=1) 就行，原文在 https://example.com/raw');
    expect(line.querySelector('a')).toBeNull();
    expect(line.textContent).toBe('看 这份说明 就行，原文在 https://example.com/raw');
  });

  it('keeps every word of a streaming line whose fence is still open, and its cursor', () => {
    const text = '试试：\n```sh\nls -la\ncd ~/Desktop';
    const line = say(text, 'streaming');
    const body = line.firstElementChild!;
    expect(body.textContent).toBe(text);
    expect(body.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves a plain line’s text as it was', () => {
    const text = '今天天气不错，\n要不要出去走走？';
    const line = say(text);
    expect(line.firstElementChild?.textContent).toBe(text);
  });
});
