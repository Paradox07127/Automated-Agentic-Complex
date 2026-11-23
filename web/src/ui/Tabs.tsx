import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { gameClips } from '../design/gameClips.generated';
import { Icon, type IconName } from './Icon';
import { Kbd } from './Kbd';
import { playClip } from './ToggleClip';
import { useControlled } from './useControlled';
import styles from './Tabs.module.css';
import stepStyles from './TabsSteps.module.css';

/**
 * 页内二级页签：未选灰字，选中项是白色点纹板加两侧光晕、深色字；计数写成「待处理 [3]」；Q / E 键帽常显在页签条两端，←→ Home End 切换。
 * 给了 icon 的页签和 avatar、steps 两个变体都是顶栏的图标格：格 50 高，选中黄块 76×56 下垂 6 px。
 */
export interface TabsProps {
  /** 页签；计数读不到时给 'error'，写成警告色的「读不到」；给了 icon 的页签图标在上、名字写在图标下 */
  tabs: Array<{
    id: string;
    label: string;
    count?: number | 'error';
    icon?: IconName;
    /** 图标页签右上的红点和它的原因（缺权限、未就绪）；悬停图标或名字时提示原因 */
    mark?: string | undefined;
    /** 图标页签右下的草稿方块 */
    draft?: boolean;
    /** 这一格前面留一段宽间隔（新的一组） */
    gap?: boolean;
    /** avatar 变体：图标位上的头像 */
    avatar?: ReactNode;
    /** steps 变体：右上菱形，完成 / 未到 / 要处理 / 跳过 */
    step?: TabStep;
    /** 读屏名称，默认 label */
    ariaLabel?: string;
  }>;
  /** avatar：角色头像格（对话页）；steps：步骤格（首次设置） */
  variant?: 'avatar' | 'steps';

  /** 当前页签 id */
  value: string;
  /** 读屏名称 */
  label?: string;
  /** 显示并响应 Q/E 键帽，默认 true */
  keys?: boolean;
  /** Q / E 到两端时绕回另一端，默认 true；false 时停在两端 */
  loop?: boolean;
  /** 切换 */
  onChange?: (id: string) => void;
  /** 右键一个页签 */
  onTabContextMenu?: (id: string, at: { x: number; y: number }) => void;
}

export type TabStep = 'done' | 'todo' | 'mark' | 'skip';

const STEP_WORD: Record<TabStep, string> = { done: '完成', todo: '未到', mark: '要处理', skip: '跳过' };

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]';
/** valuabledepot_tab_select_out: the tab just left folds its plate for this long. */
const LEAVE_MS = 333;

