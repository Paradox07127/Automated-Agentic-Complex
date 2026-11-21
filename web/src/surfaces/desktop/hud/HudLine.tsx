import type { Act } from '../../stack/actions';
import type { HudRow, HudStatus } from './rows';
import styles from './HudLine.module.css';

const GLYPH_LABEL: Record<HudStatus, string> = { waiting: '待处理', error: '出错', running: '运行中', done: '完成', stale: '没有新动静' };

/** Mission icons: blue ring running, blue ring with the red-dot diamond waiting, red cross, yellow tick, faint ring stale. */
export function StatusGlyph({ status }: { status: HudStatus }) {
  return (
    <span className={styles.icon}>
      <svg className={styles.glyph} data-glyph={status} viewBox="0 0 16 16" role="img" aria-label={GLYPH_LABEL[status]}>
        {status === 'error' ? (
          <path d="M4 4l8 8M12 4l-8 8" />
        ) : status === 'done' ? (
          <>
            <circle cx="8" cy="8" r="6.5" />
            <path d="M4.9 8.2l2.1 2.1 4.1-4.5" />
          </>
        ) : (
          <>
            <circle cx="8" cy="8" r="5.5" />
            {status !== 'stale' && <circle className={styles.dot} cx="8" cy="8" r="2.2" />}
            {status === 'waiting' && <path className={styles.badgeDot} d="M13.5 0l2.5 2.5-2.5 2.5-2.5-2.5z" />}
          </>
        )}
      </svg>
    </span>
  );
}

/**
 * One line of the status bar: glyph, title, 「· 动作」; expanded adds backend and time, folded the 处理 button and the
 * total. The title gives way before the action does.
 */
export interface HudLineProps {
  row: HudRow;
  folded: boolean;
  total: number;
  act: Act;
  onHandle: () => void;
}

export function HudLine({ row, folded, total, act, onHandle }: HudLineProps) {
  const open = folded
    ? null
    : row.session
      ? () => act({ type: 'open-session', sessionId: row.id, title: row.title })
      : row.task
        ? () => act({ type: 'open', to: { page: 'overview', sel: row.task ?? undefined }, message: `已在主窗口打开：任务 › ${row.title}` })
        : null;
  return (
    <div className={styles.line}>
      <StatusGlyph status={row.status} />
      {open ? (
        <button type="button" className={styles.title} data-hud-title="" title={row.title} onClick={open}>
          {row.title}
        </button>
      ) : (
        <span className={styles.title} data-hud-title="" title={row.title}>
          {row.title}
        </span>
      )}
      {row.action && (
        <span className={styles.actBox}>
          <span className={styles.act} data-hud-act="" title={row.action}>
            │ {row.action}
          </span>
        </span>
      )}
      {!folded && (
        <span className={`${styles.meta} num`} data-hud-meta="" title={row.meta}>
          {row.meta}
        </span>
      )}
      {folded && row.status === 'waiting' && (
        <button
          type="button"
          className={styles.handle}
          onClick={(e) => {
            e.stopPropagation();
            onHandle();
          }}
        >
          处理
        </button>
      )}
      {folded && (
        <span className={`${styles.count} num`} data-hud-count="" title={`共 ${total} 条`}>
          {total}
        </span>
      )}
    </div>
  );
}
