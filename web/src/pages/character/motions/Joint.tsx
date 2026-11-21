import { BAND_TEXT, gapBand, type Joint as J } from './chainPath';
import styles from './MotionDetail.module.css';

const num = (x: number, d: number) => String(Math.round(x * 10 ** d) / 10 ** d);

/** One joint between two poses: a band coloured by the gap (≤8, ≤25, ≤40, >40 cm, or 未测) over the gap and the blend seconds. */
export function Joint({ joint, blend }: { joint: J; blend?: number | null }) {
  const band = gapBand(joint.gap);
  const s = blend !== undefined ? blend : joint.blend;
  const gap = joint.gap == null ? '未测' : `${num(joint.gap, 1)} cm`;
  const mix = s == null ? '—' : `${num(s, 2)} s`;
  return (
    <span className={styles.joint} data-band={band} data-joint="" title={`${BAND_TEXT[band]} │ 混合 ${mix}`} aria-label={`衔接 ${gap}，混合 ${mix}`}>
      <i className={styles.band} aria-hidden="true" />
      <span className={styles.gap}>{gap}</span>
      <span className={styles.mix}>{mix}</span>
    </span>
  );
}
