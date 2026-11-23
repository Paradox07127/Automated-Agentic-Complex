import { useRef, type CSSProperties, type ReactNode } from 'react';
import { keyText } from '../../bridge/platformText';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../fx/useGameClip';
import { Icon, type IconName } from '../Icon';
import { Kbd } from '../Kbd';
import { PowerMark } from './PowerState';
import { Slab, unit, type Pt } from './Slab';
import styles from './WatchKey.module.css';

/** A slab's size, and where it sits on its stage in the stage's px; without left and top it takes its place in the flow. */
export interface Box {
  left?: number;
  top?: number;
  width: number;
  height: number;
}

/** The root's style and its `data-placed` mark (absolute on a stage) for `box`. */
export const placeAt = (b: Box): { style: CSSProperties; 'data-placed'?: '' } =>
  b.left == null || b.top == null
    ? { style: { width: b.width, height: b.height } }
    : { style: { left: b.left, top: b.top, width: b.width, height: b.height }, 'data-placed': '' };

/** button_bg01's square, traced from the sprite's alpha edge, in a unit box. */
export const SQUARE: readonly Pt[] = [[0.074, 0.061], [0.034, 0.115], [0.034, 0.899], [0.047, 0.932], [0.095, 0.959], [0.865, 0.966], [0.926, 0.946], [0.946, 0.892], [0.946, 0.142], [0.939, 0.101], [0.905, 0.061]];

/** keyboard_btn's Highlighted clip on a key: forward on pointer or focus in, back on out. Pressed is Normal in the
 *  game: a press drops the key to rest at once, and it rises again on release. */
export function useKeyHover<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const clip = useGameClip(gameClips.keyboardBtnHover, ref);
  const on = () => void clip.play();
  const off = () => void clip.reverse();
  return { ref, onPointerEnter: on, onPointerLeave: off, onFocus: on, onBlur: off, onPointerDown: () => clip.rest(), onPointerUp: on };
}

/** 手表方键：表盘上立起的浅色键，图标在上、名字在下；悬停抬起变白，按下回位。开关键按下时脚下一条黄带、右上一个小黑块，状态词写在黄带上。 */
export interface WatchKeyProps {
  /** 在舞台上的位置和大小 */
  box: Box;
  /** 键的外形（键自己的 px）；不给是方键 button_bg01 */
  pts?: ReadonlyArray<readonly [number, number]>;
  /** 图标和名字的中心（键自己的 px）；不给是正中 */
  mid?: readonly [number, number];
  /** 左侧大键：图标和名字大一号、面上有等高线 */
  big?: boolean;
  /** 紧凑款（菜单栏弹窗的四键）：图标缩到 16、行距收紧，副行（热键、档位）在矮键里不被裁 */
  compact?: boolean;
  icon: IconName;
  /** 页面名或动作名 */
  title: string;
  /** 快捷键，按住 ⌘ / Ctrl 时出现在右上角 */
  hotkey?: string | undefined;
  /** 名字下的一行小字：开关的状态（「到 15:30」）或热键 */
  sub?: ReactNode;
  /** 开关键：给了就是开关，true 时脚下黄带 */
  pressed?: boolean;
  /** 这台机器上做不了的原因；给了键就禁用 */
  off?: string | undefined;
  /** 名字后的小标（PowerMark compact：能力关着、键照样能点）；键上放不下状态词，只画图标 */
  mark?: ReactNode;
  /** 手表进场动画驱动的 data-g */
  g?: string;
  onClick: () => void;
}

/** Key face height above its plate: the game's Btn sits 30 game px (13–15 stage px) above its Shadow; 24 so the face
 *  still clears its plate in the smallest window, where the tilt shortens the gap. */
const KEY_DEPTH = 24;
/** Where the plate shows: a left key's Btn sits at (-3.7, 2.4) from its Shadow, a right key's at (6, 0.6) (game px, y up). */
const SHIFT_BIG = [1.85, 1.2] as const;
const SHIFT_SQUARE = [-2.5, 0.25] as const;

export function WatchKey({ box, pts, mid, big, compact, icon, title, hotkey, sub, pressed, off, mark, g, onClick }: WatchKeyProps) {
  const hover = useKeyHover<HTMLButtonElement>();
  const [mx, my] = mid ?? [box.width / 2, box.height / 2];
  return (
    <span className={styles.slot} {...placeAt(box)} data-g={g} data-stub="WatchKey">
      <button
        type="button"
        className={styles.key}
        data-big={big || undefined}
        data-compact={compact || undefined}
        aria-label={title}
        aria-pressed={pressed}
        title={off}
        disabled={!!off}
        onClick={onClick}
        data-g="btn"
        {...hover}
      >
        <Slab pts={pts ?? unit(SQUARE, box.width, box.height)} w={box.width} h={box.height} depth={KEY_DEPTH} tone="light" contour={big} shift={big ? SHIFT_BIG : SHIFT_SQUARE} g="face">
          {pressed && <span className={styles.band} aria-hidden="true" />}
          <span className={styles.face} style={pressed ? { left: mx, bottom: 7 } : { left: mx, top: my }} data-on={pressed || undefined} aria-hidden="true">
            <span className={styles.icon} data-g="icon">
              <Icon name={icon} size={compact ? 16 : pressed ? 20 : 32} />
            </span>
            {mark == null ? (
              <span className={styles.name} data-g="label">
                {title}
              </span>
            ) : (
              <span className={styles.named}>
                <span className={styles.name} data-g="label">
                  {title}
                </span>
                {mark}
              </span>
            )}
            {sub != null && <span className={styles.sub}>{sub}</span>}
          </span>
          {hotkey && (
            <span className={styles.hot}>
              <Kbd>{keyText(hotkey)}</Kbd>
            </span>
          )}
        </Slab>
      </button>
    </span>
  );
}

const KEY: Box = { width: 72, height: 72 };
const noop = () => undefined;

export const WatchKeyDemos: Array<{ name: string; props: WatchKeyProps }> = [
  { name: 'square', props: { box: KEY, icon: 'search', title: '搜索', hotkey: '⌘K', onClick: noop } },
  { name: 'toggle-off', props: { box: KEY, icon: 'moonz', title: '免打扰', pressed: false, onClick: noop } },
  { name: 'toggle-on', props: { box: KEY, icon: 'moonz', title: '免打扰', sub: '到 15:30', pressed: true, onClick: noop } },
  { name: 'sub', props: { box: KEY, icon: 'bolt', title: '快速输入', sub: '⌃⌥Space', onClick: noop } },
  { name: 'off', props: { box: KEY, icon: 'look', title: '屏幕识读', off: '这台机器上不能识读屏幕', onClick: noop } },
  { name: 'mark', props: { box: KEY, icon: 'clock', title: '任务', mark: <PowerMark state="off" compact />, onClick: noop } },
  { name: 'compact', props: { box: { width: 72, height: 58 }, compact: true, icon: 'send', title: '快速输入', sub: '⌃Space', onClick: noop } },
  { name: 'compact-on', props: { box: { width: 72, height: 58 }, compact: true, icon: 'moonz', title: '免打扰', sub: '到 15:30', pressed: true, onClick: noop } },
];
