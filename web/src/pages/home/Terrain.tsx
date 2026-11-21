import { flow } from './flow';
import type { Pt } from './Slab';
import styles from './Terrain.module.css';

/** Bundles of contour lines across the 400 px map, drawn as the keys' deco_btn textures are: each a curve through the
 *  map, the line count, mean gap, swell and seed for flow(). */
const BUNDLES: ReadonlyArray<readonly [ReadonlyArray<Pt>, number, number, number, number]> = [
  [[[-20, 96], [120, 62], [250, 118], [420, 66]], 10, 7, 0.6, 0.3],
  [[[-20, 262], [110, 206], [232, 262], [420, 206]], 12, 6, 0.7, 1.7],
  [[[40, 430], [150, 340], [300, 336], [420, 286]], 8, 7, 0.5, 2.9],
  [[[236, -20], [290, 58], [420, 112]], 6, 7, 0.6, 4.1],
];
const CONTOURS = BUNDLES.flatMap(([spine, n, gap, swell, seed]) => flow(spine, n, gap, swell, seed).map((d, i) => ({ d, major: i % 5 === 2 })));

/** Bearing ticks round the map's edge: every 5°, longer every 30°. */
const TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const long = i % 6 === 0;
  const [r0, r1] = [184, long ? 172 : 179];
  return { x0: 200 + r0 * Math.cos(a), y0: 200 + r0 * Math.sin(a), x1: 200 + r1 * Math.cos(a), y1: 200 + r1 * Math.sin(a), long };
});

/** The sandbox under the map: bundles of contour lines, a crosshair through the centre and the bearing ring. */
export function Contours() {
  return (
    <svg className={styles.contours} viewBox="0 0 400 400" aria-hidden="true">
      {CONTOURS.map((c) => (
        <path key={c.d} d={c.d} data-major={c.major || undefined} />
      ))}
      <path className={styles.cross} d="M200 24 V376 M24 200 H376" />
      {TICKS.map((t) => (
        <line key={`${t.x0}`} className={styles.tick} x1={t.x0} y1={t.y0} x2={t.x1} y2={t.y1} data-long={t.long || undefined} />
      ))}
    </svg>
  );
}

/** The table the watch lies on: a fine grid with heavier lines every fifth, fading out from the middle, far behind. */
export function Floor() {
  return <div className={styles.floor} aria-hidden="true" />;
}
