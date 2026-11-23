// Browser-preview data of `stack.html#/bubble` (`demo=speech|thought|offer|reminder|done|error|look|confirm|confirm-danger|voice|mic|loading|hidden`,
// `mode=input`); native never reads it.
import type { StackPayload } from '../../../bridge';
import type { useComm } from '../comm/useComm';

type Obj = Record<string, unknown>;
type Card = StackPayload['cards'][number];

const MIN = 60_000;
const THOUGHT = { id: 'd-bubble-thought', text: '测试又红了，像是同一个超时。', offer: '帮我看看', reply: '好，帮我看看报错', reason: 'error', at: 0, session_id: null };
const LONG_OFFER = '要我等门禁和候选库通过后，接着构建替换测试包吗？';

/** The fake presence four minutes into her run, with a thought for `thought` and `offer` only. */
export function bubblePresence(raw: unknown, demo?: string | null): unknown {
  if (window.agenticComplex || !raw || typeof raw !== 'object') return raw;
  const p = raw as Obj;
  const at = typeof p.sampled_at === 'number' ? p.sampled_at : Date.now() / 1000;
  const thought = demo === 'offer' ? { ...THOUGHT, offer: LONG_OFFER } : demo === 'thought' ? THOUGHT : null;
  const ritual = demo === 'offer' ? { kind: 'report', since: at - 60 } : p.ritual;
  return { ...p, thought, ritual, role: { ...(p.role as Obj), doing: '在跑 swift test', since: at - 4 * 60 } };
}

function approval(now: number, dangerous = false): Card {
  return {
    id: 'bubble-a1',
    kind: 'approval',
    at: now - 2 * MIN,
    session: 'terminal',
    task_id: null,
    item: {
      id: 'bubble-a1', kind: 'approval', task_id: null, title: '运行命令', source: 'Codex │ 补桌面叠卡的设计说明', since: now - 2 * MIN,
      generation: 1, approval_kind: 'tool', agent: 'codex', display_session: 'bubble-s1', session_id: 'bubble-s1', tool: 'Bash',
      cmd: dangerous ? 'sudo rm -rf /usr/local/endfield' : 'rm -rf build/ && swift build', cwd: '~/Endfield', dangerous,
      ...(dangerous ? { danger_rule: 'rm_recursive' } : {}), options: ['allow', 'deny'], session_scope: null,
      dispatch: null, status: 'pending', window_s: 55, seconds_left: 48, fetched_at: now,
    },
  };
}

/**
 * The cards the bubble reads instead of the fake stack's: a due reminder, a result, a failed task, a 屏幕识读 receipt, an
 * approval, a listening voice hint, a denied microphone or a failed avatar, one per demo; none otherwise.
 */
export function bubbleCards(demo: string | null): StackPayload | null {
  if (window.agenticComplex) return null;
  const now = Date.now();
  const cards: Partial<Record<string, Card>> = {
    reminder: { id: 'rem-d1', kind: 'notice', variant: 'reminder', at: now - MIN, title: '16:00 组会：带上周报', commitment_id: 'd1' },
    done: { id: 'done-d1', kind: 'notice', variant: 'done', at: now, title: '桌面叠卡的设计说明补好了，三处截图已更新。', task_id: null },
    error: { id: 'err-d1', kind: 'error', at: now, task_id: 't-d1', title: '构建替换测试包', reason: 'swift build 在 HostLink 处失败：缺少 import' },
    voice: { id: 'voice-hint', kind: 'notice', variant: 'voice', at: now, phase: 'listening', title: '正在录音', elapsed_s: 3 },
    mic: { id: 'voice-hint', kind: 'notice', variant: 'voice', at: now, phase: 'mic_denied', title: '麦克风被拒', text: 'Agentic Complex 没有麦克风权限，按住说话用不了' },
    loading: { id: 'avatar-loading', kind: 'notice', variant: 'loading', at: now, phase: 'failed', title: '角色进程没能启动' },
    look: { id: `look-${now}`, kind: 'notice', variant: 'look', at: now, title: '已识读：Xcode — AppDelegate.swift' },
    confirm: approval(now),
    'confirm-danger': approval(now, true),
  };
  const card = demo ? cards[demo] : undefined;
  return { now, cards: card ? [card] : [], history: [] };
}

/** The line a demo plays: her reply for `speech`, and for `hidden` as a subtitle. */
export function bubbleLine(demo: string | null): Parameters<typeof useComm>[0] {
  if (window.agenticComplex) return null;
  return demo === 'speech' || demo === 'hidden' ? 'reply' : null;
}
