import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './IconBtn.module.css';
import tipStyles from './InfoTip.module.css';

/** 图标按钮（深色药丸；close 为圆形点按区）：必须有 aria-label 和 tooltip。 */
export interface IconBtnProps {
  /** 图标 */
  icon: IconName;
  /** aria-label 与 tooltip */
  label: string;
  /** 50×32 / 44×28（close 为 32 / 28 圆），默认 md */
  size?: 'md' | 'sm';
  /** round：24 px 圆形徽标，不看 size */
  shape?: 'pill' | 'round';
  /** 切换类按钮的按下态 */
  pressed?: boolean;
  /** 打开菜单或面板的按钮：展开时写 aria-expanded，样子同 Btn 的按下态 */
  expanded?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因：给了就保持可聚焦，悬停和聚焦时用 ⓘ 同款浮层说明 */
  disabledReason?: string;
  /** 点击 */
  onClick?: () => void;
}

const TIP_MAX = 275;

export function IconBtn({ icon, label, size = 'md', shape, pressed, expanded, disabled, disabledReason, onClick }: IconBtnProps) {
  const [tip, setTip] = useState(false);
  const [place, setPlace] = useState<CSSProperties>();
  const btn = useRef<HTMLButtonElement>(null);
  const tipEl = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const why = disabled && disabledReason ? disabledReason : undefined;
  const shown = tip && why != null;
  // Placed like InfoTip's tip: fixed to the viewport, flipped above when there is no room below.
  useLayoutEffect(() => {
    if (!shown) return;
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = tipEl.current?.getBoundingClientRect().height ?? 0;
    const below = r.bottom + 4;
    setPlace({ top: below + h > window.innerHeight - 8 ? r.top - 4 - h : below, left: Math.max(8, Math.min(r.left, window.innerWidth - TIP_MAX - 8)) });
  }, [shown]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={styles.btn}
        data-stub="IconBtn"
        data-icon={icon}
        data-size={size}
        data-shape={shape}
        aria-label={label}
        title={why ? undefined : label}
        aria-pressed={pressed}
        aria-expanded={expanded}
        aria-disabled={why ? true : undefined}
        aria-describedby={why ? tipId : undefined}
        disabled={disabled && !why}
        onClick={why ? undefined : onClick}
        onMouseEnter={why ? () => setTip(true) : undefined}
        onMouseLeave={why ? () => setTip(false) : undefined}
        onFocus={why ? () => setTip(true) : undefined}
        onBlur={why ? () => setTip(false) : undefined}
        onKeyDown={why ? (e) => e.key === 'Escape' && setTip(false) : undefined}
      >
        <Icon name={icon} size={size === 'sm' || shape === 'round' ? 14 : 16} />
      </button>
      {why && (
        <span ref={tipEl} id={tipId} role="tooltip" data-theme="dark" className={tipStyles.tip} style={place} hidden={!shown}>
          {why}
        </span>
      )}
    </>
  );
}

export const IconBtnDemos: Array<{ name: string; props: IconBtnProps }> = [
  { name: 'close', props: { icon: 'close', label: '关闭' } },
  { name: 'more', props: { icon: 'more', label: '更多操作', size: 'sm' } },
  { name: 'pressed', props: { icon: 'pin', label: '固定', pressed: true, size: 'sm' } },
  { name: 'expanded', props: { icon: 'more', label: '更多操作', expanded: true } },
  { name: 'round', props: { icon: 'plus', label: '新建', shape: 'round' } },
  { name: 'disabled', props: { icon: 'refresh', label: '重新检测', disabled: true } },
  { name: 'disabled-reason', props: { icon: 'refresh', label: '重新检测', disabled: true, disabledReason: '后台没有运行' } },
];
