import { RunRing } from '../../charts';
import { formatDuration } from '../../domain';
import { Missing } from '../../ui';
import { RING, TOOL_LABEL, type BoardCard } from './board';
import styles from './TaskList.module.css';

/** How long the card has run; a live card started this second says so instead of `0 秒`. */
const cardTime = (c: Pick<BoardCard, 'first' | 'last'>, now: number) => (c.last == null && now - c.first < 1000 ? '刚开始' : formatDuration((c.last ?? now) - c.first));

export interface TaskListProps {
  cards: BoardCard[];
  now: number;
  selected: string | null;
  onOpen: (id: string) => void;
}

/** 列表视图：一张卡一行（状态、标题、来源、目录、时长、最近一句），一屏放得下十几个任务；窄页把来源和目录收到标题下面。 */
export function TaskList({ cards, now, selected, onOpen }: TaskListProps) {
  return (
    <div className={styles.list}>
      <div className={`${styles.row} ${styles.head}`} aria-hidden="true">
        <span>状态</span>
        <span>标题</span>
        <span className={styles.srcCol}>来源</span>
        <span className={styles.dirCol}>目录</span>
        <span className={styles.durCol}>时长</span>
        <span className={styles.lastCol}>最近一句</span>
      </div>
      <ul className={styles.rows}>
        {cards.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className={`${styles.row} ${styles.item}`}
              data-card={c.id}
              data-nav-target={`task-${c.taskId ?? c.id}`}
              data-status={c.status}
              data-on={selected === c.id || undefined}
              aria-label={`${c.title}，${c.stateText}，查看详情`}
              onClick={() => onOpen(c.id)}
            >
              <span className={styles.state} data-tone={c.status}>
                <RunRing state={RING[c.status]} phase={c.status === 'tool' ? 'tool' : c.status === 'wait' ? 'awaiting' : undefined} category={c.tool === 'role' ? 'mission' : 'neutral'} />
                <span className={styles.clip}>{c.stateText}</span>
              </span>
              <span className={styles.titleCell}>
                <span className={`${styles.clip} ${styles.title}`}>{c.title}</span>
                <span className={`${styles.clip} ${styles.sub}`}>
                  {TOOL_LABEL[c.tool]}
                  {c.dir && <span className={styles.dir}>{` │ ${c.dir}`}</span>}
                </span>
              </span>
              <span className={`${styles.clip} ${styles.srcCol}`}>{TOOL_LABEL[c.tool]}</span>
              <span className={`${styles.clip} ${styles.dir} ${styles.dirCol}`}>{c.dir ?? <Missing why="na" />}</span>
              <span className={`num ${styles.durCol}`}>{cardTime(c, now)}</span>
              <span className={`${styles.clip} ${styles.lastCol}`} title={c.lastReply ?? undefined}>
                {c.lastReply ?? <Missing why="na" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
