import { useEffect, useId, useState, type AriaAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import styles from './Btn.module.css';
import hintStyles from './BtnHint.module.css';
import pressStyles from './BtnPressed.module.css';

/**
 * 按钮（.ef-btn）：胶囊。primary 黄、ghost 浅、secondary 深灰、
 * danger 红、ring 功能药丸、text 无胶囊。primary 每个视图只放 1 个；危险批准只能用鼠标点。
 */
export interface BtnProps {
  /**
   * 变体，默认 ghost（浅色胶囊，无图标位）。
   * 旧名照旧可传：cancel、action-row 按 secondary，quiet 按 text，danger-confirm 按 danger。
   * link：行内文字链，正文色、黄下划线，没有胶囊。
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'text' | 'ring' | 'link' | 'cancel' | 'danger-confirm' | 'quiet' | 'action-row';
  /** 高 36 / 32 / 24，默认 md */
  size?: 'lg' | 'md' | 'sm';
  /** 图标：带图标位的变体放进右端圆位（没给 tail 时），其余放在文字前 */
  icon?: IconName;
  /** 右端圆形图标位的图标；不给时 primary 用勾、secondary 用箭头；sm 只有给了 tail 才带图标位 */
  tail?: IconName;
  /** 打开别的页面或系统：文字后一个 » */
  go?: boolean;
  /** 读屏名称；文字只是符号时给 */
  label?: string;
  /** 键帽文字，例如 esc、⏎ */
  kbd?: string;
  /** 加载中：图标位（或前置位）换加载环 */
  loading?: boolean;
  /** 切换类按钮的按下态：写 aria-pressed，向右下沉 1 px、没有阴影 */
  pressed?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因，作为 tooltip（禁用时必给） */
  disabledReason?: string;
  /** 只能用鼠标点（危险批准）：不响应 ⏎ 和空格 */
  mouseOnly?: boolean;
  /** 点击 */
  onClick?: () => void;
  /** 按钮文字 */
  children: ReactNode;
  /** 打开菜单或弹层的按钮（Menu 的触发键）：写到 button 上 */
  'aria-haspopup'?: AriaAttributes['aria-haspopup'];
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  /** 指向 button */
  ref?: Ref<HTMLButtonElement>;
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text' | 'ring' | 'link';

const VARIANT: Record<NonNullable<BtnProps['variant']>, Variant> = {
  primary: 'primary',
  secondary: 'secondary',
  ghost: 'ghost',
  danger: 'danger',
  text: 'text',
  ring: 'ring',
  link: 'link',
  cancel: 'secondary',
  'action-row': 'secondary',
  quiet: 'text',
  'danger-confirm': 'danger',
};
const TAIL: Partial<Record<Variant, IconName>> = { primary: 'check', secondary: 'chev', danger: 'del', ring: 'chev' };
export const MOUSE_ONLY_HINT = '只能用鼠标点击';

export function Btn({ variant = 'ghost', size = 'md', icon, tail, go, label, kbd, loading, pressed, disabled, disabledReason, mouseOnly, onClick, children, ref, ...aria }: BtnProps) {
  const [hint, setHint] = useState(false);
  const reasonId = useId();
  const v = VARIANT[variant];
  const inactive = !!disabled || !!loading;
  const slot = TAIL[v] && (size !== 'sm' || !!tail) ? (tail ?? icon ?? TAIL[v]) : undefined;

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 2400);
    return () => clearTimeout(t);
  }, [hint]);

  const blockKeys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!mouseOnly || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (e.type === 'keydown') setHint(true);
  };

  // Without a tail the icon already sits in the round slot.
  const lead = icon && !(slot && !tail) ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null;

  const button = (
    <button
      ref={ref}
      type="button"
      className={`${styles.btn} ${styles[v]} ${styles[size]} ${pressStyles.press}`}
      data-stub="Btn"
      data-variant={v}
      data-size={size}
      data-icon={icon}
      data-tail={slot}
      data-loading={loading || undefined}
      data-mouse-only={mouseOnly || undefined}
      aria-label={label}
      {...aria}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-busy={loading || undefined}
      aria-describedby={disabled && disabledReason ? reasonId : undefined}
      title={disabled ? disabledReason : mouseOnly ? MOUSE_ONLY_HINT : undefined}
      onClick={() => {
        if (!inactive) onClick?.();
      }}
      onKeyDown={blockKeys}
      onKeyUp={blockKeys}
    >
      {lead}
      {size === 'lg' && <span className={styles.dash} aria-hidden="true" />}
      <span className={styles.label}>{children}</span>
      {go && (
        <span className={styles.go} aria-hidden="true">
          »
        </span>
      )}
      <span className={styles.contour} aria-hidden="true" />
      {kbd && (
        <span className={styles.kbd} aria-hidden="true">
          <Kbd>{kbd}</Kbd>
        </span>
      )}
      {slot && (
        <span className={styles.sfx} aria-hidden="true">
          <Icon name={slot} size={size === 'md' ? 12 : 14} />
        </span>
      )}
    </button>
  );

  // The reason lives outside the button so it describes, not names, it.
  const reason = disabled && disabledReason && (
    <span id={reasonId} hidden>
      {disabledReason}
    </span>
  );

  if (!mouseOnly)
    return reason ? (
      <>
        {button}
        {reason}
      </>
    ) : (
      button
    );
  return (
    <span className={hintStyles.wrap}>
      {button}
      {reason}
      {hint && (
        <span role="status" className={hintStyles.hint}>
          {MOUSE_ONLY_HINT}
        </span>
      )}
    </span>
  );
}

export const BtnDemos: Array<{ name: string; props: BtnProps }> = [
  { name: 'primary', props: { variant: 'primary', children: '派发任务' } },
  { name: 'primary-kbd', props: { variant: 'primary', size: 'lg', children: '批准', kbd: '⏎' } },
  { name: 'secondary', props: { variant: 'secondary', children: '查看诊断' } },
  { name: 'secondary-kbd', props: { variant: 'secondary', children: '拒绝', kbd: 'esc' } },
  { name: 'ghost', props: { variant: 'ghost', icon: 'plus', children: '新建' } },
  { name: 'danger', props: { variant: 'danger', children: '批准（只能点击）', mouseOnly: true } },
  { name: 'text', props: { variant: 'text', children: '前往设置' } },
  { name: 'ring', props: { variant: 'ring', children: '稍后处理' } },
  { name: 'go', props: { go: true, children: '打开配置文件' } },
  { name: 'pressed', props: { variant: 'secondary', size: 'sm', pressed: true, children: '只看出错' } },
  { name: 'link', props: { variant: 'link', children: '恢复默认排除' } },
  { name: 'small', props: { variant: 'primary', size: 'sm', children: '确认' } },
  { name: 'small-tail', props: { variant: 'primary', size: 'sm', tail: 'look', children: '屏幕识读' } },
  { name: 'small-secondary', props: { variant: 'secondary', size: 'sm', icon: 'refresh', children: '重试' } },
  { name: 'disabled', props: { variant: 'secondary', children: '核验并完成', disabled: true, disabledReason: '还有 1 个任务没完成' } },
  { name: 'disabled-primary', props: { variant: 'primary', children: '保存', disabled: true, disabledReason: '没有改动' } },
  { name: 'loading', props: { variant: 'ghost', icon: 'refresh', children: '重新检测', loading: true } },
  { name: 'loading-primary', props: { variant: 'primary', children: '正在保存', loading: true } },
];