export function Tabs({ tabs, value, label, keys = true, loop = true, variant, onChange, onTabContextMenu }: TabsProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const sel = tabs.findIndex((t) => t.id === current);
  const index = Math.max(0, sel);
  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(current);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (shown !== current) {
    setShown(current);
    setLeaving(shown);
  }
  useEffect(() => {
    if (leaving === null) return;
    const t = setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  // Icon cells: valuabledepot_tab_select_out on the cell left, _in on the cell picked.
  const prev = useRef(current);
  useLayoutEffect(() => {
    const old = prev.current;
    if (old === current) return;
    prev.current = current;
    const cell = (id: string) => root.current?.querySelector(`[data-icon][data-tab="${id}"]`);
    playClip(gameClips.tabSelectOut, cell(old));
    playClip(gameClips.tabSelectIn, cell(current));
  }, [current]);

  const go = (i: number, focus: boolean) => {
    const n = tabs.length;
    if (n === 0) return;
    const j = (i + n) % n;
    const t = tabs[j];
    if (!t) return;
    setCurrent(t.id);
    if (focus) refs.current[j]?.focus();
  };

  // Q / E switch tabs from anywhere on the page, except while typing or inside a dialog.
  const latest = useRef({ index, go, loop, n: tabs.length });
  latest.current = { index, go, loop, n: tabs.length };
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(TYPING)) return;
      const k = e.key.toLowerCase();
      if (k !== 'q' && k !== 'e') return;
      e.preventDefault();
      const { index: at, go: to, loop: wrap, n } = latest.current;
      const next = at + (k === 'q' ? -1 : 1);
      if (!wrap && (next < 0 || next >= n)) return;
      to(next, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in step)) return;
    e.preventDefault();
    go(step[e.key] ?? index, true);
  };

  return (
    <div ref={root} role="tablist" className={variant === 'steps' ? `${styles.tabs} ${stepStyles.steps}` : styles.tabs} data-stub="Tabs" data-variant={variant} aria-label={label} onKeyDown={onKeyDown}>
      {keys && (
        <span className={styles.key} aria-hidden="true">
          <Kbd size="lg">Q</Kbd>
        </span>
      )}
      {tabs.map((t, i) => {
        // The tab's own title stays the bare name: the command bar writes it after the page's name.
        const cell = t.icon != null || variant != null;
        const why = cell && t.mark ? `${t.label}：${t.mark}` : undefined;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={i === sel}
            aria-label={t.ariaLabel}
            tabIndex={i === index ? 0 : -1}
            data-leaving={(i !== index && t.id === leaving) || undefined}
            data-icon={cell ? '' : undefined}
            data-tab={t.id}
            data-gap={t.gap || undefined}
            title={cell ? t.label : undefined}
            onClick={() => go(i, false)}
            onContextMenu={
              onTabContextMenu &&
              ((e) => {
                e.preventDefault();
                onTabContextMenu(t.id, { x: e.clientX, y: e.clientY });
              })
            }
          >
            {cell && (
              <>
                <span className={styles.slc} data-g={i === sel ? 'slc' : 'flash'} aria-hidden="true" />
                <span className={styles.ic} data-g={i === sel ? 'slcIcon' : 'icon'} title={why}>
                  {variant === 'avatar' ? t.avatar : t.icon && <Icon name={t.icon} size={20} />}
                </span>
              </>
            )}
            {variant === 'steps' && t.step && <span className={styles.step} data-step={t.step} role="img" aria-label={STEP_WORD[t.step]} />}
            <span className={styles.name} title={why}>
              {t.label}
              {t.count === 'error' ? (
                <span className={styles.count} data-error="">
                  读不到
                </span>
              ) : (
                t.count != null && (
                  <span className={styles.count}>
                    <span aria-hidden="true">[</span>
                    {t.count}
                    <span aria-hidden="true">]</span>
                  </span>
                )
              )}
            </span>
            {cell && t.draft && <span className={styles.draft}>草稿</span>}
            {cell && t.mark && <span className={styles.mark} title={t.mark} role="img" aria-label={t.mark} />}
          </button>
        );
      })}
      {keys && (
        <span className={styles.key} aria-hidden="true">
          <Kbd size="lg">E</Kbd>
        </span>
      )}
    </div>
  );
}

export const TabsDemos: Array<{ name: string; props: TabsProps }> = [
  { name: 'tasks', props: { label: '任务视图', value: 'pending', tabs: [{ id: 'pending', label: '待处理', count: 3 }, { id: 'all', label: '全部任务' }, { id: 'goals', label: '目标' }] } },
  { name: 'no-keys', props: { label: '诊断视图', value: 'timeline', keys: false, tabs: [{ id: 'health', label: '健康' }, { id: 'timeline', label: '时间线', count: 12 }, { id: 'logs', label: '日志' }] } },
  { name: 'icon', props: { label: '运行记录页签', value: 'turns', keys: false, tabs: [{ id: 'turns', label: '轮次', icon: 'history' }, { id: 'lanes', label: '动作线', icon: 'hub' }, { id: 'logs', label: '日志', icon: 'file' }] } },
  { name: 'avatar', props: { label: '角色', value: 'si', keys: false, variant: 'avatar', tabs: [{ id: 'si', label: '示例乙', avatar: <DemoFace /> }, { id: 'jia', label: '示例甲', avatar: <DemoFace /> }, { id: 'bing', label: '示例丙', avatar: <DemoFace /> }] } },
  {
    name: 'steps',
    props: {
      label: '步骤',
      value: 'chat',
      keys: false,
      variant: 'steps',
      tabs: [
        { id: 'pick', label: '角色', icon: 'user', step: 'done' },
        { id: 'chat', label: '对话', icon: 'g-chat', step: 'mark' },
        { id: 'voice', label: '声音', icon: 'voice', step: 'skip' },
        { id: 'done', label: '完成', icon: 'check', step: 'todo' },
      ],
    },
  },
];

function DemoFace() {
  return <span className={styles.demoFace} aria-hidden="true" />;
}
