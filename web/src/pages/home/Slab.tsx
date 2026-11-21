import { useId, type CSSProperties, type ReactNode } from 'react';
import { flow } from './flow';
import styles from './Slab.module.css';

export type Pt = readonly [number, number];

/** A closed path through `pts` with each corner rounded by up to `r` (less where an edge is shorter than 2r). */
function roundPath(pts: readonly Pt[], r: number): string {
  const n = pts.length;
  const cut = (a: Pt, b: Pt, d: number): Pt => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = Math.min(d, len / 2) / len;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const f = (p: Pt) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const a = cut(p, pts[(i + n - 1) % n]!, r);
    const b = cut(p, pts[(i + 1) % n]!, r);
    d += `${i === 0 ? 'M' : 'L'}${f(a)} Q${f(p)} ${f(b)} `;
  }
  return `${d}Z`;
}

/** `pts` given in a unit box, scaled to `w`×`h`. */
export const unit = (pts: readonly Pt[], w: number, h: number): Pt[] => pts.map(([u, v]) => [u * w, v * h]);

/** Light keys, dark glass plates, the yellow bar slots. */
export type Tone = 'light' | 'dark' | 'yellow';

export interface SlabProps {
  /** Outline in the slab's own px, inside `w`×`h`. */
  pts: readonly Pt[];
  w: number;
  h: number;
  /** Height of the face above its plate, in stage px. An ancestor's `--press` scales it. */
  depth: number;
  tone: Tone;
  /** Faint contour lines on the face, as on the game's keys. */
  contour?: boolean;
  /** Top of a lighter band across the bottom of the face, as a fraction of `h` (the bar slots' white strip). */
  band?: number;
  /** A yellow edge on the left fading right, over an olive wash (the news banner). */
  accent?: boolean;
  /** Where the plate shows from under the face, in stage px; down-right when not given. */
  shift?: Pt;
  /** data-g of the face, for a clip that drives its opacity. */
  g?: string;
  /** Content on the face; it rides up and down with it. */
  children?: ReactNode;
}

/** Widths inward from the outline: the rim, then the dark gap to the face (the sprites' 3 px and 3 px at half size). */
const RIM = 1.5;
const GAP = 1.5;

/**
 * Two layers, as the game's keys are a Shadow image with the Btn image 30 units above it. The plate is the shadow: the
 * same outline offset down-right, dark and see-through with the sprite's bright rim, so it stays apart from the face on
 * a light frosted ground. The face above it has the sprite's edge, from the outline in: a bright rim,
 * a dark gap, then the see-through face. Strokes clipped to the outline draw the rim and gap at an even width round
 * any shape; a mask of the outline less those widths cuts the face.
 */
export function Slab({ pts, w, h, depth, tone, contour, band, accent, shift = [1.85, 1.2], g, children }: SlabProps) {
  const id = useId();
  const path = roundPath(pts, 4);
  const seed = ((w * 7.3 + h * 13.7) % 10) / 10;
  const lines = contour ? flow([[w * (0.05 + seed * 0.3), -h * 0.1], [w * 0.5, h * (0.35 + seed * 0.2)], [w * 1.1, h * 0.85]], 12, 3, 0.7, seed * 6) : [];
  const box = { width: w, height: h, viewBox: `0 0 ${w} ${h}`, overflow: 'visible', 'aria-hidden': true } as const;
  const inner = `url(#${id}m)`;
  return (
    <span className={styles.slab} data-tone={tone} style={{ '--depth': `${depth}px`, '--shift': `${shift[0]}px ${shift[1]}px` } as CSSProperties}>
      <svg className={styles.plate} {...box}>
        <path d={path} />
        <path className={styles.plateRim} d={path} strokeWidth={RIM * 2} clipPath={`url(#${id}c)`} />
      </svg>
      <svg className={styles.top} data-g={g} {...box}>
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={styles.faceTop} />
            <stop offset="0.55" className={styles.faceMid} />
            <stop offset="1" className={styles.faceBot} />
          </linearGradient>
          <clipPath id={`${id}c`}>
            <path d={path} />
          </clipPath>
          <mask id={`${id}m`} maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
            <path d={path} fill="white" stroke="black" strokeWidth={(RIM + GAP) * 2} />
          </mask>
          {accent && (
            <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" className={styles.accentOn} />
              <stop offset="0.45" className={styles.accentOff} />
            </linearGradient>
          )}
        </defs>
        <path className={styles.face} d={path} fill={`url(#${id}f)`} mask={inner} />
        {band != null && <rect className={styles.band} x={0} y={h * band} width={w} height={h * (1 - band)} mask={inner} />}
        {accent && <path className={styles.wash} d={path} fill={`url(#${id}a)`} mask={inner} />}
        {contour && (
          <g mask={inner} className={styles.contour}>
            {lines.map((d, i) => (
              <path key={i} d={d} data-major={i % 5 === 3 || undefined} />
            ))}
          </g>
        )}
        <g clipPath={`url(#${id}c)`} fill="none">
          <path className={styles.gap} d={path} strokeWidth={(RIM + GAP) * 2} />
          <path className={styles.rim} d={path} strokeWidth={RIM * 2} stroke={accent ? `url(#${id}a)` : undefined} />
        </g>
      </svg>
      {children != null && <span className={styles.content}>{children}</span>}
    </span>
  );
}
