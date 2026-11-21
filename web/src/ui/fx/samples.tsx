import { RadialFill } from './RadialFill';
import { Stage3D } from './Stage3D';
import styles from './samples.module.css';

// Small stand-ins of the game layouts whose data-g keys the generated clips drive; used by the GameClip demos.

/** Watch face (watch_in01 / watch_out): rings, triangles, side frames, logo and the right-hand key groups. */
export function WatchSample() {
  return (
    <Stage3D w={400} h={340}>
      <div className={styles.watch} data-g="watch">
        <span className={styles.dots} data-g="dots" />
        <span className={`${styles.ring} ${styles.out}`} data-g="outRing" />
        <span className={styles.center} data-g="yellowRing">
          <RadialFill amount={1} size={188} thickness={2} tone="ring-yellow" />
        </span>
        <span className={`${styles.ring} ${styles.main}`} data-g="mainRing" />
        <span className={`${styles.ring} ${styles.blue}`} data-g="blueRing" />
        <span className={styles.center} data-g="yellowLine">
          <RadialFill amount={0.1} size={160} thickness={4} origin="right" tone="yellow" />
        </span>
        <span className={styles.tris} data-g="triangles">
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <i key={a} style={{ rotate: `${a}deg` }} />
          ))}
        </span>
        <span className={styles.decoOut} data-g="decoOut">
          <i />
          <i />
        </span>
        <span className={styles.logo} data-g="logo" />
        <span className={styles.groups}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={styles.key} data-g={`group${n}`} />
          ))}
        </span>
      </div>
    </Stage3D>
  );
}

/** Quick menu wheel (quickmenu_in): centre stack, deco cycles, the filling main cycle and the side nodes. */
export function WheelSample() {
  return (
    <Stage3D w={400} h={300}>
      <div className={styles.wheel}>
        <span className={styles.side} data-g="left" />
        <span className={`${styles.side} ${styles.sideR}`} data-g="right" />
        <span className={styles.center} data-g="center">
          <span className={styles.roundBg} data-g="roundBg" />
          <span className={`${styles.ring} ${styles.cycle3}`} data-g="cycle3" />
          <span className={`${styles.ring} ${styles.cycle2}`} data-g="cycle2" />
          <span className={`${styles.ring} ${styles.cycle1}`} data-g="cycle1" />
          <span className={styles.center} data-g="mainCycle">
            <RadialFill amount={1} size={128} thickness={3} tone="white" g="cycle4" />
            <span className={styles.spoke} data-g="content" />
          </span>
        </span>
      </div>
    </Stage3D>
  );
}

/** Watch key (Animator keyboard_btn, Highlighted): shadow plate, face, icon and label that float toward the viewer. */
export function KeySample() {
  return (
    <Stage3D w={120} h={120}>
      <span className={styles.btn} data-g="btn">
        <span className={styles.btnShadow} />
        <span className={styles.face} data-g="face" />
        <span className={styles.icon} data-g="icon" />
        <span className={styles.label} data-g="label">
          任务
        </span>
      </span>
    </Stage3D>
  );
}
