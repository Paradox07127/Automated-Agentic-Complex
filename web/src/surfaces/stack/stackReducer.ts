// Stack state: cards, history, expanded flag and tab. Pure reducer so tests can drive it.
import { cardTitle, isWaiting, priorityOf, type StackCard, type StackHistoryEntry, type StackPayload } from './model';

export interface StackState {
  cards: StackCard[];
  history: StackHistoryEntry[];
  /** Show every open card instead of the P0 cards and the top one. */
  showAll: boolean;
  tab: 'now' | 'history';
  /** Card the user jumped to from the 「等你」 tag or a history row; flashes once. */
  highlight: string | null;
  /** Chat window cards brought back from history, which the stack shows again. */
  restored: string[];
}

export type StackEvent =
  | { type: 'load'; payload: StackPayload; showAll?: boolean; tab?: 'now' | 'history' }
  | { type: 'add'; card: StackCard }
  | { type: 'patch'; id: string; patch: Partial<StackCard> }
  | { type: 'replace'; id: string; card: StackCard }
  | { type: 'remove'; id: string }
  | { type: 'archive'; id: string; at: number; title?: string }
  | { type: 'restore'; historyId: string; at: number }
  | { type: 'collapse'; id: string }
  | { type: 'expand-all' }
  | { type: 'show-less' }
  | { type: 'collapse-all' }
  | { type: 'tab'; tab: 'now' | 'history' }
  | { type: 'highlight'; id: string | null };

export const initialStack: StackState = { cards: [], history: [], showAll: false, tab: 'now', highlight: null, restored: [] };

export function stackReducer(s: StackState, e: StackEvent): StackState {
  switch (e.type) {
    case 'load': {
      // P0 stays on top: a new card waiting for a P0/P1 decision brings the 历史 tab back to now.
      const urgent = e.payload.cards.some((c) => isWaiting(c) && priorityOf(c) <= 1 && !s.cards.some((old) => old.id === c.id));
      return { ...s, cards: e.payload.cards, history: e.payload.history, showAll: e.showAll ?? s.showAll, tab: e.tab ?? e.payload.tab ?? (urgent ? 'now' : s.tab) };
    }
    case 'add':
      return { ...s, cards: [...s.cards.filter((c) => c.id !== e.card.id), e.card], tab: 'now' };
    case 'patch':
      return { ...s, cards: s.cards.map((c) => (c.id === e.id ? ({ ...c, ...e.patch } as StackCard) : c)) };
    case 'replace':
      return { ...s, cards: s.cards.map((c) => (c.id === e.id ? e.card : c)) };
    case 'remove':
      return { ...s, cards: s.cards.filter((c) => c.id !== e.id) };
    case 'archive': {
      const card = s.cards.find((c) => c.id === e.id);
      if (!card) return s;
      const entry: StackHistoryEntry = { id: `h-${card.id}-${e.at}`, at: e.at, title: e.title ?? cardTitle(card), card };
      return { ...s, cards: s.cards.filter((c) => c.id !== e.id), history: [entry, ...s.history] };
    }
    case 'restore': {
      const entry = s.history.find((h) => h.id === e.historyId);
      if (!entry) return s;
      const card = { ...entry.card, at: e.at, collapsed: false, receipt: undefined } as StackCard;
      return {
        ...s,
        cards: [...s.cards.filter((c) => c.id !== card.id), card],
        history: s.history.filter((h) => h.id !== e.historyId),
        tab: 'now',
        highlight: card.id,
        restored: s.restored.includes(card.id) ? s.restored : [...s.restored, card.id],
      };
    }
    case 'collapse':
      return { ...s, cards: s.cards.map((c) => (c.id === e.id ? { ...c, collapsed: true } : c)) };
    case 'expand-all':
      // 「还有 N 张」 counts every card off screen, so opening the stack unfolds them all.
      return { ...s, showAll: true, tab: 'now', cards: s.cards.map((c) => (c.collapsed ? { ...c, collapsed: false } : c)) };
    case 'show-less':
      return { ...s, showAll: false };
    case 'collapse-all':
      return { ...s, showAll: false, cards: s.cards.map((c) => (c.collapsed ? c : { ...c, collapsed: true })) };
    case 'tab':
      return s.tab === e.tab ? s : { ...s, tab: e.tab };
    case 'highlight':
      return s.highlight === e.id ? s : { ...s, highlight: e.id };
  }
}
