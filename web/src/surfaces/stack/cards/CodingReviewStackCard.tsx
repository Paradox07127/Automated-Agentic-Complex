import { DecisionBar } from '../../../features/approval';
import type { Act, DeliveryRef } from '../actions';
import { Receipt } from '../../../ui';
import { Fold } from '../../../ui/Fold';
import { CardFrame } from '../CardFrame';
import type { StackCard } from '../model';
import body from './NoticeBody.module.css';
import { PaperLine, PaperSheet } from './PaperSheet';
import paper from './paper.module.css';

/** 编码任务复核卡：没有交付也没有期限，[退回] [接受] 直接送出（不收补充要求）；[打开任务] [稍后] 收进 ⋯。 */
export interface CodingReviewStackCardProps {
  card: Extract<StackCard, { kind: 'review'; source: 'coding' }>;
  top: boolean;
  highlight?: boolean;
  act: Act;
}

export function CodingReviewStackCard({ card, top, highlight, act }: CodingReviewStackCardProps) {
  const { item } = card;
  // Native settles a coding review from its own record; the delivery fields only fill the frozen decision shape.
  const ref: DeliveryRef = { task_id: item.task_id, delivery_id: '', expected_revision: 0, generation: 0 };
  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <PaperLine />
      <PaperSheet code="REVIEW" priority={1} label={`复核：${item.title}`}>
        <h3 className={paper.title}>{item.title}</h3>
        {card.summary && <p className={body.clamp}>{card.summary}</p>}
        <p className={body.meta}>
          <span className={paper.verify} data-v={item.verification_source}>
            {item.verification_source === 'auto' ? '✓ 已自动检查' : '▲ 未验证'}
          </span>
        </p>
        <Fold id={`review-${card.id}`} label="详情" summary={item.source}>
          <p className={body.meta}>
            <span>{item.source}</span>
            {item.cwd && <span>{item.cwd}</span>}
          </p>
        </Fold>
        {card.receipt ? (
          <Receipt>{card.receipt}</Receipt>
        ) : (
          <DecisionBar
            inset
            kind="review"
            secondaryEmphasis={!top}
            primary={{ label: '接受', onClick: () => act({ type: 'accept', id: card.id, ...ref }) }}
            secondary={[{ label: '驳回', onClick: () => act({ type: 'reject', id: card.id, note: '', ...ref }) }]}
            more={[
              { kind: 'item', label: '打开任务', onSelect: () => act({ type: 'open', to: { page: 'overview', sel: item.task_id }, message: `已在主窗口打开：任务 › ${item.title}` }) },
              { kind: 'item', label: '稍后', onSelect: () => act({ type: 'collapse', id: card.id }) },
            ]}
          />
        )}
      </PaperSheet>
    </CardFrame>
  );
}
