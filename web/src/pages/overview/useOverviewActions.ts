import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { post, put, seg } from '../../bridge/agentd';
import { refreshRuntime } from '../../data/runtime';
import { approvalDecision, interactionAnswer, isoToMsOrNull, meeting, paused, quiet, type Approval, type PendingItem, type Question, type Session } from '../../domain';
import type { PushToast } from '../../shell/toast';
import { errText, isConflict } from './errors';
import type { OverviewSnapshot, Pause, Reminder } from './load';
import type { Go } from './nav';
import type { DecidedReceipt } from './PendingSection';
import type { WireCommitment } from './wire';

export type PauseKind = 'observe' | 'quiet' | 'meeting';

const DECISION_TEXT = { allow: '已批准', allow_session: '已批准（本会话）', deny: '已拒绝' } as const;
const NO_PAUSE: Pause = { paused_until: null, quiet_until: null, meeting: false, off: false };

/** Next 07:00 local after `now`: 「安静到明早」. */
export function nextMorning(now: number): number {
  const d = new Date(now);
  d.setHours(7, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Local state and agentd calls behind every overview button; each one lands somewhere visible. */
export function useOverviewActions(snap: OverviewSnapshot | undefined, now: number, go: Go, toast: PushToast, refetch: () => void) {
  const [decided, setDecided] = useState<Record<string, DecidedReceipt>>({});
  const [last, setLast] = useState<DecidedReceipt | null>(null);
  const [gone, setGone] = useState<Record<string, true>>({});
  const [pause, setPause] = useState<Pause>(NO_PAUSE);
  const qc = useQueryClient();

  // Only a new `/state` read resets the local pause; the page's other reads leave it alone.
  const read = snap?.pause;
  useEffect(() => {
    if (read !== undefined) setPause(read ?? NO_PAUSE);
  }, [read]);

  const fail = useCallback(
    (what: string) => (e: unknown) => {
      if (isConflict(e)) {
        toast(`${what}：已在别处更新，已重新读取`, { severity: 'warning' });
        refetch();
        return;
      }
      toast(`${what}失败：${errText(e)}`, { severity: 'danger', persistent: true });
    },
    [toast, refetch],
  );

  const settle = useCallback(
    (item: PendingItem, text: string) => {
      const r = { id: item.id, title: item.title, text, at: now };
      setDecided((d) => ({ ...d, [item.id]: r }));
      setLast(r);
      toast(`${text}：${item.title}`, { severity: 'success' });
    },
    [now, toast],
  );

  const onApprove = useCallback(
    (item: Approval, decision: 'allow' | 'deny' | 'allow_session', reason?: string) => {
      post(`/approvals/${seg(item.id)}/decision`, approvalDecision(item, decision, undefined, reason))
        .then(() => settle(item, DECISION_TEXT[decision]))
        .catch(fail('提交决定'));
    },
    [settle, fail],
  );

  /** A character approval (interaction kind approval) is answered with the label of its only question. */
  const onAnswer = useCallback(
    (item: Question, label: '允许' | '拒绝') => {
      const q = item.questions[0];
      if (!q) return;
      post(`/agent/interactions/${seg(item.id)}/answer`, interactionAnswer(item, { [q.id]: [label] }))
        .then(() => settle(item, label === '允许' ? '已允许' : '已拒绝'))
        .catch(fail('提交决定'));
    },
    [settle, fail],
  );

  /** A question answered on the 01 card. */
  const onReply = useCallback(
    (item: Question, answers: Record<string, string[]>) => {
      post(`/agent/interactions/${seg(item.id)}/answer`, interactionAnswer(item, answers))
        .then(() => settle(item, '已回答'))
        .catch(fail('提交回答'));
    },
    [settle, fail],
  );

  const onJumpSession = useCallback(
    (s: Session) => {
      getBridge()
        .open.jumpToSession(s.id)
        .then(() => {
          void post('/desktop/sessions/seen', { session_id: s.id }).catch(fail('标记会话已读'));
          toast(`已跳到终端：${s.agent} │ ${s.title}`);
        })
        .catch(fail('跳到终端'));
    },
    [toast, fail],
  );

  const reminderDone = useCallback(
    (r: Reminder, text: string) => () => {
      setGone((g) => ({ ...g, [r.id]: true }));
      toast(`${text}：${r.title}`);
    },
    [toast],
  );
  const onSnooze = useCallback(
    (r: Reminder, minutes: 10 | 60) => {
      post<{ commitment: WireCommitment }>(`/commitments/${seg(r.id)}/snooze`, { minutes })
        .then(reminderDone(r, `已延后 ${minutes} 分钟`))
        .catch(fail('延后提醒'));
    },
    [reminderDone, fail],
  );
  const onComplete = useCallback(
    (r: Reminder) => {
      post<{ commitment: WireCommitment }>(`/commitments/${seg(r.id)}/complete`).then(reminderDone(r, '已完成')).catch(fail('完成提醒'));
    },
    [reminderDone, fail],
  );
  const onCancel = useCallback(
    (r: Reminder) => {
      post<{ commitment: WireCommitment }>(`/commitments/${seg(r.id)}/cancel`).then(reminderDone(r, '已取消提醒')).catch(fail('取消提醒'));
    },
    [reminderDone, fail],
  );

  /** `minutes` is the length; 「到明早」 passes null and ends at the next 07:00. */
  const onPause = useCallback(
    (kind: PauseKind, minutes: number | null) => {
      let req: Promise<void>;
      if (kind === 'observe') {
        req = put<{ paused_until: string | null }>('/observation/paused', paused(minutes ?? 60)).then((r) => {
          setPause((p) => ({ ...p, paused_until: isoToMsOrNull(r.paused_until) }));
          toast('已暂停观察 1 小时');
        });
      } else if (kind === 'quiet') {
        req = put<{ quiet_until: string | null }>('/observation/quiet', quiet(minutes == null ? nextMorning(now) : now + minutes * 60_000)).then((r) => {
          setPause((p) => ({ ...p, quiet_until: isoToMsOrNull(r.quiet_until) }));
          toast('已进入免打扰·安静，提醒暂停');
        });
      } else {
        req = put<{ meeting: boolean }>('/observation/meeting', meeting(true)).then((r) => {
          setPause((p) => ({ ...p, meeting: r.meeting }));
          toast('已进入免打扰·开会，直到关闭');
        });
      }
      req.catch(fail('暂停'));
    },
    [now, toast, fail],
  );

  const onResume = useCallback(
    (kind: PauseKind) => {
      let req: Promise<unknown>;
      if (kind === 'observe') req = put('/observation/paused', paused(0)).then(() => setPause((p) => ({ ...p, paused_until: null })));
      else if (kind === 'quiet') req = put('/observation/quiet', quiet(null)).then(() => setPause((p) => ({ ...p, quiet_until: null })));
      else req = put('/observation/meeting', meeting(false)).then(() => setPause((p) => ({ ...p, meeting: false })));
      req.then(() => toast(kind === 'observe' ? '已恢复观察' : '已退出免打扰')).catch(fail('恢复'));
    },
    [toast, fail],
  );

  const onKernel = useCallback(
    (action: 'copy' | 'terminal' | 'switch' | 'recheck', value?: string) => {
      if (action === 'copy' && value) {
        getBridge().clipboard.writeText(value).then(() => toast(`已复制：${value}`)).catch(fail('复制'));
      } else if (action === 'terminal' && value) {
        getBridge()
          .open.runInTerminal(value)
          .then(() => toast(`已在终端运行：${value}，登录后点「重新检测」`))
          .catch(fail('在终端运行'));
      } else if (action === 'switch') {
        go({ page: 'settings', group: 'kernel' });
      } else if (action === 'recheck') {
        refreshRuntime(qc)
          .then(() => toast('已重新检测内核'))
          .catch(fail('重新检测内核'));
      }
    },
    [toast, fail, go, qc],
  );

  return { decided, setDecided, last, setLast, gone, pause, onApprove, onAnswer, onReply, onJumpSession, onSnooze, onComplete, onCancel, onPause, onResume, onKernel };
}
