import { useId, useRef, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { IconName } from '../../ui';
import { WatchKey } from '../../ui/game';
import { arcX, C, KEY, LIST, LIST_LINES, listKey, listMax, ROW, type Box } from './geometry';
import { Group } from './Tiles';
import { useListScroll } from './useListScroll';
import styles from './RightList.module.css';

export interface ListKey {
  id: string;
  icon: IconName;
  title: string;
  hotkey?: string | undefined;
  /** Why this machine cannot do it: the key is disabled. */
  off?: string | undefined;
  /** PowerMark compact: its plug-in is off, the key still opens the page. */
  mark?: ReactNode;
  /** A red dot on the key, and on the line over or under the list while the key is out of view. */
  dot?: string | undefined;
  onClick: () => void;
}

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });
const VIEW = LIST.bottom - LIST.top;
/** The band where a row centre counts as in view: inside the fades. */
const IN = [LIST.top + LIST.fade, LIST.bottom - LIST.fade] as const;
/** CONTROLLER_SCROLL_FINE_TUNE_VALUE: a key scrolled into view brings this much of a row more with it. */
const PEEK = 0.05 * ROW.pitch;

/** The pointer's band over the list: the column's width along its arc, the window's height; wheel and drag scroll there. */
function hitArea(): { box: Box; clip: string } {
  const ys = Array.from({ length: 13 }, (_, i) => LIST.top + (VIEW * i) / 12);
  const pad = KEY.w + 10;
  const left = ys.map((y) => [arcX(y) - pad, y] as const);
  const right = ys.map((y) => [arcX(y) + pad, y] as const).reverse();
  const xs = [...left, ...right].map(([x]) => x);
  const b: Box = { left: Math.min(...xs), top: LIST.top, width: Math.max(...xs) - Math.min(...xs), height: VIEW };
  const pts = [...left, ...right].map(([x, y]) => `${(x - b.left).toFixed(1)}px ${(y - LIST.top).toFixed(1)}px`);
  return { box: { ...b, left: b.left + C.x, top: b.top + C.y }, clip: `polygon(${pts.join(', ')})` };
}
const HIT = hitArea();

/** A deco line fixed over or under the list (deco_arrowline, 392×32, the bottom one turned over): a line fading out at
 *  both ends, a chevron over a small mound pointing out of the list, and the red dot of the keys out of view that way. */
function Line({ box, dot, which }: { box: Box; dot: boolean; which: 'up' | 'down' }) {
  const id = useId();
  return (
    <span className={styles.line} style={at(box)} data-line={which} aria-hidden="true">
      <svg viewBox="0 0 392 32" width={box.width} height={box.height} preserveAspectRatio="none">
        <defs>
          <linearGradient id={id}>
            <stop offset="0" className={styles.fadeEnd} />
            <stop offset="0.33" className={styles.fadeMid} />
            <stop offset="0.67" className={styles.fadeMid} />
            <stop offset="1" className={styles.fadeEnd} />
          </linearGradient>
        </defs>
        <rect className={styles.band} x={40} y={22} width={312} height={5} />
        <rect x={0} y={27} width={392} height={2.5} fill={`url(#${id})`} />
        <path className={styles.mound} d="M181 29 196 20 211 29Z" />
        <path className={styles.chevron} d="M180 19.5 196 6 212 19.5" />
      </svg>
      {dot && <i className={styles.dot} />}
    </span>
  );
}

/**
 * The watch's right column: two keys a row in a window that scrolls up and down without a bar, five rows and a strip
 * of the sixth in view. Each row moves along the column's arc as it scrolls; keys fade out at the window's ends.
 * Tab or the arrow keys bring a key out of view in. `scale` is the stage's on screen.
 */
export function RightList({ keys, scale, style }: { keys: ListKey[]; scale: number; style: CSSProperties }) {
  const max = listMax(keys.length);
  const scroll = useListScroll(max, VIEW, scale);
  const root = useRef<HTMLDivElement>(null);
  const placed = keys.map((key, i) => {
    const { box, y } = listKey(i, scroll.pos);
    return { key, box, y, out: y < IN[0] || y > IN[1] };
  });
  const dotAbove = placed.some((p) => p.key.dot && p.out && p.y < IN[0]);
  const dotBelow = placed.some((p) => p.key.dot && p.out && p.y > IN[1]);

  const buttons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  const onFocus = (e: FocusEvent) => {
    const i = buttons().indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const y = placed[i]!.y;
    if (y - KEY.h / 2 < IN[0]) scroll.reveal(scroll.pos - (IN[0] - (y - KEY.h / 2)) - PEEK);
    else if (y + KEY.h / 2 > IN[1]) scroll.reveal(scroll.pos + (y + KEY.h / 2 - IN[1]) + PEEK);
  };
  // Up and down go a row, left and right across one; disabled keys are passed over.
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowUp: -2, ArrowDown: 2, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const all = buttons();
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (!step || i < 0) return;
    if (Math.abs(step) === 1 && Math.floor((i + step) / 2) !== Math.floor(i / 2)) return;
    for (let j = i + step; j >= 0 && j < all.length; j += step) {
      if (all[j]!.disabled) continue;
      e.preventDefault();
      all[j]!.focus();
      return;
    }
  };

  const rows = Array.from({ length: Math.ceil(placed.length / 2) }, (_, r) => placed.slice(r * 2, r * 2 + 2));
  return (
    <div
      ref={root}
      className={styles.list}
      style={style}
      role="group"
      aria-label="工具"
      onWheel={scroll.onWheel}
      onPointerDown={scroll.onPointerDown}
      onClickCapture={scroll.onClickCapture}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <span className={styles.hit} style={{ ...at(HIT.box), clipPath: HIT.clip }} aria-hidden="true" />
      {rows.map((pair, r) => (
        // Keyed by row: a key coming or going must not remount a group the entrance clip is playing.
        <Group key={r} g={`group${r + 1}`}>
          {pair.map(({ key, box, out }) => (
            <WatchKey
              key={key.id}
              box={box}
              icon={key.icon}
              title={key.title}
              hotkey={key.hotkey}
              off={key.off}
              mark={key.mark}
              dot={key.dot}
              clip={{ top: C.y + LIST.top - box.top, bottom: C.y + LIST.bottom - box.top, fade: LIST.fade }}
              out={out}
              onClick={key.onClick}
            />
          ))}
        </Group>
      ))}
      <Line box={LIST_LINES[0]} dot={dotAbove} which="up" />
      <Line box={LIST_LINES[1]} dot={dotBelow} which="down" />
    </div>
  );
}
