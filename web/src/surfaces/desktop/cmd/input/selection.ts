import { useEffect, useState } from 'react';
import { getBridge, type DesktopCommand, type DropItem, type SayRequest } from '../../../../bridge';

export interface ScopeAttachment {
  kind: 'scope';
  scopeId?: string;
  files: number;
  items?: DropItem[];
  /** The dropped file paths agentd cannot read. */
  unsupported?: string[];
}

/** What native sends (or a drop stages) just before the open of 快速输入 it belongs to. */
export type Attachment = Extract<DesktopCommand, { kind: 'selection' | 'selectionRefused' | 'window' }> | ScopeAttachment;

let stagedDrop: ScopeAttachment | null = null;

/** Stages the dropped items for the next open of 快速输入. */
export function stageDrop(items: DropItem[] | null, scope?: { scopeId: string; files: number; unsupported?: string[] }) {
  stagedDrop = items ? { kind: 'scope', ...scope, files: scope?.files ?? 0, items } : null;
}

/**
 * The attachment of the last open of the cmd panel; null for an open with none just before it. It subscribes on its own,
 * before any open arrives, since `useCommand` keeps only the last command.
 */
export function useAttachment(): Attachment | null {
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  useEffect(() => {
    let pending: Attachment | null = null;
    return getBridge().desktop.onCommand((c) => {
      if (c.kind === 'selection' || c.kind === 'selectionRefused' || c.kind === 'window') {
        stagedDrop = null;
        pending = c;
      } else if (c.kind === 'scope') {
        pending = stagedDrop ? { ...stagedDrop, ...c } : c;
        stagedDrop = null;
      } else if (c.kind === 'open') {
        const next = pending ?? stagedDrop;
        pending = null;
        stagedDrop = null;
        setAttachment(c.mode === 'input' ? next : null);
      }
    });
  }, []);
  return attachment;
}

/** The characters of `typed` with the drop's links, text and unreadable file paths after it, and how many of them `/say` gets. */
function withDrop(typed: string, a: ScopeAttachment): { chars: string[]; kept: number } {
  const lines = (a.items ?? []).flatMap((i) =>
    i.kind === 'url'
      ? [`链接：${i.url}`]
      : i.kind === 'text'
        ? [`文字：${i.text}`]
        : !a.scopeId || (a.unsupported ?? []).includes(i.path)
          ? [`文件路径：${i.path}`]
          : [],
  );
  // /say takes at most 2000 characters (agentd api/speech.py MAX_SAY); the dropped part gives way to the typed text.
  return { chars: [...(lines.length ? `${typed}\n\n用户拖入：\n${lines.join('\n')}` : typed)], kept: Math.max(2000, [...typed].length) };
}

/** Attaches a selection as the quote of the typed `r`, or a drop's read scope and any dropped links, text or unreadable file paths. */
export function dropSay(r: SayRequest, a?: Attachment | null): SayRequest {
  if (a?.kind === 'selection') return { ...r, quote: { text: a.text, app: a.app } };
  if (a?.kind === 'window') return { ...r, attachWindow: false, lookWindow: { windowId: a.windowId, pid: a.pid } };
  if (a?.kind !== 'scope') return r;
  const { chars, kept } = withDrop(r.text, a);
  const text = chars.slice(0, kept).join('');
  return a.scopeId ? { ...r, text, scopeId: a.scopeId } : { ...r, text };
}

/** Whether `dropSay` cuts the dropped part of what goes with `typed`. */
export function dropOverflows(typed: string, a: Attachment | null | undefined): boolean {
  if (a?.kind !== 'scope') return false;
  const { chars, kept } = withDrop(typed, a);
  return chars.length > kept;
}

export type SelectionAction = 'explain' | 'translate' | 'fix' | 'ask' | 'remember' | 'remind';

export const ACTIONS: ReadonlyArray<[SelectionAction, string]> = [
  ['explain', '解释'],
  ['translate', '翻译'],
  ['fix', '改错'],
  ['ask', '问角色'],
  ['remember', '记住'],
  ['remind', '提醒'],
];

/** 提醒's times, as shown and as agentd's 「提醒我…」 parser reads them (commitments.py `RELATIVE`, `CLOCK`). */
export const REMIND_AT: ReadonlyArray<[string, string]> = [
  ['10 分钟', '10分钟后'],
  ['1 小时', '1小时后'],
  ['明天 9 点', '明天上午9点'],
];

/** Asked of her alone, out of memory: the instruction, a blank line, then the text. */
const INSTRUCTION: Partial<Record<SelectionAction, string>> = {
  explain: '解释这段文字',
  translate: '翻译这段文字：中文译成英文，其他语言译成中文',
  fix: '改正这段文字里的错字和语病，只回改好的文字',
};

/** The `/say` request of `action` on `text`; 提醒 takes `when`, one of `REMIND_AT`'s spoken times. */
export function selectionSay(action: SelectionAction, text: string, when = ''): SayRequest {
  const instruction = INSTRUCTION[action];
  if (instruction) return { text: `${instruction}\n\n${text}`, attachWindow: false, noMemory: true };
  if (action === 'ask') return { text, attachWindow: false, noMemory: true };
  const said = action === 'remember' ? `记住 ${text}` : `提醒我${when} ${text}`;
  return { text: said, attachWindow: false, noMemory: false };
}
