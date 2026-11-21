import { stateVisual, type VisualStateKey } from '../domain';
import styles from './StatusTag.module.css';

/** 状态标签：框型（实线框、墨块、黄块）+ 文字，统一从 domain 的 stateVisual 取。 */
export interface StatusTagProps {
  /** 状态值 */
  state: VisualStateKey;
  /** 覆盖默认文字，例如「◆ 等你批准 · 2 张」 */
  label?: string;
  /** 只显示形状，文字仅供读屏 */
  iconOnly?: boolean;
}

export function StatusTag({ state, label, iconOnly }: StatusTagProps) {
  const v = stateVisual(state);
  const text = label ?? v.label;
  // A leading glyph in a custom label would duplicate the shape channel.
  const shown = text.replace(/^[◆▲■✓□●▶]\s*/u, '');
  return (
    <span
      className={styles.tag}
      data-stub="StatusTag"
      data-tone={v.tone}
      data-shape={v.shape}
      data-token={v.token}
      data-icon-only={iconOnly || undefined}
      role={iconOnly ? 'img' : undefined}
      aria-label={iconOnly ? text : undefined}
      title={iconOnly ? text : undefined}
    >
      {!iconOnly && <span className={styles.text}>{shown}</span>}
    </span>
  );
}

export const StatusTagDemos: Array<{ name: string; props: StatusTagProps }> = [
  { name: 'running', props: { state: 'running_tool' } },
  { name: 'waiting', props: { state: 'awaiting_approval' } },
  { name: 'waiting-count', props: { state: 'awaiting_approval', label: '◆ 待批准 │ 2 张' } },
  { name: 'review', props: { state: 'needs_review' } },
  { name: 'warning', props: { state: 'warning', label: '超出帧预算' } },
  { name: 'failed', props: { state: 'failed' } },
  { name: 'interrupted', props: { state: 'interrupted' } },
  { name: 'done', props: { state: 'succeeded' } },
  { name: 'queued', props: { state: 'queued' } },
  { name: 'icon-only', props: { state: 'running', iconOnly: true } },
];
