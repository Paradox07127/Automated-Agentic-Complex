import styles from './QueueBar.module.css';

/** 队列条：每张待决定的卡一个 8×8 方块，危险卡 ■ danger；「后面还有 N 张 · M 张危险」只数没上屏的卡。 */
export interface QueueBarProps {
  /** 没上屏的待决定卡有几张 */
  more: number;
  /** 其中危险几张（同样只数没上屏的） */
  dangerous: number;
  /** 方块：全部待决定的卡，当前这张 current */
  cells?: Array<{ id: string; dangerous: boolean; current?: boolean; label: string }>;
  /** 另有几张通知没展开 */
  notices?: number;
  /** 已展开全部 */
  expanded?: boolean;
  /** 展开 / 收起 */
  onToggle?: () => void;
  /** 稍后 */
  onLater?: () => void;
}

export function QueueBar({ more, dangerous, cells = [], notices = 0, expanded, onToggle, onLater }: QueueBarProps) {
  const total = cells.length;
  const allDangerous = cells.filter((c) => c.dangerous).length;
  return (
    <div data-stub="QueueBar" className={styles.bar} role="group" aria-label="待决定队列">
      {total > 0 && (
        <span className={styles.cells} role="img" aria-label={`待处理 ${total} 张，其中危险 ${allDangerous} 张`}>
          {cells.map((c) => (
            <i key={c.id} className={[c.dangerous && styles.dg, c.current && styles.cur].filter(Boolean).join(' ')} title={c.label} />
          ))}
        </span>
      )}
      <span className={styles.text} title="只数没上屏的卡">
        后面还有 <b className="num">{more}</b> 张
        {dangerous > 0 && (
          <>
            {' │ '}
            <span className={styles.dgt}>■ {dangerous} 张危险</span>
          </>
        )}
        {notices > 0 && <span className={styles.sub}> │ 另有 {notices} 条通知</span>}
      </span>
      <span className={styles.sp} />
      {onToggle && (
        <button type="button" className={styles.btn} aria-expanded={!!expanded} onClick={onToggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
      {onLater && (
        <button type="button" className={styles.btn} onClick={onLater}>
          [稍后]
        </button>
      )}
    </div>
  );
}
