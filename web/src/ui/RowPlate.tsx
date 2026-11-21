import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './RowPlate.module.css';

/** 列表行（设置行）：灰色底板加左侧斜纹，选中显示左侧 trace 条；左边图标位，中间标题和说明，右边固定宽的操作列。 */
export interface RowPlateProps {
  /** 标题 */
  title: string;
  /** 说明 */
  meta?: ReactNode;
  /** 左边图标位 */
  icon?: IconName;
  /** 右边操作 */
  actions?: ReactNode;
  /** 选中 */
  selected?: boolean;
  /** 点击行 */
  onClick?: () => void;
}

export function RowPlate({ title, meta, icon, actions, selected, onClick }: RowPlateProps) {
  return (
    <div className={styles.row} data-stub="RowPlate" data-selected={selected || undefined}>
      <button type="button" className={styles.main} aria-pressed={!!selected} onClick={onClick}>
        {icon && (
          <span className={styles.ic} aria-hidden="true">
            <Icon name={icon} size={16} />
          </span>
        )}
        <span className={styles.body}>
          <span className={styles.title}>{title}</span>
          {meta && <span className={styles.meta}>{meta}</span>}
        </span>
      </button>
      {actions && <span className={styles.actions}>{actions}</span>}
    </div>
  );
}

export const RowPlateDemos: Array<{ name: string; props: RowPlateProps }> = [
  { name: 'default', props: { icon: 'file', title: '整理本周提交周报', meta: '待复核 │ 角色任务' } },
  { name: 'selected', props: { icon: 'tool', title: '修 HostLink 断线', meta: '进行中 │ Claude Code', selected: true } },
  { name: 'plain', props: { title: '周报按项目分组', meta: '推断 │ 待确认' } },
];
