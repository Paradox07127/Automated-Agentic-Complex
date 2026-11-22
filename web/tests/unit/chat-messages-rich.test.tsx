// Chat v2 message text: raw HTML stays text, only http(s) links are links and open through the confirm card, only data:, blob: and the app's own pictures load.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import { MessageImage } from '../../src/pages/chat/LinkConfirm';
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

  it('opens an http link only through the confirm card; 复制地址 and 打开 each call the bridge once', async () => {
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
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

  it('shows an external image as a link card that opens through the confirm card; data: and blob: pictures load', () => {
    const { container } = render(<MessageText text={'![训练场](https://img.example.org/a.png)\n\n![点](data:image/png;base64,iVBORw0KGgo=)\n\n![存](blob:null/1f2e)\n\n![坏](ftp://x/y.png)'} />);
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,iVBORw0KGgo=', 'blob:null/1f2e']);
    fireEvent.click(screen.getByRole('link', { name: /img\.example\.org/ }));
    expect(screen.getByRole('dialog', { name: '打开外部链接？' }).textContent).toContain('https://img.example.org/a.png');
  });

  it('says a failed picture did not open', () => {
    const { container } = render(<MessageText text="![点](data:image/png;base64,iVBORw0KGgo=)" />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText(/图片没打开/)).toBeTruthy();
  });

  it('opens a picture large in a dialog', () => {
    render(<MessageText text="![点](data:image/png;base64,iVBORw0KGgo=)" />);
    fireEvent.click(screen.getByRole('button', { name: '放大图片：点' }));
    const big = screen.getByRole('dialog', { name: '点' });
    expect(big.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    fireEvent.click(big);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('forgets a failed load and the large view when the picture changes', () => {
    const { container, rerender } = render(<MessageImage src="data:image/png;base64,AAAA" alt="甲" />);
    fireEvent.click(screen.getByRole('button', { name: '放大图片：甲' }));
    fireEvent.click(screen.getByRole('dialog', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '放大图片：甲' }));
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByText(/图片没打开/)).toBeTruthy();
    rerender(<MessageImage src="data:image/png;base64,BBBB" alt="乙" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BBBB');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the confirm card on a middle click and never lets it navigate', () => {
    render(<MessageText text="[这里](https://example.org/)" />);
    const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
    fireEvent(screen.getByRole('link', { name: '这里' }), middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog', { name: '打开外部链接？' })).toBeTruthy();
  });

  it('opens the confirm card on a Ctrl or Cmd click and never lets it navigate', () => {
    render(<MessageText text="https://example.org/a 和 [这里](https://example.org/)" />);
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...mod });
      fireEvent(screen.getByRole('link', { name: '这里' }), click);
      expect(click.defaultPrevented).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
    }
  });

  it('puts focus inside the confirm card and the large picture once they open', () => {
    render(<MessageText text={'[这里](https://example.org/)\n\n![点](data:image/png;base64,iVBORw0KGgo=)'} />);
    const link = screen.getByRole('link', { name: '这里' });
    link.focus();
    fireEvent.click(link);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '放大图片：点' }));
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('marks the real host after the credentials, and shows the whole address as it is', () => {
    render(<MessageText text="[甲](https://evil.com.trusted.com@evil.com/login) [乙](https://user:evil.com@Host.example:8443/p?q=1)" />);
    fireEvent.click(screen.getByRole('link', { name: '甲' }));
    let card = screen.getByRole('dialog', { name: '打开外部链接？' });
    expect(card.querySelector('b')?.textContent).toBe('evil.com');
    expect(card.querySelector('b')?.previousSibling?.textContent).toBe('https://evil.com.trusted.com@');
    expect(card.querySelector('p')?.textContent).toBe('https://evil.com.trusted.com@evil.com/login');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('link', { name: '乙' }));
    card = screen.getByRole('dialog', { name: '打开外部链接？' });
    expect(card.querySelector('b')?.textContent).toBe('host.example:8443');
    expect(card.querySelector('b')?.previousSibling?.textContent).toBe('https://user:evil.com@');
  });

  it('keeps the card open and says why when 打开 or 复制地址 fails', async () => {
    vi.spyOn(bridge.open, 'url').mockRejectedValue(new Error('地址太长'));
    vi.spyOn(bridge.clipboard, 'writeText').mockRejectedValue(new Error('剪贴板不可用'));
    render(<MessageText text="[这里](https://example.org/)" />);
    fireEvent.click(screen.getByRole('link', { name: '这里' }));
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(await screen.findByText('地址太长')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制地址' }));
    expect(await screen.findByText('剪贴板不可用')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '打开外部链接？' })).toBeTruthy();
  });

  it('makes no link inside a link label', () => {
    const { container } = render(<MessageText text="[https://trusted.example](https://evil.example)" />);
    expect(container.querySelectorAll('a')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog').textContent).toContain('https://evil.example/');
  });

  it('cuts an address at the same place inline and on its own line', () => {
    const hrefs = (text: string) => [...render(<MessageText text={text} />).container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs('看 https://en.wikipedia.org/wiki/Foo_(bar) 吧')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    cleanup();
    expect(hrefs('(见 https://example.org/x)')).toEqual(['https://example.org/x']);
    cleanup();
    expect(hrefs('[文章](https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    cleanup();
    expect(hrefs('![图](https://cdn.example.org/a_(1).png)')).toEqual(['https://cdn.example.org/a_(1).png']);
    cleanup();
    expect(hrefs('看 HTTPS://EXAMPLE.ORG/A。')).toEqual(['HTTPS://EXAMPLE.ORG/A']);
    cleanup();
    expect(hrefs('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    cleanup();
    for (const tail of ['。', '.', '！', ')']) {
      expect(hrefs(`https://example.org/guide${tail}`)).toEqual(['https://example.org/guide']);
      cleanup();
    }
    expect(hrefs('HTTPS://EXAMPLE.ORG/GUIDE')).toEqual(['HTTPS://EXAMPLE.ORG/GUIDE']);
  });

  it('makes no link or picture while a code fence is still open, and keeps links before it', () => {
    const { container } = render(<MessageText streaming text={'见 https://a.example/z\n```md\n![图](https://b.example/p.png) [链](https://c.example) https://d.example/q\n'} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://a.example/z']);
    expect(container.textContent).toContain('![图](https://b.example/p.png) [链](https://c.example) https://d.example/q');
  });

  it('makes no link inside a code fence that closed while streaming, and links after it', () => {
    const { container } = render(<MessageText streaming text={'```\nhttps://a.example/\n```\n看 https://b.example/'} />);
    expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://b.example/']);
  });
});
