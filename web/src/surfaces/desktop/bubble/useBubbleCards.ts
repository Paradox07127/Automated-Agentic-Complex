import { useEffect, useRef, useState } from 'react';
import { getBridge, type DropItem, type StackPayload } from '../../../bridge';
import { AgentdCallError, call, seg } from '../../../bridge/agentd';
import type { NoticeVariant } from '../../../domain';
import type { StackCard } from '../../stack/model';
import { stageDrop } from '../cmd/input/selection';
import { why } from './useThoughtMute';

export type ReminderCard = Extract<StackCard, { variant: NoticeVariant }> & { variant: 'reminder' };
type DropCard = Extract<StackCard, { variant: 'drop' }>;
export type VoiceCard = Extract<StackCard, { variant: 'voice' }>;
export type LoadingCard = Extract<StackCard, { variant: 'loading' }>;
type LookCard = Extract<StackCard, { variant: NoticeVariant }> & { variant: 'look' };

/** 稍后 on a due reminder. */
export const LATER_MIN = 10;

const isReminder = (c: StackCard): c is ReminderCard => c.kind === 'notice' && c.variant === 'reminder';
const isDrop = (c: StackCard): c is DropCard => c.kind === 'notice' && c.variant === 'drop';
const isVoice = (c: StackCard): c is VoiceCard => c.kind === 'notice' && c.variant === 'voice' && !c.collapsed;
const isLoading = (c: StackCard): c is LoadingCard => c.kind === 'notice' && c.variant === 'loading' && !c.collapsed;
const isLook = (c: StackCard): c is LookCard => c.kind === 'notice' && c.variant === 'look' && !c.collapsed;
const newest = <T extends StackCard>(cards: T[]): T | null => cards.reduce<T | null>((a, c) => (a && a.at >= c.at ? a : c), null);

/** Opens 快速输入 for a drop, with a read scope over its files when agentd can read any of them (the drop card's 问). */
async function askAbout(card: DropCard) {
  const bridge = getBridge();
  const files = card.items.filter((i): i is Extract<DropItem, { kind: 'file' }> => i.kind === 'file');
  const scope = files.length
    ? await call<{ scope_id: string; files: unknown[]; roots: unknown[]; unsupported: Array<{ path: string }> }>('POST', '/agent/scopes', {
        files: files.map((f) => ({ handle: f.handle })),
      }).catch((e: unknown) => {
        if (e instanceof AgentdCallError && e.code === 'no_supported_files') return null;
        throw e;
      })
    : null;
  const arg = scope ? { scopeId: scope.scope_id, files: scope.files.length + scope.roots.length } : undefined;
  // Without a scope every dropped path goes with the message (`dropSay`).
  stageDrop(card.items, arg && { ...arg, unsupported: scope?.unsupported.map((u) => u.path) });
  try {
    return await (arg ? bridge.desktop.action('quickInput', JSON.stringify(arg)) : bridge.desktop.action('quickInput'));
  } catch (e) {
    stageDrop(null);
    throw e;
  }
}

/**
 * What the bubble takes from `stack.onCards`: the newest due reminder (`rem-*`), with 知道了 and 稍后 through the same
 * commitment routes as the stack's, the newest open voice hint, avatar loading card and 屏幕识读 receipt, and each new drop card, which
 * opens 快速输入 once and leaves native's stack.
 */
export function useBubbleCards(demo: StackPayload | null) {
  const [cards, setCards] = useState<StackCard[]>([]);
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const latestDrop = useRef<string | null>(null);

  useEffect(() => {
    if (demo) return setCards(demo.cards);
    return getBridge().stack.onCards(
      (p) => setCards(p.cards),
      () => {},
    );
  }, [demo]);

  const drop = newest(cards.filter(isDrop));
  useEffect(() => {
    if (!drop || asked.current.has(drop.id)) return;
    asked.current.add(drop.id);
    latestDrop.current = drop.id;
    setDropError(null);
    void askAbout(drop).then(
      () => void getBridge().stack.collapse(drop.id).catch(() => {}),
      (e: unknown) => {
        if (latestDrop.current === drop.id) setDropError(`快速输入没有打开：${why(e)}`);
      },
    );
  }, [drop]);

  const reminder = newest(cards.filter((c) => isReminder(c) && !settled.has(c.id)) as ReminderCard[]);
  const voice = newest(cards.filter(isVoice));
  const loading = newest(cards.filter(isLoading));
  const look = newest(cards.filter(isLook));

  const settle = async (card: ReminderCard, lead: string, step: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
      void getBridge().stack.collapse(card.id).catch(() => {});
      setSettled((s) => new Set(s).add(card.id));
    } catch (e) {
      setError(`${lead}：${why(e)}`);
    }
    setBusy(false);
  };
  const commitment = (card: ReminderCard) => seg(card.commitment_id ?? '');
  // agentd marks a one-time reminder fulfilled when it announces it, so 完成 may find nothing left to move.
  const ack = (card: ReminderCard) =>
    settle(card, '没能完成提醒', () =>
      card.commitment_id
        ? call('POST', `/commitments/${commitment(card)}/complete`).catch((e: unknown) => {
            if (!(e instanceof AgentdCallError && e.code === 'illegal_transition')) throw e;
          })
        : Promise.resolve(),
    );
  const later = (card: ReminderCard) => settle(card, '没能延后提醒', () => call('POST', `/commitments/${commitment(card)}/snooze`, { minutes: LATER_MIN }));

  return { reminder, voice, loading, look, busy, error, dropError, ack, later };
}
