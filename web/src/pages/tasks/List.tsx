// Mission list pieces: list title, chapter groups, mission rows and their end shapes.
import type { CSSProperties, ReactNode } from 'react';
import { Icon, SecHead } from '../../ui';
import { useCountdown } from '../../features/approval/useCountdown';
import { Clock, Micro, TypeIcon } from './Glyphs';
import type { ListRow, RowGroup, Shape } from './rows';
import page from './Page.module.css';
import gs from './Group.module.css';
import styles from './List.module.css';

/** ListTitleNode: the count and the yellow bracket (the tab already names the list); `extra` sits after it (the search box). */
export function ListHead({ count, extra }: { count: number | null; extra?: ReactNode }) {
  return (
    <div className={page.lhead}>
      <span className={page.ln} aria-hidden="true" />
      <b className="num">[{count ?? '—'}]</b>
      <span className={page.br} aria-hidden="true" />
      {extra}
    </div>
  );
}

export function ShapeMark({ shape }: { shape: Shape }) {
  if (shape === 'trk' || shape === 'trkY')
    return (
      <span className={styles.trk} data-y={shape === 'trkY' || undefined} aria-hidden="true">
        <i />
        <i />
        <svg viewBox="0 0 34 34">
          <circle cx="17" cy="17" r="13" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <circle cx="17" cy="17" r="5" fill="currentColor" />
        </svg>
      </span>
    );
  if (shape === 'forbid')
    return (
      <svg className={styles.forbid} viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="11" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M7 7l16 16" stroke="currentColor" strokeWidth="2.6" />
      </svg>
    );
  if (shape === 'ok')
    return (
      <svg className={styles.okc} viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="60 8" transform="rotate(-30 15 15)" />
        <path d="M9 15.5l4 4 8-8.5" fill="none" stroke="currentColor" strokeWidth="2.8" />
      </svg>
    );
  return <span className={styles.hatch} aria-hidden="true" />;
}

function Countdown({ seconds }: { seconds: number }) {
  const left = useCountdown(seconds) ?? 0;
  return (
    <span className="num">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

function Tag({ tag }: { tag: NonNullable<ListRow['tag']> }) {
  return (
    <span className={gs.tag} data-tone={tag.tone}>
      {tag.icon === 'clock' && <Clock />}
      {tag.icon === 'chat' && <Icon name="send" size={12} />}
      {tag.clock != null ? <Countdown seconds={tag.clock} /> : tag.text}
    </span>
  );
}

export interface RowProps {
  row: ListRow;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function Row({ row, index, selected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      role="option"
      className={styles.row}
      data-src={row.src}
      data-row={row.id}
      data-nav-target={`task-${row.id}`}
      aria-selected={selected}
      aria-label={`${row.title}，${row.state}`}
      style={{ '--i': index } as CSSProperties}
      onClick={() => onSelect(row.id)}
    >
      <span className={styles.twill} aria-hidden="true" />
      <span className={styles.glow} aria-hidden="true" />
      {row.tag && <Tag tag={row.tag} />}
      <span className={styles.ico} aria-hidden="true">
        <TypeIcon kind={row.src} />
      </span>
      <span className={styles.dv} aria-hidden="true" />
      <span className={styles.tt}>
        <b>{row.title}</b>
        <small>
          <span className={styles.st} data-err={row.err || undefined}>
            {row.state}
          </span>
          {row.sub.map((s) => ` │ ${s}`).join('')}
        </small>
      </span>
      {row.who && (
        <span className={styles.who} aria-hidden="true">
          <span data-mono={row.src === 'code' || undefined}>{row.who}</span>
        </span>
      )}
      <Micro className={styles.micro} />
      <span className={styles.rn}>
        <ShapeMark shape={row.shape} />
      </span>
    </button>
  );
}

/** One chapter card of rows; `start` numbers the rows' fade-in across groups. */
export function Group({ group, start, selected, onSelect }: { group: RowGroup; start: number; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <section className={gs.grp} aria-label={group.title}>
      <SecHead title={group.title} count={group.rows.length} info={group.note} tone={group.vital ? 'waiting' : 'none'} />

      <div className={gs.rows} role="listbox" aria-label={group.title}>
        {group.rows.map((r, i) => (
          <Row key={r.id} row={r} index={start + i} selected={r.id === selected} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}
