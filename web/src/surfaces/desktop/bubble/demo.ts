// Browser-preview data of `stack.html#/bubble` (`demo=speech|reminder|voice|mic|loading|look|hidden`, `mode=input`); native never reads it.
import type { StackPayload } from '../../../bridge';
import type { useComm } from '../comm/useComm';

type Obj = Record<string, unknown>;

const THOUGHT = { id: 'd-bubble-thought', text: '测试又红了，像是同一个超时。', offer: '帮我看看', reply: '好，帮我看看报错', reason: 'error', at: 0, session_id: null };
const LONG_OFFER = '要我等门禁和候选库通过后，接着构建替换测试包吗？';

/** The fake presence with a thought and a 正在做 phrase four minutes into her run. */
export function bubblePresence(raw: unknown, demo?: string | null): unknown {
  if (window.agenticComplex || !raw || typeof raw !== 'object') return raw;
  const p = raw as Obj;
  const at = typeof p.sampled_at === 'number' ? p.sampled_at : Date.now() / 1000;
  const thought = demo === 'offer' ? { ...THOUGHT, offer: LONG_OFFER } : THOUGHT;
  const ritual = demo === 'offer' ? { kind: 'report', since: at - 60 } : p.ritual;
  return { ...p, thought, ritual, role: { ...(p.role as Obj), doing: '在跑 swift test', since: at - 4 * 60 } };
}

/**
 * The cards the bubble reads instead of the fake stack's: one due reminder for `reminder`, a listening voice hint for
 * `voice`, a denied microphone for `mic`, a failed avatar for `loading`, a 屏幕识读 receipt for `look`, none otherwise.
 */
export function bubbleCards(demo: string | null): StackPayload | null {
  if (window.agenticComplex) return null;
  const now = Date.now();
  const cards: Partial<Record<string, StackPayload['cards'][number]>> = {
    reminder: { id: 'rem-d1', kind: 'notice', variant: 'reminder', at: now - 60_000, title: '16:00 组会：带上周报', commitment_id: 'd1' },
    voice: { id: 'voice-hint', kind: 'notice', variant: 'voice', at: now, phase: 'listening', title: '正在录音', elapsed_s: 3 },
    mic: { id: 'voice-hint', kind: 'notice', variant: 'voice', at: now, phase: 'mic_denied', title: '麦克风被拒', text: 'Agentic Complex 没有麦克风权限，按住说话用不了' },
    loading: { id: 'avatar-loading', kind: 'notice', variant: 'loading', at: now, phase: 'failed', title: '角色进程没能启动' },
    look: { id: `look-${now}`, kind: 'notice', variant: 'look', at: now, title: '已识读：Xcode — AppDelegate.swift' },
  };
  const card = demo ? cards[demo] : undefined;
  return { now, cards: card ? [card] : [], history: [] };
}

/** The line a demo plays: her reply for `speech`, and for `hidden` as a subtitle. */
export function bubbleLine(demo: string | null): Parameters<typeof useComm>[0] {
  if (window.agenticComplex) return null;
  return demo === 'speech' || demo === 'hidden' ? 'reply' : null;
}
