// Chat v2 messages: a right click opens the message menu with the items its props allow; the chat carries no trace tag.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { AgenticComplexBridge } from '../../src/bridge/protocol';
import type { Message } from '../../src/domain';
import { MessageList, type MessageListProps } from '../../src/pages/chat/MessageList';

let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});

afterEach(() => {
  cleanup();
  delete window.agenticComplex;
});

const T = 1_700_000_000_000;
const MESSAGES: Message[] = [
  { kind: 'me', at: T, text: '你好' },
  { kind: 'ai', at: T + 1, text: '在呢。', turn_ms: 4200, ttft_ms: 900, turn_id: 'line-7' },
];

const base: MessageListProps = {
  messages: MESSAGES, view: null, roleName: '示例乙', roleId: 'si', now: T + 10, answered: {}, cancelled: {}, stopped: {}, frontTitle: null,
  memsOf: () => ({ mems: [], learned: [] }),
  onOpenDrawer: () => {}, onAnswer: () => {}, onCancelQuestion: () => {}, onQueueSide: () => {},
};

const items = () => screen.queryAllByRole('menuitem').map((n) => n.textContent);

describe('chat message menu', () => {
  it('offers only 复制 without the optional callbacks', () => {
    render(<MessageList {...base} />);
    fireEvent.contextMenu(screen.getByText('在呢。'), { clientX: 40, clientY: 50 });
    expect(items()).toEqual(['复制']);
  });

  it('offers 复制, 引用回复, 在桌面上重放表情 and 在诊断里看这一轮 on her reply when given, and closes after a pick', () => {
    const onQuote = vi.fn();
    const onReplay = vi.fn();
    const onOpenTrace = vi.fn();
    const write = vi.spyOn(bridge.clipboard, 'writeText');
    render(<MessageList {...base} onQuote={onQuote} onReplay={onReplay} onOpenTrace={onOpenTrace} />);
    const open = () => fireEvent.contextMenu(screen.getByText('在呢。'), { clientX: 40, clientY: 50 });

    open();
    expect(items()).toEqual(['复制', '引用回复', '在桌面上重放表情', '在诊断中查看此轮']);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(write).toHaveBeenCalledWith('在呢。');
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: '引用回复' }));
    expect(onQuote).toHaveBeenCalledWith('在呢。', { kind: 'ai', at: T + 1, turn_id: 'line-7' });
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: '在桌面上重放表情' }));
    expect(onReplay).toHaveBeenCalledWith('line-7');
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: '在诊断中查看此轮' }));
    expect(onOpenTrace).toHaveBeenCalledWith('line-7');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the same menu from the keyboard on a focusable bubble and gives focus back when it closes', () => {
    render(<MessageList {...base} onQuote={() => {}} onOpenTrace={() => {}} />);
    const bubble = screen.getByText('在呢。').closest<HTMLElement>('[tabindex="0"]')!;
    expect(bubble).toBeTruthy();
    for (const key of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      bubble.focus();
      fireEvent.keyDown(bubble, key);
      expect(items()).toEqual(['复制', '引用回复', '在诊断中查看此轮']);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(bubble);
    }
  });

  it('a menu stays on its own message when older ones are put in front', () => {
    const write = vi.spyOn(bridge.clipboard, 'writeText');
    const older: Message[] = [{ kind: 'me', at: T - 10, text: '更早的话' }, { kind: 'ai', at: T - 9, text: '更早的回复', turn_ms: 1, turn_id: 'line-6' }];
    const { rerender } = render(<MessageList {...base} />);
    fireEvent.contextMenu(screen.getByText('在呢。'), { clientX: 40, clientY: 50 });
    rerender(<MessageList {...base} messages={[...older, ...MESSAGES]} />);
    fireEvent.click(screen.getByRole('menuitem', { name: '复制' }));
    expect(write).toHaveBeenCalledWith('在呢。');
  });

  it('marks the reply of the selected turn', () => {
    const { container } = render(<MessageList {...base} selectedTurn="line-7" />);
    expect(container.querySelector('[data-kind="ai"]')?.hasAttribute('data-sel')).toBe(true);
    expect(container.querySelector('[data-kind="me"]')?.hasAttribute('data-sel')).toBe(false);
  });

  it('does not offer to replay the user line', () => {
    render(<MessageList {...base} onQuote={() => {}} onReplay={() => {}} onOpenTrace={() => {}} />);
    fireEvent.contextMenu(screen.getByText('你好'), { clientX: 40, clientY: 50 });
    expect(items()).toEqual(['复制', '引用回复']);
  });

  it('shows no turn tag, model or account on her reply', () => {
    const { container } = render(<MessageList {...base} />);
    expect(screen.queryByRole('button', { name: /第 3 轮/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '运行详情' })).toBeNull();
    expect(container.textContent).not.toMatch(/第 3 轮|4\.2 s|Codex 登录|codex_login/);
  });

  it('draws her head from headUrl, else the first character of her name', () => {
    const { container, rerender } = render(<MessageList {...base} />);
    const head = () => container.querySelector('[data-kind="ai"] [data-head]');
    expect(head()?.textContent).toBe('示');
    expect(head()?.querySelector('img')).toBeNull();
    rerender(<MessageList {...base} headUrl="https://cdn.example.org/si.png" />);
    expect(head()?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.org/si.png');
  });
});
