import type { CSSProperties, ReactNode } from 'react';
import { GlowLayer, MaskSweep, RadialFill } from '../../ui';
import { around, CROSSES, GLOWS, RING_DOTS, TECHLINES, TICKS, TRIANGLES, type Box } from './geometry';
import styles from './Rings.module.css';

const at = (b: Box): CSSProperties => ({ left: b.left, top: b.top, width: b.width, height: b.height });
const ring = (d: number, x = 0, y = 0) => at(around(x, y, d, d));

/** A zero-size pivot `x`, `y` from the ring centre; the watch clips scale and turn it. */
function Node({ g, x = 0, y = 0, children }: { g?: string; x?: number; y?: number; children: ReactNode }) {
  return (
    <div className={styles.node} style={{ left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }} data-g={g}>
      {children}
    </div>
  );
}

/** The two 36° yellow arcs (filled radial360 0.1 from the right), turned to where the game's flipped images put them. */
const ARCS = [-20.1, 165.8] as const;

/** MiddleDecoNode under the map's content: out ring, side frames, yellow ring, mesh ring, triangles, main ring, arcs, tech lines, blue ring, ticks. */
export function Rings() {
  return (
    <div className={styles.rings} aria-hidden="true">
      <Node g="outRing">
        <span className={`${styles.ring} ${styles.out}`} style={ring(819.2)} data-g="outRingImg" />
        {RING_DOTS.map(([x, y]) => (
          <span key={`${x}-${y}`} className={styles.dot} style={ring(7.5, x, y)} />
        ))}
      </Node>
      <Node g="decoOut">
        <span className={`${styles.frame} ${styles.frameL}`} style={at({ left: -490.5, top: -232.5, width: 174, height: 465 })} />
        <span className={styles.frame} style={at({ left: 317, top: -232.5, width: 174, height: 465 })} />
      </Node>
      <Node g="yellowRing" y={-19.5}>
        <span className={`${styles.ring} ${styles.grid}`} style={ring(452.6, 0, -0.5)} />
        <span className={styles.fill} style={ring(512)}>
          <RadialFill amount={1} size={512} thickness={1.5} tone="ring-yellow" sprite="watch/ui-out-ring" />
        </span>
      </Node>
      <Node g="mesh" x={3.5} y={-25.5}>
        <span className={`${styles.ring} ${styles.mesh}`} style={ring(375)} />
      </Node>
      <Node g="triangles">
        {TRIANGLES.map(([x, y, a]) => (
          <span key={a} className={styles.tri} style={{ ...at(around(x, y, 34.4, 34.6)), transform: `rotate(${a}deg)` }} />
        ))}
      </Node>
      <Node g="mainRing">
        <span className={`${styles.ring} ${styles.main}`} style={ring(655.9)} data-g="mainRingImg" />
        <span className={styles.wordmark} style={at(around(0, 249.5, 81.3, 17.6))} data-g="wordmark">
          <span className={styles.bloom} />
        </span>
      </Node>
      <Node g="yellowLine" y={14}>
        {ARCS.map((a) => (
          <span key={a} className={styles.arc} style={{ ...ring(436.2), transform: `rotate(${a}deg)` }}>
            <RadialFill amount={0.1} size={436.2} thickness={3} origin="right" tone="yellow" sprite="watch/ui-out1-ring" />
          </span>
        ))}
      </Node>
      <Node g="techlines">
        {TECHLINES.map(([x, y, a, yellow], i) => (
          <span key={`${x}-${y}`} className={styles.tech} style={{ ...at(around(x, y, 44, 3)), transform: `rotate(${a}deg)` }} data-yellow={yellow || undefined}>
            <MaskSweep play={false} from="left" g={i < 4 ? `techline${i + 1}` : i === 4 ? 'techlineYellowL' : 'techlineYellowR'}>
              <i />
            </MaskSweep>
          </span>
        ))}
      </Node>
      <Node g="blueRing" y={-20}>
        <span className={`${styles.ring} ${styles.blue}`} style={ring(331.3)} data-g="blueRingImg" />
        {[45, -45, 90].map((a, i) => (
          <span key={a} className={styles.beam} style={{ ...at(around(0, 0, 1, 1200)), rotate: `${a}deg` }} data-g={`blueLine${i + 1}`} />
        ))}
      </Node>
      <Node>
        {TICKS.map((t, i) => (
          <span key={t.m} className={styles.tick} style={{ ...at(around(t.x, t.y, 126.5, 206.5)), transform: `matrix(${t.m},0,0)` }} data-g={`tick${i + 1}`}>
            <span className={styles.tickGhost} />
            <span className={styles.tickLine} data-fill={t.fill} style={t.amount ? ({ '--amount': `${t.amount * 100}%` } as CSSProperties) : undefined} />
          </span>
        ))}
      </Node>
    </div>
  );
}

/** EndfieldLogo over the map's centre; it turns in watch_loop. */
export function Logo() {
  return (
    <div className={styles.rings} aria-hidden="true">
      <Node g="logo" y={6.35}>
        <span className={styles.logo} style={ring(70.5)} />
      </Node>
    </div>
  );
}

/** Watch_Dot crosses and the bloom behind the key columns. */
export function Backdrop() {
  return (
    <div className={styles.rings} aria-hidden="true">
      <Node g="dots">
        {CROSSES.map(([x, y, a]) => (
          <span key={`${x}-${y}`} className={styles.cross} style={{ ...at(around(x, y, 13, 13)), opacity: a }} />
        ))}
      </Node>
      {GLOWS.map((b, i) => (
        <span key={b.left} className={styles.glow} style={at(b)}>
          <GlowLayer w={b.width} h={b.height} sprite={i === 0 ? 'watch/ui-main-menu-btn01-bloom' : 'watch/ui-main-menu-btn02-bloom'} opacity={i === 0 ? 0.6 : 0.35} g={i === 0 ? 'glowLeft' : 'glowRight'} />
        </span>
      ))}
    </div>
  );
}
