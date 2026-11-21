import { useRef, type ReactNode } from 'react';
import { BarList, Gantt, RunRing } from '../../charts';
import { formatClock, formatDuration, formatMs } from '../../domain';
import { IconBtn, Kbd, OverlayPortal, SecHead, useOverlayFocus } from '../../ui';
import { ganttRow, RING, statesOf, TOOL_LABEL, type BoardCard, type CardHistory, type CardTool } from './board';
import styles from './DetailSheet.module.css';

function ToolTag({ tool }: { tool: CardTool }) {
  return <span className={styles.tool}>{TOOL_LABEL[tool]}</span>;
}

/** Status shape ◆ / ■ before the state text; the ring beside the title carries the rest. */
const stateMark = (c: Pick<BoardCard, 'status'>) => (c.status === 'err' ? '■ ' : c.status === 'wait' ? '◆ ' : '');

export interface DetailSheetProps {
  title: string;
  tool: BoardCard['tool'] | null;
  onClose: () => void;
  children: ReactNode;
}

/** Right-hand detail sheet over the content area, 640 px; Esc, ✕ or a click on the scrim closes it. */
export function DetailSheet({ title, tool, onClose, children }: DetailSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <OverlayPortal>
      <div
        className={styles.scrim}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <aside ref={panel} className={styles.sheet} role="dialog" aria-modal="true" aria-label={`详情：${title}`} tabIndex={-1} onKeyDown={trap} data-sheet="">
          <div className={styles.head} data-part="head">
            {tool && <ToolTag tool={tool} />}
            <span className={styles.t3}>详情</span>
            <span className={styles.sp} />
            <Kbd>esc</Kbd>
            <IconBtn icon="close" label="关闭详情" size="sm" onClick={onClose} />
          </div>
          <div className={styles.body}>{children}</div>
        </aside>
      </div>
    </OverlayPortal>
  );
}

/** Header of a session no task row covers: what the ledger says. */
export function SessionHead({ card: c, now }: { card: BoardCard; now: number }) {
  return (
    <>
      <div className={styles.title}>
        <h2>{c.title}</h2>
        <span className={styles.sp} />
        <RunRing state={RING[c.status]} category="neutral" />
        <span className={styles.stateText} data-tone={c.status}>
          {stateMark(c)}
          {c.stateText}
        </span>
      </div>
      <p className={styles.sub}>
        {TOOL_LABEL[c.tool]}
        {c.dir ? ` │ ${c.dir}` : ''}
        <span className="num">{` │ ${formatClock(c.first)} 开始 │ ${formatDuration((c.last ?? now) - c.first)}`}</span>
      </p>
      <p className={styles.note}>此处只显示状态，输入请在 {TOOL_LABEL[c.tool]} 中进行</p>
    </>
  );
}

/** Coding-session sections from `/day/segments`: state bar and tool time. */
export function CodeSections({ card: c, history, now }: { card: BoardCard; history: CardHistory | undefined; now: number }) {
  const row = ganttRow(c, history, false);
  const tools = history?.tools ?? [];
  return (
    <div className={styles.code}>
      <SecHead no="01" title="状态时段" right={<span className={styles.t3}>{history ? `${row.segs.length} 段 │ 条上标记门禁失败和拦截` : '开始到结束'}</span>} />
      <Gantt label="会话状态时段" rows={[{ ...row, label: formatClock(c.first) }]} t0={c.first} t1={Math.max(c.last ?? now, c.first + 600_000)} now={c.last ? undefined : now} states={statesOf([row])} labelW={56} frame={false} />
      {tools.length > 0 && (
        <>
          <SecHead no="02" title="工具耗时" count={tools.reduce((n, t) => n + t[2], 0)} />
          <BarList label="工具耗时" top={4} rows={tools.map(([k, ms, n]) => ({ key: k, label: k, value: ms, readout: `${formatMs(ms)} │ ${n} 次` }))} />
        </>
      )}
    </div>
  );
}
