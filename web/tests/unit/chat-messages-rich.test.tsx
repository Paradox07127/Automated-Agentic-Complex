// Chat v2 message text: raw HTML stays text, only http(s) links are links and open through the confirm card, images load from any address.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('chat message rich text', () => {
  it('shows raw HTML as plain text', () => {
    const { container } = render(<MessageText text={'看这个 <img src=x onerror=alert(1)> 和 <script>alert(2)</script>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<script>alert(2)</script>');
  });

  it('renders bold, italic, lists, quotes, headings and tables', () => {
    const { container } = render(<MessageText text={'# 标题\n\n**粗** 和 *斜*\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用的话\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'} />);
    expect(container.querySelector('strong')?.textContent).toBe('标题');
    expect([...container.querySelectorAll('strong')].map((n) => n.textContent)).toContain('粗');
    expect(container.querySelector('em')?.textContent).toBe('斜');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('blockquote')?.textContent).toBe('引用的话');
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('keeps a javascript: link as text', () => {
    const { container } = render(<MessageText text="点 [这里](javascript:alert(1)) 看看" />);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toContain('这里');
  });

  it('opens an http link only through the confirm card; 复制地址 and 打开 each call the bridge once', () => {
    const write = vi.spyOn(bridge.clipboard, 'writeText');
    const open = vi.spyOn(bridge.open, 'url');
    render(<MessageText text="须知在 [这里](https://yinglong.example.org/handbook?season=2026)。" />);
    fireEvent.click(screen.getByRole('link', { name: '这里' }));
    expect(open).not.toHaveBeenCalled();
    const card = screen.getByRole('dialog', { name: '打开外部链接？' });
    expect(within(card).getByText('yinglong.example.org').tagName).toBe('B');
    expect(card.textContent).toContain('https://yinglong.example.org/handbook?season=2026');
    fireEvent.click(within(card).getByRole('button', { name: '复制地址' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('https://yinglong.example.org/handbook?season=2026');

    fireEvent.click(screen.getByRole('link', { name: '这里' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '打开外部链接？' })).getByRole('button', { name: '打开' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://yinglong.example.org/handbook?season=2026');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('取消 closes the card without opening', () => {
    const open = vi.spyOn(bridge.open, 'url');
    render(<MessageText text="[这里](https://example.org/)" />);
    fireEvent.click(screen.getByRole('link', { name: '这里' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('shows a bare address on its own line as a link card with host and path', () => {
    render(<MessageText text={'入队须知：\nhttps://yinglong.example.org/handbook/new-members?season=2026-winter'} />);
    const card = screen.getByRole('link', { name: /yinglong\.example\.org/ });
    expect(card.textContent).toContain('/handbook/new-members?season=2026-winter');
    fireEvent.click(card);
    expect(screen.getByRole('dialog', { name: '打开外部链接？' })).toBeTruthy();
  });

  it('renders http and data: images, and a failed one says so with a link', () => {
    const { container } = render(<MessageText text={'![训练场](https://img.example.org/a.png)\n\n![点](data:image/png;base64,iVBORw0KGgo=)\n\n![坏](ftp://x/y.png)'} />);
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['https://img.example.org/a.png', 'data:image/png;base64,iVBORw0KGgo=']);
    fireEvent.error(imgs[0]!);
    expect(screen.getByText(/图片没打开/)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: '打开链接' }));
    expect(screen.getByRole('dialog', { name: '打开外部链接？' }).textContent).toContain('https://img.example.org/a.png');
  });

  it('opens a picture large in a dialog', () => {
    render(<MessageText text="![训练场](https://img.example.org/a.png)" />);
    fireEvent.click(screen.getByRole('button', { name: '放大图片：训练场' }));
    const big = screen.getByRole('dialog', { name: '训练场' });
    expect(big.querySelector('img')?.getAttribute('src')).toBe('https://img.example.org/a.png');
    fireEvent.click(big);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
