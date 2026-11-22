import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../ui';
import styles from './Panel.module.css';

export interface PanelTab {
  id: string;
  label: string;
  icon: IconName;
  /** A count after the label (模组设置's switches). */
  count?: number;
}

export interface PanelProps {
  /** None: the body alone, without a tab bar. */
  tabs: PanelTab[];
  value: string;
  onTab: (id: string) => void;
  /** Accessible name of the body when there are no tabs. */
  label: string;
  /** `data-view` of the body. */
  view?: string | undefined;
  /** `data-pane` of the body. */
  pane?: string | undefined;
  children: ReactNode;
}

/** 详情页右侧面板：页签条（图标 │ 标签，选中格深灰、分隔变黄），下面是深色内容；宽度是 Operator 按页给的 `--panel-w`。 */
export function Panel(p: PanelProps) {
  const on = p.tabs.find((t) => t.id === p.value);
  return (
    <section className={styles.panel} data-g="detail" aria-label={on ? undefined : p.label}>
      {p.tabs.length > 0 && (
        <div className={styles.bar}>
          <div className={styles.tabs} role="tablist" aria-label="角色页签">
            {p.tabs.map((t) => (
              <button key={t.id} type="button" role="tab" className={styles.tab} aria-selected={t.id === p.value} onClick={() => t.id !== p.value && p.onTab(t.id)}>
                <Icon name={t.icon} size={20} />
                <i className={styles.div} aria-hidden="true" />
                <span className={styles.tabL}>{t.label}</span>
                {t.count != null && (
                  <span className={styles.n} aria-hidden="true">
                    {t.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className={styles.body}
        data-theme="dark"
        data-view={p.view}
        data-pane={p.pane}
        {...(on ? { role: 'tabpanel', 'aria-label': on.label } : {})}
      >
        {p.children}
      </div>
    </section>
  );
}
