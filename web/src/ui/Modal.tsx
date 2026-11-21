import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { gameClips, type GameClip } from '../design/gameClips.generated';
import { Btn } from './Btn';
import { Frosted, useGameClip } from './fx';
import styles from './Modal.module.css';
import { runsEnd, startClip } from './ToggleClip';

/** 确认弹窗：半透明模糊遮罩上一条通栏白带，内容宽 560 居中，底部取消（深）+ 确认两颗按钮；焦点陷阱；危险时确认用 danger，初始焦点在取消。新页面改用 Dialog。 */
export interface ModalProps {
  /** 是否打开 */
  open: boolean;
  /** 问句 */
  title: string;
  /** 注释 */
  note?: ReactNode;
  /** 表单等正文，排在注释下面 */
  children?: ReactNode;
  /** 红色警告条 */
  warning?: string;
  /** 危险确认 */
  danger?: boolean;
  /** 确认按钮文字 */
  confirmLabel: string;
  /** 取消按钮文字，默认「取消」 */
  cancelLabel?: string;
  /** 需要输入的确认词（不可恢复操作） */
  confirmWord?: string;
  /** 确认 */
  onConfirm?: () => void;
  /** 取消 / esc */
  onCancel?: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// WebKit does not focus a clicked button, so activeElement at open time can be <body>; remember the pressed control instead.
let lastPressed: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPressed = e.target instanceof Element ? e.target.closest<HTMLElement>(`${FOCUSABLE}, a[href], [role="switch"]`) : null;
    },
    true,
  );
}

/** Element the main-window shell provides so a dialog covers the whole window, sidebar included. */
export const MODAL_ROOT_ID = 'ef-modal-root';

/**
 * Keeps a copy of the closed overlay on screen while its exit plays: the `out` clip when given, else its `[data-closing]`
 * CSS animation. The copy is inert and hidden from assistive tech; with no exit (reduced motion, still shots) it is dropped at once.
 */
export function useExitFade(ref: RefObject<HTMLElement | null>, out?: GameClip) {
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentNode;
    return () => {
      // A StrictMode re-run keeps the node attached; only a real unmount detaches it before the microtask.
      queueMicrotask(() => {
        if (!el || !host?.isConnected || el.isConnected) return;
        const ghost = el.cloneNode(true) as HTMLElement;
        ghost.setAttribute('data-closing', '');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        for (const n of ghost.querySelectorAll('[id]')) n.removeAttribute('id');
        host.appendChild(ghost);
        if (out) {
          void runsEnd(startClip(out, ghost)).then(() => ghost.remove());
          return;
        }
        const name = getComputedStyle(ghost).animationName;
        if (!name || name === 'none') ghost.remove();
        else ghost.addEventListener('animationend', (e) => e.target === ghost && ghost.remove());
      });
    };
    // Mount-only: the node is the overlay root for its whole life.
  }, []);
}

export function Modal(props: ModalProps) {
  return props.open ? <ModalMount {...props} /> : null;
}

// Portals into the shell's mount point; the catalog ([data-modal-inline]) and windows without one render in place.
function ModalMount(props: ModalProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  useLayoutEffect(() => {
    const a = anchor.current;
    setHost(a && !a.closest('[data-modal-inline]') ? document.getElementById(MODAL_ROOT_ID) : null);
  }, []);
  if (host === undefined) return <span ref={anchor} hidden />;
  return host ? createPortal(<ModalBody {...props} />, host) : <ModalBody {...props} />;
}

function ModalBody({ title, note, children, warning, danger, confirmLabel, cancelLabel = '取消', confirmWord, onConfirm, onCancel }: ModalProps) {
  const [word, setWord] = useState('');
  const scrim = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const wordId = useId();
  useExitFade(scrim, gameClips.popupOut);
  useGameClip(gameClips.popupIn, scrim, { autoplay: true });
  const ok = !confirmWord || word.trim() === confirmWord;
  const latest = useRef(onCancel);
  latest.current = onCancel;

  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const prev = active ?? lastPressed;
    const el = panel.current;
    // Dangerous or irreversible: start on the safe choice / the confirm word; otherwise on confirm.
    const first = confirmWord ? el?.querySelector<HTMLElement>('input') : el?.querySelector<HTMLElement>(danger ? '[data-role="cancel"] button' : '[data-role="confirm"] button');
    first?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        latest.current?.();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev?.isConnected) prev.focus();
    };
    // Mount-only: focus once when the dialog opens.
  }, []);

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const list = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (list.length === 0) return;
    // Move focus ourselves on every Tab: WebKit's default order skips buttons and would leave the dialog.
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at + 1) % list.length;
    list[next]?.focus({ preventScroll: true });
  };

  const confirmVariant = danger ? 'danger' : 'primary';

  return (
    <div
      ref={scrim}
      className={`${styles.scrim} ${styles.clip}`}
      data-stub="Modal"
      data-g="popup"
      data-danger={danger || undefined}
      data-confirm-word={confirmWord}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
    >
      <span className={styles.blur} data-g="blur" aria-hidden="true">
        <Frosted blur={16} tint={0} />
      </span>
      <span className={styles.shade} data-g="scrim" aria-hidden="true" />
      {/* The band is white in both themes, so its content reads light-theme tokens. */}
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} data-theme="light" className={styles.panel} onKeyDown={trap}>
        <span className={styles.band} data-part="band" data-g="band" aria-hidden="true">
          <span className={styles.shadow} data-g="shadow" />
          <span className={styles.tri} data-g="decoL" />
        </span>
        <div className={styles.inner}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          {note && <div className={styles.note}>{note}</div>}
          {children && (
            <div className={styles.body} data-g="body">
              {children}
            </div>
          )}
          {warning && (
            <p role="alert" className={styles.warning} data-g="warning">
              {warning}
            </p>
          )}
          {confirmWord && (
            <label className={styles.field} htmlFor={wordId} data-g="body">
              <span>
                输入「{confirmWord}」确认
              </span>
              <input
                id={wordId}
                className={styles.input}
                value={word}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setWord(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ok) onConfirm?.();
                }}
              />
            </label>
          )}
        </div>
        <div className={styles.foot} data-g="btns">
          <span data-role="cancel">
            <Btn variant="cancel" kbd="esc" onClick={onCancel}>
              {cancelLabel}
            </Btn>
          </span>
          <span data-role="confirm">
            <Btn variant={confirmVariant} disabled={!ok} disabledReason={confirmWord ? `先输入「${confirmWord}」` : undefined} onClick={onConfirm}>
              {confirmLabel}
            </Btn>
          </span>
        </div>
      </div>
    </div>
  );
}

export const ModalDemos: Array<{ name: string; props: ModalProps }> = [
  { name: 'stop', props: { open: true, title: '停止「汇总 10 月开销表」？', note: '已写出的产物保留，不能恢复执行。', confirmLabel: '停止任务', cancelLabel: '不停止' } },
  { name: 'danger', props: { open: true, danger: true, title: '关闭「窗口文字」并删除已收集的 214 条？', note: '停止采集在重启后台后生效；删除立即生效。', warning: '删除后不能恢复', confirmLabel: '关闭并删除' } },
  { name: 'confirm-word', props: { open: true, danger: true, title: '清空全部记忆？', warning: '1,284 条记忆会被永久删除', confirmWord: '清空', confirmLabel: '清空记忆' } },
];
