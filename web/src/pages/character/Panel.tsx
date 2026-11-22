import { useRef, type ReactNode } from 'react';
import { GameTabs, type GameTab } from '../../ui/game';
import { CompactProvider, useCompactScene } from './compact';
import styles from './Panel.module.css';

export interface PanelProps {
  tabs: GameTab[];
  value: string;
  onTab: (id: string) => void;
  /** The micro label over the right end of the tab bar's white rule. */
  tail?: string;
  /** `data-pane` of the body. */
  pane?: string | undefined;
  children: ReactNode;
}

/** 详情页右侧面板（外观、动作、编排、设定）：游戏页签条，下面的行直接放在训练场上；宽度是 Operator 按页给的 `--panel-w`，紧凑场景里行和控件取紧凑款。 */
export function Panel(p: PanelProps) {
  const ref = useRef<HTMLElement>(null);
  const compact = useCompactScene(ref);
  return (
    <section ref={ref} className={styles.panel} data-g="detail" data-switch="panel">
      <GameTabs label="角色页签" tabs={p.tabs} value={p.value} {...(p.tail ? { tail: p.tail } : {})} onChange={p.onTab} />
      <div className={styles.body} data-pane={p.pane} role="tabpanel" aria-label={p.tabs.find((t) => t.id === p.value)?.label}>
        <CompactProvider value={compact}>{p.children}</CompactProvider>
      </div>
    </section>
  );
}
