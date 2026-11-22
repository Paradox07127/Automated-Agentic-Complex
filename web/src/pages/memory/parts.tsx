import { useRef, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react';
import { keyText } from '../../bridge/platformText';
import type { MemorySource } from '../../domain';
import { OverlayPortal, useOverlayFocus } from '../../ui';
import { Barcode, MicroLabel } from '../../ui/game';
import { SRC } from './model';
import cells from './Cells.module.css';
import styles from './parts.module.css';
import side from './Side.module.css';

/** Glyphs the shared icon set has no shape for, drawn on a 24 grid. */
const PATHS = {
  vote: 'M3 9h4.5v9H3zM9.75 13h4.5v5h-4.5zM16.5 4H21v14h-4.5zM3 19.5h18V22H3z',
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  pref: 'M12 2l10 10-10 10L2 12zM12 7l-5 5 5 5 5-5zM12 10l2 2-2 2-2-2z',
  deal: 'M3 6h7v3H6v6h4v3H3zM14 6h7v12h-7v-3h4V9h-4zM8 10.5h8v3H8z',
  flag: 'M4 2h2.5v20H4zM8 3h12l-3 4.5L20 12H8z',
  dots: 'M3 3h5v5H3zM9.5 3h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zM9.5 9.5h5v5h-5zM3 16h5v5H3z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  arrow: 'M9 4L6.8 6.2l5.8 5.8-5.8 5.8L9 20l8-8z',
  check: 'M3 12.5l2.2-2.2 4.3 4.3 9.3-9.3 2.2 2.2L9.5 19z',
  eye: 'M12 5c5 0 9 4.5 10.5 7C21 14.5 17 19 12 19S3 14.5 1.5 12C3 9.5 7 5 12 5zm0 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  history: 'M13 3a9 9 0 1 1-8.6 11.6l2.8-.9A6 6 0 1 0 8 8.4L10 10H3V3l2.6 2.6A9 9 0 0 1 13 3zM12 7h2v5l3.5 2.1-1 1.7L12 13.2z',
  folder: 'M2 4h8l2 2.5h10V20H2z',
  trash: 'M8 2h8v2h5v3H3V4h5zM5 9h14l-1.2 13H6.2z',
  search: 'M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-2 2-5.4-5.4A8 8 0 1 1 10 2zm0 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  close: 'M5.1 3L12 9.9 18.9 3 21 5.1 14.1 12 21 18.9 18.9 21 12 14.1 5.1 21 3 18.9 9.9 12 3 5.1z',
} as const;
export type GlyphName = keyof typeof PATHS;

export const Glyph = ({ name, size = 20 }: { name: GlyphName; size?: number }) => (
  <svg className={styles.glyph} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <path fillRule="evenodd" d={PATHS[name]} />
  </svg>
);

/** The page palette's class, for the page root and the overlays portalled out of it. */
export const VARS = styles.vars;
/** The dark data panel's class, for a panel that lays out its own children. */
export const PANEL = styles.pn;

const NARROW = '(max-width: 1199px)';
const mq = () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null);
/** Below 1200 px the detail column folds into a drawer that opens over the list. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = mq();
      m?.addEventListener('change', on);
      return () => m?.removeEventListener('change', on);
    },
    () => mq()?.matches ?? false,
  );
}

/** Source mark: filled = 你说的, dot = 你确认的, half = 她看到的, dashed hatch = 她猜的; the word goes beside it. */
export const SrcMark = ({ src }: { src: MemorySource }) => <i className={styles.sg} data-s={SRC[src].key} aria-hidden="true" />;

/** `INDEX ───── ⁄⁄⁄⁄` line over the left column's cells. */
export const Sep = ({ en }: { en: string }) => (
  <div className={cells.sep} aria-hidden="true">
    {en}
  </div>
);

export interface CellProps {
  icon: GlyphName;
  label: string;
  /** Count at the right end; null draws 「—」 (not read yet). */
  count?: number | null;
  selected: boolean;
  /** 待确认: the count stands out and an orange diamond marks the cell. */
  pending?: boolean;
  /** Entrance order. */
  i: number;
  onClick: () => void;
}

/** Left-column category cell (wiki TabCell): light plate with a hatch and ticks; picked, a dark contour plate, a yellow bar and a yellow icon. */
export function Cell({ icon, label, count, selected, pending, i, onClick }: CellProps) {
  return (
    <button
      type="button"
      className={cells.cell}
      aria-pressed={selected}
      data-pend={pending || undefined}
      data-zero={count === 0 || undefined}
      style={{ '--i': i } as CSSProperties}
      onClick={onClick}
    >
      <i className={cells.yb} aria-hidden="true" />
      <Glyph name={icon} />
      <span className={cells.ct}>{label}</span>
      {count !== undefined && <span className={`${cells.n} num`}>{count ?? '—'}</span>}
      {pending && <i className={cells.rd} aria-hidden="true" />}
    </button>
  );
}

/** White capsule search box (⌘F); `onSubmit` makes it search on Enter only. Esc clears it, then leaves it. */
export function SearchBox({ value, label, placeholder, inputRef, onChange, onSubmit }: { value: string; label: string; placeholder: string; inputRef?: Ref<HTMLInputElement>; onChange: (v: string) => void; onSubmit?: () => void }) {
  return (
    <form
      role="search"
      className={cells.field}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      <Glyph name="search" size={16} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        maxLength={500}
        data-search=""
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onChange('');
          }
        }}
      />
      {value ? (
        <button type="button" className={cells.clear} aria-label="清除搜索" title="清除搜索" onClick={() => onChange('')}>
          <Glyph name="close" size={12} />
        </button>
      ) : (
        <kbd className={cells.key}>{keyText('⌘F')}</kbd>
      )}
    </form>
  );
}

