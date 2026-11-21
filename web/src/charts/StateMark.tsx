import { stateVisual, type VisualShape, type VisualStateKey } from '../domain';
import styles from './chart.module.css';

/** Text form of each shape, for tooltips and table cells. */
export const SHAPE_CHAR: Record<VisualShape, string> = { check: '✓', square: '■', 'hollow-square': '□', triangle: '▲', diamond: '◆', ring: '○', dot: '·' };

/** States that need a look; their glyph is drawn in ink on a yellow block. */
const LOOK = new Set(['--ef-state-failed', '--ef-state-waiting', '--ef-state-warning']);

/** Shape glyph of one state, drawn in the state's colour token; a failure on its yellow block reads ✕. */
export function ShapeGlyph({ shape, token, size = 10 }: { shape: VisualShape; token: string; size?: number }) {
  const look = LOOK.has(token);
  const ink = look ? 'var(--ef-on-accent)' : 'currentColor';
  return (
    <svg className={styles.glyph} width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" data-shape={shape} style={{ color: `var(${token})` }}>
      <g>
        {look && <rect width="10" height="10" fill="currentColor" />}
        <g transform={look ? 'translate(1.5 1.5) scale(.7)' : undefined}>
          {shape === 'check' && <path d="M1.5 5.2l2.4 2.4 4.6-5.2" fill="none" stroke={ink} strokeWidth="1.8" />}
          {shape === 'square' && (look ? <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" fill="none" stroke={ink} strokeWidth="1.8" /> : <rect x="1.5" y="1.5" width="7" height="7" fill={ink} />)}
          {shape === 'hollow-square' && <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke={ink} strokeWidth="1.2" />}
          {shape === 'triangle' && <path d="M5 1l4.2 8H.8z" fill={ink} />}
          {shape === 'diamond' && <path d="M5 .6L9.4 5 5 9.4.6 5z" fill={ink} />}
          {shape === 'ring' && <circle cx="5" cy="5" r="3.6" fill="none" stroke={ink} strokeWidth="1.5" />}
          {shape === 'dot' && <circle cx="5" cy="5" r="2" fill={ink} />}
        </g>
      </g>
    </svg>
  );
}

/** Colour + shape + text for a state; `label` overrides the text channel. */
export function StateMark({ state, label, size }: { state: VisualStateKey; label?: string; size?: number }) {
  const v = stateVisual(state);
  return (
    <span className={styles.mark} data-tone={v.tone} data-shape={v.shape}>
      <ShapeGlyph shape={v.shape} token={v.token} size={size} />
      <span>{label ?? v.label}</span>
    </span>
  );
}
