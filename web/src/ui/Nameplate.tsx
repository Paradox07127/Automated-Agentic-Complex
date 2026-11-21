import type { ReactNode } from 'react';
import type { VisualStateKey } from '../domain';
import { Icon } from './Icon';
import { StatusTag } from './StatusTag';
import styles from './Nameplate.module.css';

/** 名牌：深色板、右下切角，头像 + 名字 + 状态行；收起态只留头像和状态灯。 */
export interface NameplateProps {
  /** 角色名 */
  name: string;
  /** 英文名 */
  en?: string;
  /** 状态灯 */
  state?: VisualStateKey;
  /** 状态行文字，例如「空闲 · 坐着」 */
  status?: string;
  /** 收起态 */
  collapsed?: boolean;
  /** 头像 */
  avatar?: ReactNode;
}

export function Nameplate({ name, en, state, status, collapsed, avatar }: NameplateProps) {
  return (
    // The plate is dark in both themes, so it reads dark-theme tokens.
    <div data-theme="dark" className={styles.plate} data-stub="Nameplate" data-state={state} data-collapsed={collapsed || undefined} aria-label={collapsed ? `${name}${status ? ` │ ${status}` : ''}` : undefined} role={collapsed ? 'img' : undefined}>
      <span className={styles.avatar} aria-hidden="true">
        {avatar ?? <Icon name="user" size={24} />}
        {collapsed && state && (
          <span className={styles.light}>
            <StatusTag state={state} iconOnly />
          </span>
        )}
      </span>
      {!collapsed && (
        <span className={styles.text}>
          <span className={styles.nameRow}>
            <strong className={styles.name}>{name}</strong>
            {en && (
              <span className={styles.en} lang="en">
                {en}
              </span>
            )}
          </span>
          {(status || state) && (
            <span className={styles.status}>
              {state && <StatusTag state={state} iconOnly />}
              {status && <span className={styles.statusText}>{status}</span>}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

export const NameplateDemos: Array<{ name: string; props: NameplateProps }> = [
  { name: 'default', props: { name: '示例乙', en: 'SI', state: 'running_tool', status: '正在执行 │ 整理本周提交周报' } },
  { name: 'waiting', props: { name: '示例甲', en: 'VoiceA', state: 'awaiting_approval', status: '待批准 │ 2 张' } },
  { name: 'idle', props: { name: '示例乙', en: 'SI', state: 'idle', status: '空闲 │ 坐着' } },
  { name: 'collapsed', props: { name: '示例乙', state: 'running', status: '进行中', collapsed: true } },
];
