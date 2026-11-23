import type { ReactNode } from 'react';
import { EffectTag } from './EffectTag';
import { InfoTip } from './InfoTip';
import { Select } from './Select';
import { Toggle } from './Toggle';
import styles from './SRow.module.css';

/** 设置行：标题 + 一行说明 + 右列控件 + 生效标签，行间一条分隔线；能被设置搜索按 id 定位。 */
export interface SRowProps {
  /** 设置 id，作为锚点和搜索目标 */
  id: string;
  /** 标题 */
  title: string;
  /** 说明，只显示 1 行，超出省略 */
  desc?: ReactNode;
  /** 说明收进标题旁的 ⓘ，不占一行 */
  tip?: string | undefined;
  /** 右列控件 */
  control: ReactNode;
  /** 生效方式，非 now 时显示生效标签 */
  effect?: 'now' | 'backend' | 'character';
  /** 已保存、未生效（⟳ 待应用） */
  pending?: boolean;
  /** 值和默认不同：左侧一道缺电橙竖线 */
  modified?: boolean;
  /** 禁用 */
  disabled?: boolean;
  /** 禁用原因 */
  disabledReason?: string;
  /** 行下方的附加内容（依赖链、计数） */
  children?: ReactNode;
}

export function SRow({ id, title, desc, tip, control, effect = 'now', pending, modified, disabled, disabledReason, children }: SRowProps) {
  const descId = `set-${id}-desc`;
  const modId = `set-${id}-mod`;
  const described = [desc || (disabled && disabledReason) ? descId : '', modified ? modId : ''].filter(Boolean).join(' ');
  return (
    <div
      id={`set-${id}`}
      role="group"
      aria-labelledby={`set-${id}-title`}
      aria-describedby={described || undefined}
      className={styles.row}
      data-stub="SRow"
      data-effect={effect}
      data-pending={pending || undefined}
      data-modified={modified || undefined}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
    >
      <div className={styles.text}>
        <div className={styles.title}>
          <span id={`set-${id}-title`}>{title}</span>
          {tip && <InfoTip>{tip}</InfoTip>}
          {effect !== 'now' && <EffectTag target={effect} pending={pending} />}
          {modified && (
            <span id={modId} className={styles.vh}>
              和默认不同
            </span>
          )}
        </div>
        {(desc || (disabled && disabledReason)) && (
          <div id={descId} className={styles.desc} title={typeof desc === 'string' ? desc : undefined}>
            {desc}
            {disabled && disabledReason && <span className={styles.reason}>{desc ? ' │ ' : ''}不可用：{disabledReason}</span>}
          </div>
        )}
      </div>
      <div className={styles.control} inert={disabled || undefined}>
        {control}
      </div>
      {children && <div className={styles.extra}>{children}</div>}
    </div>
  );
}

export const SRowDemos: Array<{ name: string; props: SRowProps }> = [
  { name: 'toggle', props: { id: 'observe', title: '观察电脑上的活动', desc: '总开关。关掉后「她看到的」不再更新', control: <Toggle on label="观察电脑上的活动" /> } },
  { name: 'backend', props: { id: 'wintext', title: '窗口文字', desc: '关闭会删除已收集内容', effect: 'backend', pending: true, control: <Toggle on={false} label="窗口文字" /> } },
  {
    name: 'character',
    props: {
      id: 'proactive',
      title: '主动程度',
      desc: '她多久主动开口一次',
      effect: 'character',
      control: <Select label="主动程度" value="适中" defaultValue="适中" options={[{ value: '安静', label: '安静' }, { value: '适中', label: '适中' }, { value: '活跃', label: '活跃', risky: true }]} />,
    },
  },
  {
    name: 'modified',
    props: { id: 'proactive-mod', title: '主动程度', desc: '她多久主动开口一次', modified: true, control: <Select label="主动程度" value="活跃" defaultValue="适中" options={[{ value: '安静', label: '安静' }, { value: '适中', label: '适中' }, { value: '活跃', label: '活跃', risky: true }]} /> },
  },
  { name: 'disabled', props: { id: 'shot', title: '附上截图', desc: '提问时带上当前窗口的截图', disabled: true, disabledReason: '屏幕录制未允许', control: <Toggle on={false} label="附上截图" /> } },
  { name: 'extra', props: { id: 'scope', title: '资料范围', desc: '她能读的文件夹', control: '2 个文件夹', children: '~/Documents/周报 │ ~/Endfield/app' } },
];