/** Dark data panel with corner ticks; the rows and the detail sit on it in both themes. */
export const Panel = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className={styles.pn} data-theme="dark" role={label ? 'region' : undefined} aria-label={label}>
    {children}
  </div>
);

/** Group head: black cut-corner tag 「偏好 [5]」, a rule ending in a hatch, and a micro label or a note at the right. */
export function GroupHead({ label, count, en, note }: { label: string; count?: number; en?: string; note?: string }) {
  return (
    <div className={styles.gh}>
      <span className={styles.tag}>
        {label}
        {count != null && <span className="num">[{count}]</span>}
      </span>
      <span className={styles.rule} aria-hidden="true" />
      {note ? <small>{note}</small> : en && <MicroLabel>{en}</MicroLabel>}
    </div>
  );
}

export interface RowProps {
  lead: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  selected: boolean;
  label?: string;
  /** Entrance order. */
  i: number;
  fresh?: boolean;
  onClick: () => void;
}

/** Dark record row (operator-profile voice row): a lead block, two lines of text, status tags and a barcode; picked, a white frame and a yellow end bar. */
export function Row({ lead, title, sub, end, selected, label, i, fresh, onClick }: RowProps) {
  return (
    <button type="button" className={styles.row} aria-pressed={selected} aria-label={label} data-fresh={fresh || undefined} style={{ '--i': Math.min(i, 12) } as CSSProperties} onClick={onClick}>
      <span className={styles.lb}>{lead}</span>
      <span className={styles.tt}>
        <b>{title}</b>
        {sub != null && <small>{sub}</small>}
      </span>
      <span className={styles.rt}>
        {end}
        <span className={styles.bc}>
          <Barcode width={92} height={16} />
        </span>
      </span>
    </button>
  );
}

/** Status tag on a row or in the detail: framed text, dashed when dormant. */
export const Tag = ({ children, dashed }: { children: ReactNode; dashed?: boolean }) => (
  <span className={styles.st} data-dashed={dashed || undefined}>
    {children}
  </span>
);

/** Detail title bar (profile tab, picked): yellow divider, title, micro label, barcode; the drawer adds a close button. */
export function DetailHead({ title, micro, onClose }: { title: ReactNode; micro: string; onClose?: () => void }) {
  return (
    <div className={side.dh}>
      <i className={side.y} aria-hidden="true" />
      <span className={side.dt}>{title}</span>
      <MicroLabel>{micro}</MicroLabel>
      <span className={side.bcode}>
        <Barcode width={86} height={18} />
      </span>
      {onClose && (
        <button type="button" className={side.orb} aria-label="关闭" title="关闭" onClick={onClose}>
          <Glyph name="close" size={13} />
        </button>
      )}
    </div>
  );
}

export const Kv = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className={side.kvr}>
    <span>{k}</span>
    <span className={side.v}>{children}</span>
  </div>
);

/** Detail block with a yellow-barred heading. */
export const Block = ({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) => (
  <section className={side.blk} aria-label={title}>
    <h3 className={side.bh}>
      {title}
      {note != null && <small>{note}</small>}
    </h3>
    {children}
  </section>
);

/** Quoted source: a left rule, the line or what she saw, a meta line with its jump; a large closing quote mark behind. */
export const Quote = ({ children, meta }: { children: ReactNode; meta?: ReactNode }) => (
  <div className={side.ev}>
    <div className={side.evt}>{children}</div>
    {meta != null && <div className={side.m}>{meta}</div>}
  </div>
);

export const Lnk = ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
  <button type="button" className={side.lnk} onClick={onClick}>
    {children}
  </button>
);

/** The right column: always there when wide; below 1200 px a drawer over the list with a dimmed backdrop. */
export function DetailCol({ narrow, open, label, onClose, children }: { narrow: boolean; open: boolean; label: string; onClose: () => void; children: ReactNode }) {
  if (!narrow)
    return (
      <aside className={side.dcol} aria-label={label}>
        {children}
      </aside>
    );
  if (!open) return null;
  return (
    <OverlayPortal>
      <Drawer label={label} onClose={onClose}>
        {children}
      </Drawer>
    </OverlayPortal>
  );
}

function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <div
      className={`${side.scrim} ${styles.vars}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside ref={panel} className={`${side.dcol} ${side.drawer}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>
        {children}
      </aside>
    </div>
  );
}

/** Six shimmering row slots while a list loads. */
export const Skeleton = () => (
  <div className={styles.list} aria-busy="true" aria-label="读取中">
    {Array.from({ length: 6 }, (_, i) => (
      <div key={i} className={styles.skel} />
    ))}
  </div>
);

/** One reason line and at most one action, inside a panel. */
export function Empty({ title, text, action, mark }: { title: string; text?: string; action?: ReactNode; mark?: boolean }) {
  return (
    <div className={styles.empty}>
      <span className={styles.eh}>
        {mark && <i aria-hidden="true" />}
        <b>{title}</b>
      </span>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

/** Scrollable list body of a panel. */
export const List = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className={styles.list} role={label ? 'group' : undefined} aria-label={label}>
    {children}
  </div>
);
