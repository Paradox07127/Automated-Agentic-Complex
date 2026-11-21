import { isApprovalCard } from '../../features/approval';
import type { Act } from './actions';
import { ApprovalStackCard } from './cards/ApprovalStackCard';
import { DeliveryStackCard } from './cards/DeliveryStackCard';
import { ErrorStackCard } from './cards/ErrorStackCard';
import { NoticeStackCard } from './cards/NoticeStackCard';
import { QuestionStackCard } from './cards/QuestionStackCard';
import { ReviewStackCard } from './cards/ReviewStackCard';
import { CompactCard } from './compact';
import type { StackCard } from './model';

/** One stack card by kind. `index` is its 1-based place among the visible cards; `compact` folds it to its title line and main buttons. */
export interface StackCardViewProps {
  card: StackCard;
  index: number;
  total: number;
  top: boolean;
  now: number;
  highlight?: boolean;
  compact?: boolean;
  act: Act;
}

export function StackCardView({ compact = false, ...props }: StackCardViewProps) {
  return (
    <CompactCard.Provider value={compact}>
      <CardByKind {...props} />
    </CompactCard.Provider>
  );
}

function CardByKind({ card, index, total, top, now, highlight, act }: StackCardViewProps) {
  switch (card.kind) {
    case 'approval':
      return <ApprovalStackCard card={card} index={index} total={total} top={top} highlight={highlight} act={act} />;
    case 'question':
      if (isApprovalCard(card)) return <ApprovalStackCard card={card} index={index} total={total} top={top} highlight={highlight} act={act} />;
      return <QuestionStackCard card={card} index={index} top={top} now={now} highlight={highlight} act={act} />;
    case 'review':
      return <ReviewStackCard card={card} index={index} top={top} now={now} highlight={highlight} act={act} />;
    case 'delivery':
      return <DeliveryStackCard card={card} index={index} top={top} now={now} highlight={highlight} act={act} />;
    case 'error':
      return <ErrorStackCard card={card} top={top} highlight={highlight} act={act} />;
    case 'notice':
      return <NoticeStackCard card={card} index={index} top={top} now={now} highlight={highlight} act={act} />;
  }
}
