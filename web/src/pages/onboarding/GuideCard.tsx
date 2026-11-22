import { MicroLabel } from '../../ui/game';
import { pad2 } from './copy';
import styles from './GuideCard.module.css';

export interface GuideCardProps {
  /** The step's number, drawn hollow and large; 0 while the guide reads. */
  n: number;
  /** Micro English after「Step 02 / 03」. */
  en?: string;
  title: string;
  lead?: string;
  /** must: 必做; skip: 可跳过; none while the guide reads. */
  tag?: 'must' | 'skip';
}

/** The step card beside the media frame: the guide's IndexTxt / TitleTxt / DecoLine01 + 02 / ContentTxt, and 必做 or 可跳过. */
export function GuideCard({ n, en, title, lead, tag }: GuideCardProps) {
  return (
    <aside className={styles.card} data-g="text">
      <span className={styles.ghost} data-g="index" aria-hidden="true">
        {pad2(n)}
      </span>
      {en && (
        <span className={styles.mi} aria-hidden="true">
          <MicroLabel>{`Step ${pad2(n)} / 03 / ${en}`}</MicroLabel>
          <span className={styles.rec}>SET</span>
        </span>
      )}
      <h1 className={styles.h1} data-g="title">
        {title}
      </h1>
      <span className={styles.rule} data-g="rule" aria-hidden="true">
        <i data-g="ruleLine" />
        <b data-g="ruleLine2" />
      </span>
      {lead && <p className={styles.lead}>{lead}</p>}
      {tag && (
        <span className={styles.tag} data-k={tag}>
          {tag === 'must' ? '必做' : '可跳过'}
        </span>
      )}
    </aside>
  );
}
