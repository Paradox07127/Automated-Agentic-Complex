import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import styles from './InfoTip.module.css';

/** ⓘ 说明：悬停或聚焦时显示，Esc 关闭；承接从页面上移走的说明句。说明框是深色提示面板。 */
export interface InfoTipProps {
  /** 说明文字，1–2 句 */
  children: string;
  /** ⓘ 的读屏名称，默认「说明」 */
  label?: string;
  /** 初始就显示（截图用） */
  defaultOpen?: boolean;
}

const TIP_MAX = 275;

export function InfoTip({ children, label = '说明', defaultOpen = false }: InfoTipProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [place, setPlace] = useState<CSSProperties>();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  // Fixed to the viewport so a scrolling or clipped ancestor cannot cut the tip off; flips above the ⓘ when there is no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const h = tip.current?.getBoundingClientRect().height ?? 0;
      const below = r.bottom + 4;
      setPlace({ top: below + h > window.innerHeight - 8 ? r.top - 4 - h : below, left: Math.max(8, Math.min(r.left, window.innerWidth - TIP_MAX - 8)) });
    };
    place();
    // Capture so the hover-opened tip closes on Esc wherever focus is, before a surrounding Dialog or Sheet sees the key.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const tipEl = (
    <span ref={tip} id={tipId} role="tooltip" data-theme="dark" className={styles.tip} style={place} hidden={!open}>
      {children}
    </span>
  );
  return (
    <span className={styles.wrap} data-stub="InfoTip" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={btn}
        type="button"
        className={styles.btn}
        aria-label={label}
        aria-describedby={tipId}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <Icon name="info" size={14} />
      </button>
      {/* The tips panel is dark in both themes, so its text reads dark-theme tokens. Open, it goes to <body>: a row's own stacking
          context would otherwise paint the rows after it over the tip. */}
      {open ? createPortal(tipEl, document.body) : tipEl}
    </span>
  );
}

export const InfoTipDemos: Array<{ name: string; props: InfoTipProps }> = [
  { name: 'closed', props: { children: '只统计后台记下的轮次，手动停止的轮次不计入。' } },
  { name: 'open', props: { defaultOpen: true, children: '只统计后台记下的轮次，手动停止的轮次不计入。' } },
];
