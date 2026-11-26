// Carries out card and key actions through the bridge; every action ends in a visible change or toast.
import { useCallback, useEffect, useRef, type Dispatch } from 'react';
import { getBridge, type StackDecision } from '../../bridge';
import { revealText } from '../../bridge/platformText';
import { AgentdCallError, call } from '../../bridge/agentd';
import { completeReminder, snoozeReminder } from '../../data/reminders';
import { navRoute } from '../../shell/nav';
import { formatClock, meeting, quiet, type Severity } from '../../domain';
import { failureText } from '../../domain/errorText';
import { approvalView } from '../../features/approval/approvalView';
import { CANCEL_RECEIPT, type CardAction } from './actions';
import { keyActionFor } from './keys';
import { ELSEWHERE_RECEIPT_MS, isStackApproval, type StackCard } from './model';
import type { StackEvent } from './stackReducer';

export interface StackToast {
  text: string;
  tone: Severity;
  action?: { label: string; onClick: () => void };
}

export interface StackUi {
  toast: (t: StackToast | null) => void;
  setPause: (p: { kind: 'quiet' | 'meeting'; until: number | null } | null) => void;
}

/** Same wording as DecisionBar's hint: names the approve button by its label. */
export const DANGER_HINT = '危险操作只能用鼠标点击「批准」';

/** Native rejects a decision with `stale` when agentd says the card is gone or changed (404/409). */
const STALE_RECEIPT = '已在其他位置处理';
/** Native rejects with `declined` when the user said no to its confirm dialog. */
export const DECLINED_TOAST = '未确认，该决定未发送';
/** Native rejects with `partial` when the reject went through but the note's resume / continue did not. */
const PARTIAL_REJECT = '已驳回当前版本，但补充要求未能送达';

/** A request the bridge did not send comes back with status 0. */
const isOk = (status: number) => status >= 200 && status < 300;

/** Reply code the native shim puts on a rejected op (`stale`, `partial`, `offline` …). */
const codeOf = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;

