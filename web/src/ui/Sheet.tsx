import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { KV } from './KV';
import { IconBtn } from './IconBtn';
import { OverlayPortal, useOverlayFocus } from './Dialog';
import styles from './Sheet.module.css';

/** 右侧抽屉：补充信息，宽 360、420、480、560 或 640（宽两档不超过窗口减 48）；焦点陷阱，Esc 关闭，关闭后焦点回到触发处。给了 dockFrom 时，窗口够宽就在页面里常驻成右栏。 */
export interface SheetProps {
  /** 是否打开 */
  open: boolean;
  /** 标题；head 不是 title 时只给读屏 */
  title: ReactNode;
  /** 宽度，默认 360；560、640 在窄窗口里不超过窗口减 48 */
  width?: 360 | 420 | 480 | 560 | 640;
  /** 内容，过长时在抽屉内滚动 */
  children?: ReactNode;
  /** Esc、关闭按钮或点遮罩 */
  onClose?: () => void;
  /** 头部：title 标题加关闭键（默认）；close 只有关闭键；none 不画，内容自带头 */
  head?: 'title' | 'close' | 'none';
  /** 窗口至少这么宽（px）时，在原处常驻成右栏：不遮罩、不抢焦点，不看 open */
  dockFrom?: number;
  /** 关闭键的读屏名称和 tooltip，默认「关闭」 */
  closeLabel?: string;
}

/** A string title names the drawer directly; a node names it through the element that shows it. */
function named(title: ReactNode, id: string, shown: boolean) {
  if (typeof title === 'string') return { label: { 'aria-label': title }, hidden: null };
  return { label: { 'aria-labelledby': id }, hidden: shown ? null : <span id={id} hidden>{title}</span> };
}

function useMinWidth(px: number | undefined): boolean {
  const query = px == null ? null : `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => (query ? (window.matchMedia?.(query).matches ?? true) : false));
  useEffect(() => {
    const mq = query ? window.matchMedia?.(query) : undefined;
    if (!mq) return;
    const changed = () => setWide(mq.matches);
    changed();
    mq.addEventListener('change', changed);
    return () => mq.removeEventListener('change', changed);
  }, [query]);
  return wide;
}

export function Sheet(props: SheetProps) {
  const docked = useMinWidth(props.dockFrom);
  const titleId = useId();
  if (docked) {
    const { label, hidden } = named(props.title, titleId, (props.head ?? 'title') === 'title');
    return (
      <aside className={styles.dock} data-stub="Sheet" data-docked="" data-width={props.width ?? 360} {...label}>
        <Head {...props} titleId={titleId} />
        {hidden}
        <div className={styles.body}>{props.children}</div>
      </aside>
    );
  }
  return props.open ? (
    <OverlayPortal>
      <SheetBody {...props} />
    </OverlayPortal>
  ) : null;
}

function Head({ title, head = 'title', onClose, titleId, closeLabel = '关闭' }: SheetProps & { titleId?: string }) {
  if (head === 'none') return null;
  return (
    <header className={styles.head} data-part="head" data-head={head}>
      {head === 'title' && (
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
      )}
      <IconBtn icon="close" label={closeLabel} size="sm" onClick={onClose} />
    </header>
  );
}

function SheetBody(props: SheetProps) {
  const { title, width = 360, children, onClose, head = 'title' } = props;
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const trap = useOverlayFocus(panel, onClose);
  const { label, hidden } = head === 'title' ? { label: { 'aria-labelledby': titleId }, hidden: null } : named(title, titleId, false);
  return (
    <div
      className={styles.scrim}
      data-stub="Sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        {...label}
        tabIndex={-1}
        className={styles.panel}
        data-width={width}
        onKeyDown={trap}
      >
        <Head {...props} titleId={titleId} />
        {hidden}
        <div className={styles.body}>{children}</div>
      </aside>
    </div>
  );
}

const task = (
  <KV
    items={[
      { key: '状态', value: '进行中' },
      { key: '开始', value: '14:14' },
      { key: '用时', value: '18 分' },
      { key: '工作目录', value: '~/Documents/账单', mono: true },
      { key: '运行 id', value: 'run_7f3a21', mono: true },
    ]}
  />
);

export const SheetDemos: Array<{ name: string; props: SheetProps }> = [
  { name: 'narrow', props: { open: true, title: '汇总 10 月开销表', children: task } },
  { name: 'wide', props: { open: true, title: '汇总 10 月开销表', width: 480, children: task } },
  { name: 'wider', props: { open: true, title: '生成记录', width: 640, children: task } },
  { name: 'close-only', props: { open: true, title: '任务', width: 420, head: 'close', children: task } },
  { name: 'close-label', props: { open: true, title: <>生成记录 <b className="num">12</b></>, closeLabel: '收起生成记录', children: task } },
  { name: 'docked', props: { open: false, title: '详情', width: 420, head: 'none', dockFrom: 0, children: task } },
];
