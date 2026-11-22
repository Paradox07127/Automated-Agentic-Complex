import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../../src/domain';
import { ConvList, type ConvListProps } from '../../src/pages/chat/ConvList';

afterEach(cleanup);

const NOW = 1_700_000_000_000;
const conv = (id: string, title: string, over: Partial<Conversation> = {}): Conversation => ({
  id, character_id: 'si', title, group: '今天', updated_at: NOW, created_at: NOW, revision: 1, pinned: false, active: false, turn_count: 1, preview: '', archived: false, ...over,
});

const props = (over: Partial<ConvListProps> = {}): ConvListProps => ({
  who: '示例乙',
  conversations: [conv('a', '周报整理', { active: true }), conv('b', '十月开销')],
  archived: [conv('z', '旧版协议的问题', { archived: true })],
  selected: 'a',
  busy: false,
  now: NOW,
  folded: false,
  onFold: () => {},
  onSelect: () => {},
  onNew: () => {},
  manageItems: () => [],
  renaming: null,
  onRenaming: () => {},
  onRename: () => {},
  onDelete: () => {},
  ...over,
});

describe('archived topics and a search', () => {
  it('without a search the 已归档 button folds them', () => {
    render(<ConvList {...props()} />);
    const toggle = screen.getByRole('button', { name: '已归档 1' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('旧版协议的问题')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('旧版协议的问题')).toBeTruthy();
  });

  it('a search shows the archived hits at once and hides the button', () => {
    render(<ConvList {...props()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索话题' }), { target: { value: '协议' } });
    expect(screen.getByText('旧版协议的问题')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /已归档/ })).toBeNull();
  });
});

describe('renaming', () => {
  it('saves against the revision the box opened with, not a newer one a refresh brought', () => {
    const onRename = vi.fn();
    const { rerender } = render(<ConvList {...props({ renaming: 'b', onRename })} />);
    rerender(<ConvList {...props({ renaming: 'b', onRename, conversations: [conv('a', '周报整理', { active: true }), conv('b', '十月开销', { revision: 2 })] })} />);
    const box = screen.getByRole('textbox', { name: '话题名' });
    fireEvent.change(box, { target: { value: '十月账单' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0]![0]).toMatchObject({ id: 'b', revision: 1 });
    expect(onRename.mock.calls[0]![1]).toBe('十月账单');
  });

  it('a title box for a row the search hides clears the search', () => {
    const { rerender } = render(<ConvList {...props()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索话题' }), { target: { value: '开销' } });
    rerender(<ConvList {...props({ renaming: 'a' })} />);
    expect((screen.getByRole('textbox', { name: '搜索话题' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('textbox', { name: '话题名' })).toBeTruthy();
  });
});
