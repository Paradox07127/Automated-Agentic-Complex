import { useId, useRef, type ReactNode } from 'react';
import { KV } from './KV';
import { IconBtn } from './IconBtn';
import { OverlayPortal, useOverlayFocus } from './Dialog';
import styles from './Sheet.module.css';

/** 右侧抽屉：补充信息，宽 360 或 480；焦点陷阱，Esc 关闭，关闭后焦点回到触发处。 */
export interface SheetProps {
  /** 是否打开 */
  open: boolean;
  /** 标题 */
  title: string;
  /** 宽度，默认 360 */
  width?: 360 | 480;
  /** 内容，过长时在抽屉内滚动 */
  children?: ReactNode;
  /** Esc、关闭按钮或点遮罩 */
  onClose?: () => void;
}

export function Sheet(props: SheetProps) {
  return props.open ? (
    <OverlayPortal>
      <SheetBody {...props} />
    </OverlayPortal>
  ) : null;
}

function SheetBody({ title, width = 360, children, onClose }: SheetProps) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const trap = useOverlayFocus(panel, onClose);
  return (
    <div
      className={styles.scrim}
      data-stub="Sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <aside ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={styles.panel} data-width={width} onKeyDown={trap}>
        <header className={styles.head} data-part="head">
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconBtn icon="close" label="关闭" size="sm" onClick={onClose} />
        </header>
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
];
