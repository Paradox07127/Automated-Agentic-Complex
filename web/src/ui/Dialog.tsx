import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from './Btn';
import { IconBtn } from './IconBtn';
import { MODAL_ROOT_ID, useExitFade } from './overlay';
import styles from './Dialog.module.css';

/** 居中对话框：模糊遮罩上一条通栏白带，内容宽 560，居中标题、正文、固定底栏；焦点陷阱，Esc 关闭，关闭后焦点回到触发处。 */
export interface DialogProps {
  /** 是否打开 */
  open: boolean;
  /** 标题 */
  title: string;
  /** 正文，过长时在正文区滚动 */
  children?: ReactNode;
  /** 底栏按钮，次要在前、主操作在后 */
  footer?: ReactNode;
  /** Esc、关闭按钮或点遮罩 */
  onClose?: () => void;
  /** 点遮罩不关闭，只留 Esc 和关闭按钮 */
  keepOnScrim?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

// WebKit does not focus a clicked button, so activeElement at open time can be <body>; remember the pressed control instead.
let lastPressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPressed = e.target instanceof Element ? e.target.closest<HTMLElement>(`${FOCUSABLE}, [role="switch"]`) : null;
    },
    true,
  );
}

// Open overlays, newest last; only the last one answers Esc.
const openStack: object[] = [];

/**
 * Shared by Dialog, Sheet and the pages' own overlays: focuses `initial`'s pick, else the first control outside `[data-part="head"]` and InfoTips, on
 * mount, closes on Esc (only the topmost overlay, unless a child already handled it), returns focus on unmount. The returned handler
 * keeps Tab inside `panel`.
 */
export function useOverlayFocus(panel: RefObject<HTMLElement | null>, onClose: (() => void) | undefined,
  initial?: (panel: HTMLElement) => HTMLElement | null) {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const prev = active ?? lastPressed;
    const el = panel.current;
    const first = (el && initial?.(el))
      ?? Array.from(el?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).find((n) => !n.closest('[data-part="head"], [data-stub="InfoTip"]'));
    (first ?? el)?.focus({ preventScroll: true });
    const self = {};
    openStack.push(self);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || openStack.at(-1) !== self) return;
      e.preventDefault();
      latest.current?.();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openStack.splice(openStack.indexOf(self), 1);
      if (prev?.isConnected) prev.focus();
    };
    // Mount-only: focus once when the overlay opens.
  }, []);

  // React's and the DOM's key events alike: Sheet listens natively.
  return (e: Pick<globalThis.KeyboardEvent, 'key' | 'shiftKey' | 'target' | 'defaultPrevented' | 'preventDefault'>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    // A nested overlay bubbles through this one in the React tree; it has already moved focus.
    if (e.defaultPrevented || !panel.current.contains(e.target as Node)) return;
    const list = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    e.preventDefault();
    if (list.length === 0) return;
    // Move focus ourselves on every Tab: WebKit's default order skips buttons and would leave the overlay.
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at + 1) % list.length;
    list[next]?.focus({ preventScroll: true });
  };
}

/** Portals into the shell's modal mount point; the catalog ([data-modal-inline]) and windows without one render in place. */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  useLayoutEffect(() => {
    const a = anchor.current;
    setHost(a && !a.closest('[data-modal-inline]') ? document.getElementById(MODAL_ROOT_ID) : null);
  }, []);
  if (host === undefined) return <span ref={anchor} hidden />;
  return host ? createPortal(children, host) : <>{children}</>;
}

export function Dialog(props: DialogProps) {
  return props.open ? (
    <OverlayPortal>
      <DialogBody {...props} />
    </OverlayPortal>
  ) : null;
}

function DialogBody({ title, children, footer, onClose, keepOnScrim }: DialogProps) {
  const scrim = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const trap = useOverlayFocus(panel, onClose);
  useExitFade(scrim);
  return (
    <div
      ref={scrim}
      className={styles.scrim}
      data-stub="Dialog"
      onMouseDown={(e) => {
        if (!keepOnScrim && e.target === e.currentTarget) onClose?.();
      }}
    >
      {/* The band is white in both themes, so its content reads light-theme tokens. */}
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-theme="light" className={styles.panel} onKeyDown={trap}>
        <span className={styles.band} data-part="band" aria-hidden="true">
          <span className={styles.tri} />
        </span>
        <header className={styles.head} data-part="head">
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <span className={styles.close}>
            <IconBtn icon="close" label="关闭" size="sm" onClick={onClose} />
          </span>
        </header>
        {children && (
          <div className={styles.body} data-part="body">
            {children}
          </div>
        )}
        {footer && (
          <footer className={styles.foot} data-part="foot">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

const field = (label: string, value: string) => (
  <label className={styles.demoField}>
    <span>{label}</span>
    <input defaultValue={value} />
  </label>
);

export const DialogDemos: Array<{ name: string; props: DialogProps }> = [
  {
    name: 'create',
    props: {
      open: true,
      title: '派发任务',
      children: (
        <>
          {field('任务', '汇总 10 月开销表')}
          {field('工作目录', '~/Documents/账单')}
        </>
      ),
      footer: (
        <>
          <Btn variant="secondary">取消</Btn>
          <Btn variant="primary">派发</Btn>
        </>
      ),
    },
  },
  {
    name: 'confirm',
    props: {
      open: true,
      title: '停止「汇总 10 月开销表」？',
      children: <p>已写出的产物保留，停止后不能继续执行。</p>,
      footer: (
        <>
          <Btn variant="secondary">不停止</Btn>
          <Btn variant="danger">停止任务</Btn>
        </>
      ),
    },
  },
  {
    name: 'long',
    props: {
      open: true,
      title: '本轮读取的文件',
      children: (
        <ol>
          {Array.from({ length: 24 }, (_, i) => (
            <li key={i}>~/Documents/账单/2026-10/收据-{String(i + 1).padStart(2, '0')}.pdf</li>
          ))}
        </ol>
      ),
      footer: <Btn variant="primary">完成</Btn>,
    },
  },
];
