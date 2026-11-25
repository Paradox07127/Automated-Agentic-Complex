import { useState } from 'react';
import { getBridge } from '../../../bridge';
import { DecisionBar } from '../../../features/approval';
import { ArtifactList, DeliveryChain } from '../../../features/delivery';
import type { Act } from '../actions';
import { Receipt, TextArea } from '../../../ui';
import { Fold } from '../../../ui/Fold';
import { CardFrame } from '../CardFrame';
import { LifeLine } from '../LifeLine';
import type { StackCard } from '../model';
import { useHover } from '../useHover';
import { CodingReviewStackCard } from './CodingReviewStackCard';
import body from './NoticeBody.module.css';
import { PaperLine, PaperSheet } from './PaperSheet';
import paper from './paper.module.css';

/**
 * 桌面复核卡：摘要 2 行、验证来源、交付轨、产物（按能力位给「在 Finder 中显示」）；DecisionBar 放 [退回这一版] [接受这一版]，[打开产物] [稍后] 收进 ⋯。
 * 退回先收补充要求（与补充要求框同一流程）；60 s 寿命线悬停暂停，走完折叠进队列条，仍在待处理里。
 */
export interface ReviewStackCardProps {
  card: Extract<StackCard, { kind: 'review' }>;
  index: number;
  top: boolean;
  now: number;
  highlight?: boolean;
  act: Act;
}

export function ReviewStackCard(props: ReviewStackCardProps) {
  const { card } = props;
  return card.source === 'coding' ? <CodingReviewStackCard {...props} card={card} /> : <DeliveryReviewCard {...props} card={card} />;
}

function DeliveryReviewCard({ card, now, highlight, act }: ReviewStackCardProps & { card: Extract<StackCard, { kind: 'review'; source: 'delivery' }> }) {
  const { item, delivery } = card;
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const hover = useHover<HTMLElement>();
  const openTask = (message: string) => act({ type: 'open', to: { page: 'overview', sel: item.task_id }, message });
  const first = delivery.artifacts[0];
  const ref = { task_id: item.task_id, delivery_id: item.delivery_id, expected_revision: delivery.revision, generation: delivery.generation };

  return (
    <CardFrame cardId={card.id} highlight={highlight}>
      <PaperLine />
      <PaperSheet code="REVIEW" priority={1} label={`复核：${item.title}`} hoverRef={hover.ref} hoverHandlers={hover.handlers}>
        <h3 className={paper.title}>{item.title}</h3>
        <p className={body.clamp}>{card.summary}</p>
        <p className={body.meta}>
          <span className={paper.verify} data-v={item.verification_source}>
            {item.verification_source === 'auto' ? '✓ 已自动检查' : '▲ 未验证'}
          </span>
          <span>{item.source}</span>
        </p>
        <Fold id={`review-${card.id}`} label="交付链与产物" count={delivery.artifacts.length}>
          <DeliveryChain delivery={delivery} now={now} size="desk" />
          <ArtifactList
            artifacts={delivery.artifacts}
            layout="rows"
            canReveal={getBridge().capabilities.revealInFinder}
            onReveal={(path) => act({ type: 'reveal', path })}
            onOpen={(path) => openTask(`已打开产物 ${path.split(/[\\/]/).at(-1) ?? ''}`)}
            onCopyPath={(text) => act({ type: 'copy', text })}
          />
        </Fold>
        {rejecting && !card.receipt && (
          <label className={paper.reject}>
            <span>补充要求</span>
            <TextArea label="补充要求" rows={2} value={note} placeholder="例如：按项目分组，不要按日期" onChange={setNote} />
          </label>
        )}
        {card.receipt ? (
          <Receipt>{card.receipt}</Receipt>
        ) : (
          <DecisionBar
            inset
            kind="review"
            primary={
              rejecting
                ? { label: '驳回并继续', disabled: !note.trim(), disabledReason: '请先填写补充要求', onClick: () => act({ type: 'reject', id: card.id, note: note.trim(), ...ref }) }
                : { label: '接受当前版本', onClick: () => act({ type: 'accept', id: card.id, ...ref }) }
            }
            secondary={rejecting ? [{ label: '取消', onClick: () => setRejecting(false) }] : [{ label: '驳回当前版本', onClick: () => setRejecting(true) }]}
            more={[
              { kind: 'item', label: '打开产物', disabled: !first, onSelect: () => first && openTask(`已打开产物 ${first.name}`) },
              { kind: 'item', label: '稍后', onSelect: () => act({ type: 'collapse', id: card.id }) },
            ]}
          />
        )}
        {!card.receipt && <LifeLine totalS={card.lifeTotalS} leftS={card.lifeS} paused={hover.hovered || rejecting} onEnd={() => act({ type: 'collapse', id: card.id })} />}
      </PaperSheet>
    </CardFrame>
  );
}
