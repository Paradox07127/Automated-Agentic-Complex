import { useRef, type KeyboardEvent } from 'react';
import { useControlled } from './useControlled';
import styles from './FilterChips.module.css';

/** 一个筛选片；count 不给时不显示计数。 */
export interface FilterChip {
  value: string;
  label: string;
  count?: number;
}

/** 带计数的筛选片：单选或多选；每片都可用 Tab 到达，←→ 也能移动，空格或回车切换。 */
export interface FilterChipsProps {
  /** 读屏名称 */
  label: string;
  /** 各筛选片 */
  options: FilterChip[];
  /** 选中的值；单选时最多一个 */
  value: string[];
  /** 多选，默认单选 */
  multiple?: boolean;
  /** 选择变化 */
  onChange?: (value: string[]) => void;
}

export function FilterChips({ label, options, value, multiple, onChange }: FilterChipsProps) {
  const [picked, setPicked] = useControlled(value, onChange);
  const group = useRef<HTMLDivElement>(null);

  const toggle = (v: string) => {
    if (!multiple) {
      if (picked[0] !== v) setPicked([v]);
      return;
    }
    setPicked(picked.includes(v) ? picked.filter((p) => p !== v) : options.map((o) => o.value).filter((o) => o === v || picked.includes(o)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const chips = Array.from(group.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    chips[(at + (e.key === 'ArrowRight' ? 1 : chips.length - 1)) % chips.length]?.focus();
  };

  return (
    <div ref={group} role="group" aria-label={label} className={styles.chips} data-stub="FilterChips" onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.value} type="button" className={styles.chip} aria-pressed={picked.includes(o.value)} onClick={() => toggle(o.value)}>
          {o.label}
          {o.count !== undefined && <span className={styles.count}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

const STATES: FilterChip[] = [
  { value: 'all', label: '全部', count: 50 },
  { value: 'running', label: '进行中', count: 3 },
  { value: 'waiting', label: '待处理', count: 5 },
  { value: 'failed', label: '失败', count: 2 },
  { value: 'done', label: '完成', count: 40 },
];

export const FilterChipsDemos: Array<{ name: string; props: FilterChipsProps }> = [
  { name: 'single', props: { label: '按状态筛选', options: STATES, value: ['waiting'] } },
  {
    name: 'multiple',
    props: {
      label: '按来源筛选',
      multiple: true,
      options: [
        { value: 'chat', label: '对话', count: 812 },
        { value: 'task', label: '任务', count: 301 },
        { value: 'watch', label: '观察', count: 171 },
        { value: 'manual', label: '手动添加', count: 0 },
      ],
      value: ['chat', 'task'],
    },
  },
];
