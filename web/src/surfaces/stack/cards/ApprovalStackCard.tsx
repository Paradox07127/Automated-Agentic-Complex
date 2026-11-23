import { useContext } from 'react';
import { ApprovalCard, approvalView, InSession, type ApprovalStackItem } from '../../../features/approval';
import type { Act } from '../actions';
import { CardFrame } from '../CardFrame';
import { CompactCard } from '../compact';
import { keycapsFor } from '../keys';
import { PaperLine } from './PaperSheet';

/** 桌面审批卡（白纸）：broker 审批和角色审批共用 ApprovalCard 的白纸变体（危险批准只能鼠标点）；broker 的 [会话 ↗] 编码会话开任务页，外部会话跳到终端，[时间线 ↗] 在主窗口诊断的对话轮次里打开卡所在的那一轮，没记到回合时禁用；角色审批显示调用预览，[稍后] [取消这个请求] 收进 ⋯。 */
export interface ApprovalStackCardProps {
  card: ApprovalStackItem;
  index: number;
  total: number;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

export function ApprovalStackCard({ card, index, total, top, highlight, act }: ApprovalStackCardProps) {
  const view = approvalView(card);
  const compact = useContext(CompactCard);
  const inSession = useContext(InSession);
  const caps = keycapsFor(card);
  const broker = card.kind === 'approval' ? card : null;
  const openSession = broker
    ? () =>
        broker.session === 'terminal'
          ? act({ type: 'jump-terminal', sessionId: broker.item.session_id })
          : act({
              type: 'open',
              to: { page: 'overview', sel: broker.task_id ?? broker.item.task_id ?? undefined },
              message: `已在主窗口打开：任务 › ${broker.item.source.split(' │ ')[1] ?? broker.item.title}`,
            })
    : undefined;
  const trace = broker?.item.trace_id;
  const openTimeline = trace ? () => act({ type: 'open', to: { page: 'diag', tab: 'turns', turn: trace }, message: '已在主窗口打开：诊断 › 对话轮次' }) : undefined;
  return (
    // The white paper card has its own tape; the compact block in a session card takes the frame's.
    <CardFrame cardId={card.id} highlight={highlight} popup danger={inSession && view.dangerous}>
      <PaperLine esc={top && caps.esc} enter={top && caps.enter} />
      <ApprovalCard
        approval={broker?.item}
        view={view}
        surface="desk"
        position={{ index, total }}
        outcome={view.outcome}
        onDecide={(verdict, mode) => {
          const a = view.action(verdict, mode);
          if (a) act(a);
        }}
        onExtra={act}
        onOpenSession={openSession}
        onOpenTimeline={openTimeline}
        paper={{ top }}
        compact={compact}
      />
    </CardFrame>
  );
}
