import type { ReactNode } from 'react';
import { EffectTag } from './EffectTag';
import { InfoTip } from './InfoTip';
import { Select } from './Select';
import { Switch } from './Switch';
import styles from './SRow.module.css';

/** 设置行（设置页、首次设置、角色 › 设定共用）：底板随主题；标题、ⓘ、标记，一行说明，右列控件；能被设置搜索按 id 定位。其余 `data-*` 原样放到行上。 */
export interface SRowProps {
  /** 设置 id，作为锚点和搜索目标 */
  id: string;
  /** 标题 */
  title: string;
  /** 说明，只显示 1 行，超出省略 */
  desc?: ReactNode;
  /** 说明的语义色 */
  descTone?: 'attention' | 'bad' | 'ok' | undefined;
  /** 说明收进标题旁的 ⓘ，不占一行 */
  tip?: string | undefined;
  /** 标题后的标记（删数据、待重启、DEV） */
  marks?: ReactNode;
  /** 右列控件 */
  control: ReactNode;
  /** 生效方式，非 now 时显示生效标签 */
  effect?: 'now' | 'backend' | 'character';
  /** 已保存、未生效（⟳ 待应用） */
  pending?: boolean;
  /** 值和默认不同：左侧一道缺电橙竖线 */
  modified?: boolean | undefined;
  /** 上一行的子行，缩进 */
  indent?: boolean | undefined;
  /** 标题和控件顶端对齐，给说明里放列表的行 */
  tall?: boolean | undefined;
  /** 控件可折成第二行 */
  wrap?: boolean | undefined;
  /** 禁用 */
  disabled?: boolean | undefined;
  /** 禁用原因，悬停整行时显示 */
  disabledReason?: string | undefined;
  className?: string | undefined;
  /** 行下方的附加内容（依赖链、列表） */
  children?: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}

export function SRow({ id, title, desc, descTone, tip, marks, control, effect = 'now', pending, modified, indent, tall, wrap, disabled, disabledReason, className, children, ...data }: SRowProps) {
  const descId = `set-${id}-desc`;
  const modId = `set-${id}-mod`;
  const described = [desc != null ? descId : '', modified ? modId : ''].filter(Boolean).join(' ');
  return (
    <div
      id={`set-${id}`}
      role="group"
      aria-labelledby={`set-${id}-title`}
      aria-describedby={described || undefined}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledReason : undefined}
      className={className ? `${styles.row} ${className}` : styles.row}
      data-stub="SRow"
      data-effect={effect === 'now' ? undefined : effect}
      data-pending={pending || undefined}
      {...data}
      data-sub={indent || undefined}
      data-tall={tall || undefined}
      data-modified={modified || undefined}
    >
      <div className={styles.lab}>
        <div className={styles.tt}>
          <span id={`set-${id}-title`}>{title}</span>
          {tip && <InfoTip>{tip}</InfoTip>}
          {effect !== 'now' && <EffectTag target={effect} pending={pending} />}
          {marks}
          {modified && <ModLine id={modId} />}
        </div>
        {desc != null && (
          <div id={descId} className={styles.d} data-tone={descTone}>
            {desc}
          </div>
        )}
      </div>
      <div className={styles.ctl} data-wrap={wrap || undefined} inert={disabled || undefined}>
        {control}
      </div>
      {children != null && <div className={styles.extra}>{children}</div>}
    </div>
  );
}

/** 和默认不同：行左缘一道 2 px 缺电橙竖线，读屏读「和默认不同」（`id` 给行的 aria-describedby）。放在 position: relative 的行里。 */
export function ModLine({ id }: { id: string }) {
  return (
    <>
      <i className={styles.mod} data-mod-line="" aria-hidden="true" />
      <span id={id} className={styles.vh}>
        和默认不同
      </span>
    </>
  );
}

export const SRowDemos: Array<{ name: string; props: SRowProps }> = [
  { name: 'toggle', props: { id: 'observe', title: '观察电脑上的活动', desc: '总开关。关掉后「看到的」不再更新', control: <Switch variant="setting" checked label="观察电脑上的活动" /> } },
  { name: 'backend', props: { id: 'wintext', title: '窗口文字', desc: '关闭会删除已收集内容', effect: 'backend', pending: true, control: <Switch variant="setting" checked={false} label="窗口文字" /> } },
  {
    name: 'character',
    props: {
      id: 'proactive',
      title: '主动程度',
      tip: '多久主动开口一次',
      effect: 'character',
      control: <Select label="主动程度" value="适中" defaultValue="适中" options={[{ value: '安静', label: '安静' }, { value: '适中', label: '适中' }, { value: '活跃', label: '活跃', risky: true }]} />,
    },
  },
  {
    name: 'modified',
    props: { id: 'proactive-mod', title: '主动程度', desc: '默认：适中', modified: true, control: <Select label="主动程度" value="活跃" defaultValue="适中" options={[{ value: '安静', label: '安静' }, { value: '适中', label: '适中' }, { value: '活跃', label: '活跃', risky: true }]} /> },
  },
  { name: 'disabled', props: { id: 'shot', title: '附上截图', desc: '提问时带上当前窗口的截图', disabled: true, disabledReason: '屏幕录制未允许', control: <Switch variant="setting" checked={false} label="附上截图" /> } },
  { name: 'sub', props: { id: 'shot-sub', title: '只截前台窗口', indent: true, descTone: 'attention', desc: '要先打开「附上截图」', control: <Switch variant="setting" checked label="只截前台窗口" /> } },
  { name: 'extra', props: { id: 'scope', title: '资料范围', desc: '角色能读的文件夹', tall: true, control: '2 个文件夹', children: '~/Documents/周报 │ ~/Endfield/app' } },
];
