import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { animate, fxCalm, playOnce } from '../fx/motion';
import { Icon, type IconName } from '../Icon';
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

/** 页面页签条（游戏 CharInfo 档案页）：每格「图标 │ 标签」；未选浅灰半透明加细斜纹，选中深灰、竖分隔变黄；条下白线右端一段黄。←→ Home End 切换。 */
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

// btnprofiletab_open / _close: the dark plate grows rightwards from 143 px short of the cell.
const SHUT = 'inset(-6px 143px -6px -6px)';
const FULL = 'inset(-6px)';
const EXIT = 'cubic-bezier(1, 0, 0.667, 1)';
const FADE = 'cubic-bezier(0.333, 0, 0.667, 1)';

function openTab(tab: Element | null | undefined) {
  const plate = tab?.querySelector('[data-g="slc"]');
  if (plate) {
    playOnce(plate, [{ clipPath: SHUT, easing: EXIT }, { clipPath: FULL }], { duration: 200 });
    playOnce(plate, [{ opacity: 0, easing: FADE }, { opacity: 1 }], { duration: 100 });
  }
  for (const el of tab?.querySelectorAll('[data-g="slcIcon"], [data-g="slcName"], [data-g="slcDiv"]') ?? []) playOnce(el, [{ opacity: 0, easing: FADE }, { opacity: 1 }], { duration: 167 });
}

/** The left tab's plate shrinks back over its content and fades out at the end; null when calm. */
function closeTab(plate: Element): Animation | null {
  if (fxCalm()) return null;
  animate(plate, [{ opacity: 1 }, { opacity: 1, offset: 0.8, easing: FADE }, { opacity: 0 }], { duration: 167, fill: 'forwards' });
  return animate(plate, [{ clipPath: FULL, easing: EXIT }, { clipPath: SHUT }], { duration: 167, fill: 'forwards' });
}

export function GameTabs({ tabs, value, label, tail, onChange }: GameTabsProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const bar = useRef<HTMLDivElement>(null);
  const id = useId();
  const sel = tabs.findIndex((t) => t.id === current);
  const index = Math.max(0, sel);

  // The tab picked opens its plate; the one left keeps a plate until its close run ends.
  const [shown, setShown] = useState(current);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (shown !== current) {
    setShown(current);
    setLeaving(shown);
  }
  const prev = useRef(current);
  useLayoutEffect(() => {
    if (prev.current === current) return;
    prev.current = current;
    openTab(bar.current?.querySelector(`[data-tab="${current}"]`));
  }, [current]);
  useLayoutEffect(() => {
    if (leaving === null) return;
    const plate = bar.current?.querySelector('[data-leaving]');
    const run = plate ? closeTab(plate) : null;
    if (!run) {
      setLeaving(null);
      return;
    }
    run.finished.then(
      () => setLeaving(null),
      () => undefined,
    );
    return () => plate?.getAnimations?.().forEach((a) => a.cancel());
  }, [leaving]);

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
              {(on || t.id === leaving) && (
                <span className={styles.plate} data-g={on ? 'slc' : undefined} data-leaving={on ? undefined : ''} aria-hidden="true" />
              )}
              <span className={styles.ic} data-g={on ? 'slcIcon' : undefined}>
                <Icon name={t.icon} size={20} />
              </span>
              <i className={styles.div} data-g={on ? 'slcDiv' : undefined} aria-hidden="true" />
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
