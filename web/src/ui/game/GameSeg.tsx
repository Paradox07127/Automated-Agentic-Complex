import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useToggleClip } from '../ToggleClip';
import { useControlled } from '../useControlled';
import { MicroLabel } from './Marks';
import styles from './GameSeg.module.css';

/** 游戏分段开关：深色斜切槽，选中的白块滑过去（底边一小段黄）；role=radiogroup，←→ Home End 切换。 */
export interface GameSegProps {
  /** 选项，等宽 */
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  /** 当前值 */
  value: string;
  /** 读屏名称 */
  label: string;
  /** plain：速度、播放方式；onoff：斜切「开｜关」，选中第二项（关）时白块变灰、没有黄边 */
  variant?: 'plain' | 'onoff';
  /** 槽上方的说明（中文）和它的微型英文 */
  caption?: string;
  micro?: string;
  /** 整组禁用（锁定） */
  disabled?: boolean;
  onChange?: (value: string) => void;
}

const NEXT: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function GameSeg({ options, value, label, variant = 'plain', caption, micro, disabled, onChange }: GameSegProps) {
  const [current, setCurrent] = useControlled(value, onChange);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const track = useRef<HTMLDivElement>(null);
  const enabled = disabled ? [] : options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const sel = options.findIndex((o) => o.value === current);
  const tabStop = sel >= 0 && enabled.includes(sel) ? sel : (enabled[0] ?? sel);
  // Two options play common_toggle_to_left / _to_right (the knob's nudge and the labels' fade) on each flip.
  useToggleClip(track, options.length === 2 ? sel <= 0 : true);

  const pick = (i: number) => {
    const o = options[i];
    if (!o || !enabled.includes(i)) return;
    if (o.value !== current) setCurrent(o.value);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(sel));
    const step = NEXT[e.key];
    const target = step ? enabled[(pos + step + enabled.length) % enabled.length] : e.key === 'Home' ? enabled[0] : e.key === 'End' ? enabled[enabled.length - 1] : undefined;
    if (target === undefined) return;
    e.preventDefault();
    pick(target);
  };

  const place = { '--n': options.length, '--i': Math.max(0, sel) } as CSSProperties;
  return (
    <div className={styles.seg} data-stub="GameSeg" data-variant={variant} data-off={(variant === 'onoff' && sel === 1) || undefined} aria-disabled={disabled || undefined}>
      {caption && (
        <span className={styles.cap} aria-hidden="true">
          {caption}
          {micro && <MicroLabel>{micro}</MicroLabel>}
        </span>
      )}
      <div ref={track} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={styles.track} style={place} onKeyDown={onKeyDown}>
        {sel >= 0 && <i className={styles.knob} data-g="knob" aria-hidden="true" />}
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            className={styles.opt}
            aria-checked={i === sel}
            disabled={disabled || o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            data-g={options.length === 2 ? (i === 0 ? 'leftText' : 'rightText') : undefined}
            onClick={() => pick(i)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const GameSegDemos: Array<{ name: string; props: GameSegProps }> = [
  {
    name: 'speed',
    props: {
      label: '速度',
      caption: '速度',
      micro: 'Speed',
      value: '1',
      options: [
        { value: '0.5', label: '0.5×' },
        { value: '1', label: '1×' },
        { value: '2', label: '2×' },
      ],
    },
  },
  {
    name: 'mode',
    props: {
      label: '播放方式',
      caption: '播放方式',
      micro: 'Mode',
      value: 'once',
      options: [
        { value: 'once', label: '一次' },
        { value: 'loop', label: '循环' },
      ],
    },
  },
  { name: 'on', props: { label: '开口说话', variant: 'onoff', value: 'on', options: [{ value: 'on', label: '开' }, { value: 'off', label: '关' }] } },
  { name: 'off', props: { label: '思考', variant: 'onoff', value: 'off', options: [{ value: 'on', label: '开' }, { value: 'off', label: '关' }] } },
  { name: 'locked', props: { label: '站立待机', variant: 'onoff', value: 'on', disabled: true, options: [{ value: 'on', label: '开' }, { value: 'off', label: '关' }] } },
];
