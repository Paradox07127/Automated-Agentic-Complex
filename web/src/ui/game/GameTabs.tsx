import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { Icon, type IconName } from '../Icon';
import { playClip } from '../ToggleClip';
import { useControlled } from '../useControlled';
import { MicroLabel } from './Marks';
import styles from './GameTabs.module.css';

export interface GameTab {
  id: string;
  label: string;
  icon: IconName;
  /** 右上角的微型英文 */
  micro?: string;
  /** 标签后的数字角标 */
  count?: number;
  /** 有没保存或不是默认的改动：标签后一个橙点 */
  changed?: boolean;
}

/** 页面页签条（游戏 CharInfo 档案页）：每格「图标 │ 标签」；未选浅灰半透明加细斜纹，选中深灰、竖分隔变黄、两个上角橙色菱形；条下白线右端一段黄。←→ Home End 切换。 */
export interface GameTabsProps {
  tabs: GameTab[];
  /** 当前页签 id */
  value: string;
  /** 读屏名称 */
  label: string;
  /** 白线右端上方的微型英文 */
  tail?: string;
  /** 切换 */
  onChange?: (id: string) => void;
}

const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i) => i + 1,
  ArrowLeft: (i) => i - 1,
  Home: () => 0,
  End: (_, n) => n - 1,
};

export function GameTabs({ tabs, value, label, tail, onChange }: GameTabsProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const bar = useRef<HTMLDivElement>(null);
  const id = useId();
  const sel = tabs.findIndex((t) => t.id === current);
  const index = Math.max(0, sel);

  // valuabledepot_tab_select_in on the cell picked: the dark plate opens, icon and name drop in.
  const prev = useRef(current);
  useLayoutEffect(() => {
    if (prev.current === current) return;
    prev.current = current;
    playClip(gameClips.tabSelectIn, bar.current?.querySelector(`[data-tab="${current}"]`));
  }, [current]);

  const go = (i: number, focus: boolean) => {
    const n = tabs.length;
    const j = (i + n) % n;
    const t = tabs[j];
    if (!t) return;
    if (t.id !== current) setCurrent(t.id);
    if (focus) refs.current[j]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[e.key];
    if (!step || tabs.length === 0) return;
    e.preventDefault();
    go(step(index, tabs.length), true);
  };

  return (
    <div className={styles.root} data-stub="GameTabs">
      <div ref={bar} role="tablist" aria-label={label} className={styles.bar} onKeyDown={onKeyDown}>
        {tabs.map((t, i) => {
          const on = i === sel;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              className={styles.tab}
              aria-selected={on}
              aria-describedby={t.changed ? `${id}-chg` : undefined}
              tabIndex={i === index ? 0 : -1}
              data-tab={t.id}
              onClick={() => go(i, false)}
            >
              {on && (
                <span className={styles.plate} data-g="slc" aria-hidden="true">
                  <i className={styles.dia} data-side="l" />
                  <i className={styles.dia} data-side="r" />
                </span>
              )}
              <span className={styles.ic} data-g={on ? 'slcIcon' : undefined}>
                <Icon name={t.icon} size={20} />
              </span>
              <i className={styles.div} aria-hidden="true" />
              <span className={styles.name} data-g={on ? 'slcName' : undefined}>
                {t.label}
              </span>
              {t.count != null && (
                <span className={styles.n} aria-hidden="true">
                  {t.count}
                </span>
              )}
              {t.changed && <i className={styles.dot} aria-hidden="true" />}
              {t.micro && (
                <span className={styles.micro}>
                  <MicroLabel>{t.micro}</MicroLabel>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className={styles.line} aria-hidden="true" />
      {tail && (
        <span className={styles.tail}>
          <MicroLabel>{tail}</MicroLabel>
        </span>
      )}
      {tabs.some((t) => t.changed) && (
        <span id={`${id}-chg`} hidden>
          有改动
        </span>
      )}
    </div>
  );
}

const LOOK: GameTab[] = [
  { id: 'look', label: '外观', icon: 'look', micro: 'OUTFIT' },
  { id: 'show', label: '显示', icon: 'eye', micro: 'LAYERS' },
  { id: 'mod', label: '模组设置', icon: 'tune', micro: 'MOD CFG', count: 9 },
  { id: 'import', label: '导入', icon: 'plus', micro: 'IMPORT' },
];

export const GameTabsDemos: Array<{ name: string; props: GameTabsProps }> = [
  { name: 'look', props: { label: '外观页签', value: 'mod', tabs: LOOK, tail: 'Agentic Complex / Appearance' } },
  {
    name: 'motion-changed',
    props: {
      label: '动作页签',
      value: 'motions',
      tail: 'Agentic Complex / Motion',
      tabs: [
        { id: 'motions', label: '动作表', icon: 'play', micro: 'MOTIONS' },
        { id: 'chain', label: '编排', icon: 'hub', micro: 'CHAIN', changed: true },
        { id: 'import', label: '导入', icon: 'plus', micro: 'IMPORT' },
      ],
    },
  },
];
