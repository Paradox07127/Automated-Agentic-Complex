import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';
import styles from './OptionStack.module.css';

/** 选项列的一行。 */
export interface OptionStackItem {
  id: string;
  label: string;
  icon: IconName;
  /** 做不了的原因：键块变禁用色，原因进悬停提示，点了不触发 */
  off?: string;
  /** 正在进行（在录音）：键块变红、图标闪 */
  live?: boolean;
}

/** 交互选项列（游戏 F 交互选项）：竖排的行，每行一个深色键块（图标）+ 名字，右端渐隐；悬停描边、整行外移 3 px；一侧带括线。side=left 时镜像。紧凑款只留键块，名字进悬停提示。 */
export interface OptionStackProps {
  items: readonly OptionStackItem[];
  /** 列在身体哪一侧：right（默认）从左往右排，left 镜像 */
  side?: 'left' | 'right';
  /** 紧凑款：只留键块 */
  compact?: boolean;
  /** 键盘落在哪一行（同悬停的样子） */
  hot?: string;
  /** 列尾的一行状态（「免打扰到 15:30」） */
  note?: ReactNode;
  /** 读屏名称 */
  label?: string;
  onPick: (id: string) => void;
  /** 点做不了的行（例如跳到设置里打开它）；不给时这种行点了没反应 */
  onPickOff?: (id: string) => void;
  /** 指针按下一行（按住说话）；做不了的行不报 */
  onPressStart?: (id: string) => void;
  /** 按下的那行松开或被打断 */
  onPressEnd?: (id: string) => void;
}

export function OptionStack({ items, side = 'right', compact, hot, note, label, onPick, onPickOff, onPressStart, onPressEnd }: OptionStackProps) {
  const pressed = useRef<string | null>(null);
  const down = (it: OptionStackItem, e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || it.off) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressed.current = it.id;
    onPressStart?.(it.id);
  };
  const up = () => {
    const id = pressed.current;
    pressed.current = null;
    if (id != null) onPressEnd?.(id);
  };
  return (
    <div className={styles.stack} data-stub="OptionStack" data-side={side} data-compact={compact || undefined} role="group" aria-label={label}>
      <i className={styles.rail} aria-hidden="true" />
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          className={styles.opt}
          style={{ '--i': i } as CSSProperties}
          data-hot={hot === it.id || undefined}
          data-off={it.off ? (onPickOff ? 'go' : '') : undefined}
          data-live={it.live || undefined}
          aria-label={it.label}
          aria-disabled={it.off ? true : undefined}
          title={compact ? [it.label, it.off].filter(Boolean).join('  ') : it.off}
          onClick={() => (it.off ? onPickOff?.(it.id) : onPick(it.id))}
          onPointerDown={(e) => down(it, e)}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <span className={styles.key} aria-hidden="true">
            <Icon name={it.icon} size={16} />
          </span>
          {!compact && <span className={styles.name}>{it.label}</span>}
        </button>
      ))}
      {note != null && !compact && (
        <div className={styles.note}>
          <Icon name="moonz" size={14} />
          {note}
        </div>
      )}
    </div>
  );
}

const ITEMS: OptionStackItem[] = [
  { id: 'chat', label: '对话', icon: 'send' },
  { id: 'voice', label: '说话', icon: 'mic' },
  { id: 'look', label: '给角色看', icon: 'look' },
  { id: 'hide', label: '隐藏', icon: 'eye' },
];
const noop = () => undefined;

export const OptionStackDemos: Array<{ name: string; props: OptionStackProps }> = [
  { name: 'right', props: { items: ITEMS, hot: 'chat', label: '角色的按钮', onPick: noop } },
  { name: 'left', props: { items: ITEMS, side: 'left', note: '免打扰到 15:30', onPick: noop } },
  { name: 'off', props: { items: [ITEMS[0]!, { ...ITEMS[1]!, label: '在听…松开发送', live: true }, { ...ITEMS[2]!, off: '观察已暂停' }], onPick: noop } },
  { name: 'compact', props: { items: ITEMS, compact: true, onPick: noop } },
  { name: 'off-pickable', props: { items: [ITEMS[0]!, { ...ITEMS[1]!, off: '没有麦克风权限，点按前往设置' }], onPick: noop, onPickOff: noop } },
];
