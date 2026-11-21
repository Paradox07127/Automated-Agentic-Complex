import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, Kbd } from '../../../../ui';
import type { CmdItem } from '../actions';
import styles from './CommandRing.module.css';

/**
 * 指令环: 8 sectors, inner radius 60, outer 144, gap 3. Clicking a sector, its
 * number 1–8, or ⏎ on the selected one runs its item; ←/→ move the selection, esc closes. Drawn as a quick menu:
 * a #000@.72 disc with thin rings, the selected sector lit by the select wedge, its inner marker and
 * the yellow arrow. With the art in place the wedge and marker are the wedge and marker sprites turned to the
 * selected sector; the SVG wedge and marker stand in without it.
 */
export interface CommandRingProps {
  items: CmdItem[];
  /** 待处理 count on its sector. */
  pending: number;
  /** Saved hotkeys by setting id; an item hints only a set one. */
  keys?: Readonly<Record<string, string>>;
  onRun: (item: CmdItem) => void;
  onClose: () => void;
}

const R0 = 60;
const R1 = 144;
const C = 152;

const angle = (i: number) => -Math.PI / 2 + (i * Math.PI) / 4;
const pt = (r: number, t: number) => `${(C + r * Math.cos(t)).toFixed(2)} ${(C + r * Math.sin(t)).toFixed(2)}`;

function sectorPath(i: number): string {
  const r1 = R1;
  const a = angle(i);
  const h = Math.PI / 8;
  const g0 = 1.5 / R0;
  const g1 = 1.5 / r1;
  return `M${pt(r1, a - h + g1)}A${r1} ${r1} 0 0 1 ${pt(r1, a + h - g1)}L${pt(R0, a + h - g0)}A${R0} ${R0} 0 0 0 ${pt(R0, a - h + g0)}Z`;
}

/** The white marker arc on the selected sector's inner edge. */
function markerPath(i: number): string {
  const a = angle(i);
  const h = Math.PI / 8 - 6 / R0;
  return `M${pt(R0 + 2, a - h)}A${R0 + 2} ${R0 + 2} 0 0 1 ${pt(R0 + 2, a + h)}`;
}

export function CommandRing({ items, pending, keys = {}, onRun, onClose }: CommandRingProps) {
  const [sel, setSel] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const lit = useId();
  useEffect(() => root.current?.focus(), []);

  const pick = (i: number) => {
    const item = items[i];
    if (item) onRun(item);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = Number(e.key);
    if (e.key === 'Escape') onClose();
    else if (n >= 1 && n <= 8) pick(n - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') setSel((s) => ((s ?? -1) + 1) % 8);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') setSel((s) => ((s ?? 0) + 7) % 8);
    else if (e.key === 'Enter' && sel != null && e.target === root.current) pick(sel);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={styles.ring} data-theme="dark" role="menu" aria-label="指令环" tabIndex={-1} onKeyDown={onKey}>
      <div className={styles.wheel} data-region="">
        <svg className={styles.svg} width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`} aria-hidden="true">
          <defs>
            <radialGradient id={lit} gradientUnits="userSpaceOnUse" cx={C} cy={C} r={R1}>
              <stop offset={R0 / R1} className={styles.litIn} />
              <stop offset="0.75" className={styles.litMid} />
              <stop offset="1" className={styles.litOut} />
            </radialGradient>
          </defs>
          <circle className={styles.disc} cx={C} cy={C} r={C} />
          <circle className={styles.rim} cx={C} cy={C} r={C - 1.5} />
          <circle className={styles.cycle} cx={C} cy={C} r={122} />
          <circle className={styles.guide} cx={C} cy={C} r={R0 - 8} />
          {items.map((item, i) => {
            const a = angle(i);
            const on = sel === i;
            return (
              <g key={item.id} className={styles.sector} data-on={on || undefined} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
                <path className={styles.hit} d={sectorPath(i)} />
                <path className={styles.wedge} d={sectorPath(i)} fill={`url(#${lit})`} />
                {on && (
                  <>
                    <path className={styles.marker} d={markerPath(i)} />
                    <path className={styles.arrow} d="M0 -6L7 6H-7Z" transform={`translate(${pt(R0 - 12, a)}) rotate(${(a * 180) / Math.PI + 90})`} />
                  </>
                )}
              </g>
            );
          })}
        </svg>
        {sel != null && (
          <span key={sel} className={styles.select} style={{ transform: `rotate(${sel * 45}deg)`, clipPath: `path('${sectorPath(0)}')` }} aria-hidden="true" />
        )}
        {items.map((item, i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / 4;
          const key = item.hotkey ? keys[item.hotkey] : undefined;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={styles.label}
              data-on={sel === i || undefined}
              style={{ left: C + Math.cos(a) * 102, top: C + Math.sin(a) * 102 }}
              onMouseEnter={() => setSel(i)}
              onFocus={() => setSel(i)}
              onClick={() => pick(i)}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
              {item.sub && <span className={styles.sub}>{item.sub}</span>}
              <span className={styles.meta}>
                <span className={styles.no} aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {key && <span className={styles.key}>{key}</span>}
              </span>
              {item.pending && pending > 0 && (
                <span className={styles.badge}>
                  <span>{pending}</span>
                </span>
              )}
            </button>
          );
        })}
        <span className={styles.art} data-art-slot="ring-center" aria-hidden="true" />
        <span className={styles.logo} aria-hidden="true" />
        <button type="button" className={styles.center} onClick={onClose} aria-label="关闭指令环">
          关闭
          <Kbd hud>esc</Kbd>
        </button>
        <p className={styles.help}>1–8 直接执行 │ esc 关闭</p>
      </div>
    </div>
  );
}