/** `cardOf` reads the stack's current card by id. */
export function useStackActions(
  dispatch: Dispatch<StackEvent>,
  clock: () => number,
  still: boolean,
  ui: StackUi,
  cardOf: (id: string) => StackCard | undefined,
) {
  const bridge = getBridge();
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** Runs later unless the page is frozen for screenshots. */
  const schedule = useCallback(
    (fn: () => void, ms: number) => {
      if (!still) timers.current.push(setTimeout(fn, ms));
    },
    [still],
  );
  const archiveSoon = (id: string, title?: string) => schedule(() => dispatch({ type: 'archive', id, at: clock(), title }), title === STALE_RECEIPT ? ELSEWHERE_RECEIPT_MS : 1500);
  const say = (text: string, tone: Severity = 'neutral') => ui.toast({ text, tone });
  const notSent = (e: unknown) => say(codeOf(e) === 'declined' ? DECLINED_TOAST : `没能送达：${e instanceof Error ? e.message : String(e)}`, 'danger');

  const settle = (id: string, receipt: string) => {
    dispatch({ type: 'patch', id, patch: { receipt } });
    archiveSoon(id, receipt);
  };

  /** `approval`: a role approval's answer, which also writes the card's outcome. */
  const send = async (id: string, decision: StackDecision, receipt: string, approval?: { kind: 'approved' | 'denied'; confirmed: boolean }) => {
    try {
      await (approval?.confirmed ? bridge.stack.decide(id, decision, { confirmed: true }) : bridge.stack.decide(id, decision));
      if (approval) dispatch({ type: 'patch', id, patch: { outcome: { kind: approval.kind, at: clock(), text: receipt } } });
      settle(id, receipt);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'stale' || e instanceof AgentdCallError && (e.status === 404 || e.status === 409)) {
        const card = cardOf(id);
        // Native marks a lapsed role approval expired before it rejects with stale.
        if (card && isStackApproval(card) && card.outcome?.kind === 'expired') return;
        return settle(id, STALE_RECEIPT);
      }
      if (code === 'partial') {
        settle(id, '已驳回');
        return say(PARTIAL_REJECT, 'warning');
      }
      notSent(e);
    }
  };

  /** A reminder's 延后 or 完成 agentd refused (or the bridge did not send); the card stays. */
  const reminderFailed = (e: unknown, lead: string) => {
    const f = e instanceof AgentdCallError ? { status: e.status, code: e.code, detail: e.detail ?? null } : { status: 0 };
    say(`${lead}：${failureText(f).text}`, 'danger');
  };

  /** The reminder is settled in agentd: it leaves for history here and on native's stack. */
  const reminderSettled = (id: string, title: string) => {
    void bridge.stack.collapse(id).catch(() => {});
    dispatch({ type: 'archive', id, at: clock(), title });
  };

  const act = (a: CardAction) => {
    switch (a.type) {
      case 'decide': {
        const label = a.decision === 'deny' ? '已拒绝' : a.decision === 'allow_session' ? '已批准（本会话同类操作）' : '已批准';
        const decision: StackDecision = { kind: 'approval', verdict: a.decision, generation: a.generation, ...(a.mode ? { mode: a.mode } : {}) };
        (a.confirmed ? bridge.stack.decide(a.id, decision, { confirmed: true }) : bridge.stack.decide(a.id, decision)).then(
          () => {
            dispatch({ type: 'patch', id: a.id, patch: { outcome: { kind: a.decision === 'deny' ? 'denied' : 'approved', at: clock(), text: label } } });
            archiveSoon(a.id, label);
          },
          (e: unknown) => {
            // Only stale settles the card; anything else leaves the approval live in agentd and its buttons here.
            if (codeOf(e) !== 'stale') return notSent(e);
            dispatch({ type: 'patch', id: a.id, patch: { outcome: { kind: 'elsewhere', at: clock(), text: STALE_RECEIPT } } });
            archiveSoon(a.id, STALE_RECEIPT);
          },
        );
        return;
      }
      case 'answer': {
        const card = cardOf(a.id);
        const view = card && isStackApproval(card) ? approvalView(card) : null;
        const allowed = a.text === '允许' || a.text === '本对话都允许';
        const approval = view ? { kind: allowed ? ('approved' as const) : ('denied' as const), confirmed: a.confirmed === true } : undefined;
        return void send(a.id, { kind: 'answer', expected_version: a.expected_version, answers: a.answers }, `已回答：${a.text}`, approval);
      }
      case 'cancel-question':
        return void send(a.id, { kind: 'cancel-question', expected_version: a.expected_version }, CANCEL_RECEIPT);
      case 'accept':
        return void send(a.id, { kind: 'accept', task_id: a.task_id, delivery_id: a.delivery_id, expected_revision: a.expected_revision, generation: a.generation }, '已接受当前版本');
      case 'reject':
        return void send(
          a.id,
          { kind: 'reject', task_id: a.task_id, delivery_id: a.delivery_id, expected_revision: a.expected_revision, generation: a.generation, note: a.note },
          a.note ? `已驳回：${a.note}` : '已驳回',
        );
      case 'collapse':
        void bridge.stack.collapse(a.id).catch(() => {});
        return dispatch({ type: 'collapse', id: a.id });
      case 'dismiss':
      case 'archive': {
        // Native moves an archived error, notice or delivery to its own history, so it is not pushed again.
        const kind = cardOf(a.id)?.kind;
        if (kind === 'error' || kind === 'notice' || kind === 'delivery') void bridge.stack.collapse(a.id).catch(() => {});
        return dispatch({ type: 'archive', id: a.id, at: clock() });
      }
      case 'snooze':
        snoozeReminder(a.commitment, a.minutes).then(
          (due) => {
            const until = formatClock(due * 1000);
            reminderSettled(a.id, `提醒 │ 延后到 ${until}`);
            say(`已延后 ${a.minutes === 60 ? '1 小时' : `${a.minutes} 分钟`} │ ${until} 再提醒`);
          },
          (e: unknown) => reminderFailed(e, '没能延后提醒'),
        );
        return;
      case 'complete':
        completeReminder(a.commitment).then(
          () => reminderSettled(a.id, '提醒 │ 已完成'),
          (e: unknown) => reminderFailed(e, '没能完成提醒'),
        );
        return;
      case 'open':
        say(a.message);
        return bridge.window.openMain(navRoute(a.to));
      case 'jump-terminal':
        Promise.resolve(bridge.open.jumpToSession(a.sessionId)).then(
          () => {
            say(`已跳转至终端 │ 会话 ${a.sessionId}`);
            void call('POST', '/desktop/sessions/seen', { session_id: a.sessionId }).catch(() => say('未能标记会话为已读', 'warning'));
          },
          (e: unknown) => say(`跳转终端失败：${e instanceof Error ? e.message : String(e)}`, 'danger'),
        );
        return;
      case 'open-session':
        bridge.open.jumpToSession(a.sessionId).then(
          () => {
            say(`已打开会话：${a.title}`);
            // agentd marks only a done or error row seen; running work is untouched.
            void call('POST', '/desktop/sessions/seen', { session_id: a.sessionId }).catch(() => say('未能标记为已读', 'warning'));
          },
          (e: unknown) => say(`打开会话失败：${e instanceof Error ? e.message : String(e)}`, 'danger'),
        );
        return;
      case 'copy':
        void bridge.clipboard.writeText(a.text);
        return say(`已复制：${a.text}`);
      case 'reveal':
        Promise.resolve(bridge.open.revealInFinder(a.path)).then(
          () => say(`${revealText('已在 Finder 中显示')}：${a.path.split(/[\\/]/).at(-1) ?? a.path}`),
          (e: unknown) => say(`无法定位文件：${e instanceof Error ? e.message : String(e)}`, 'danger'),
        );
        return;
      case 'run-in-terminal':
        if (bridge.capabilities.runInTerminal) {
          Promise.resolve(bridge.open.runInTerminal(a.command)).then(
            () => say(`已在终端运行命令：「${a.command}」`),
            (e: unknown) => {
              if (codeOf(e) !== 'declined') say(`终端运行失败：${e instanceof Error ? e.message : String(e)}`, 'danger');
            },
          );
          return;
        }
        void bridge.clipboard.writeText(a.command);
        return say(`已复制「${a.command}」 │ 请粘贴至终端运行`);
    }
  };

  const onKey = (top: StackCard | undefined, key: string): boolean => {
    const k = keyActionFor(top, key);
    if (!k) return false;
    if (k.type === 'decide') {
      const a = top && isStackApproval(top) ? approvalView(top).action(k.decision) : null;
      if (a) act(a);
    } else if (k.type === 'danger-hint') say(DANGER_HINT, 'warning');
    else if (k.type === 'open-delivery' && top?.kind === 'delivery')
      act({ type: 'open', to: { page: 'overview', sel: top.delivery.task_id }, message: '已在主窗口打开交付' });
    else if (k.type === 'dismiss') act({ type: 'archive', id: k.id });
    else if (k.type === 'collapse') act({ type: 'collapse', id: k.id });
    return true;
  };

  /** PauseChip's 现在恢复. */
  const resume = (kind: 'quiet' | 'meeting') => {
    const req = kind === 'quiet' ? bridge.agentd.request('PUT', '/observation/quiet', quiet(null)) : bridge.agentd.request('PUT', '/observation/meeting', meeting(false));
    void req.then((r) => {
      if (!isOk(r.status)) return say(`恢复失败：${failureText({ status: r.status, code: r.error?.code, detail: r.error?.detail }).text}`, 'danger');
      ui.setPause(null);
      say('已恢复屏幕观察与主动交互', 'success');
    });
  };

  return { act, onKey, resume, schedule };
}
