import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { getBridge } from '../../bridge';
import { ContextMenu, type MenuItem } from '../../ui';

/** What a message's right-click menu can do besides 复制; an absent callback leaves its item out. */
export interface MessageMenuProps {
  onQuote?: (text: string) => void;
  /** Her line's line_id: she plays its expression on the desktop again. */
  onReplay?: (lineId: string) => void;
  /** The turn_id of the message's turn, opened in 诊断 › 对话轮次. */
  onOpenTrace?: (turnId: string) => void;
}

/** The right-click menu of one message: 复制, 引用回复, 在桌面上重放表情 (her lines), 在诊断里看这一轮 (with a turn). */
export function useMessageMenu(text: string, ids: { line?: string | undefined; turn?: string | undefined }, p: MessageMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const { line, turn } = ids;
  const items: MenuItem[] = [
    { kind: 'item', label: '复制', onSelect: () => void getBridge().clipboard.writeText(text) },
    ...(p.onQuote ? [{ kind: 'item' as const, label: '引用回复', onSelect: () => p.onQuote?.(text) }] : []),
    ...(p.onReplay && line ? [{ kind: 'item' as const, label: '在桌面上重放表情', onSelect: () => p.onReplay?.(line) }] : []),
    ...(p.onOpenTrace && turn ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: '在诊断里看这一轮', onSelect: () => p.onOpenTrace?.(turn) }] : []),
  ];
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setAt({ x: e.clientX, y: e.clientY });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setAt({ x: box.left, y: box.bottom });
  };
  return { onContextMenu, onKeyDown, menu: <ContextMenu label="这条消息" items={items} at={at} onClose={() => setAt(null)} /> };
}
