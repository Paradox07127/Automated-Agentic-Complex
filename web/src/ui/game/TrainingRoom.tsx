import { useId, useState } from 'react';
import styles from './TrainingRoom.module.css';

const HORIZON = 62;
/** Seams between the nine wall panels; a darker line halves each panel but the middle one. */
const WALL_X = Array.from({ length: 8 }, (_, i) => 11 * (i + 1));
const WALL_DIM_X = [5.5, 16.5, 27.5, 38.5, 60.5, 71.5, 82.5, 93.5];
const WALL_Y = [12, 27, 44];
const WALL_DIM_Y = [19.5, 35.5];
const FLOOR_Y = [66, 72, 81, 94];
/** Where the perspective lines meet the room's bottom edge, in stage widths (0–100 is the stage). */
const FLOOR_X = [-200, -114, -45, 5, 95, 145, 214, 300];
/** 3 × 4 dots, two left empty as in the game. */
const DOTS = [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1];

/** 训练场：角色页和 MMD 页内容区的浅灰房间，不随主题，用来对照看渲染。墙面竖板顶光、地面透视线、脚下两圈光椭圆、角色灰度水印、× 点阵、准星圆、暗角，全在模型画布下面，不接点击。 */
export interface TrainingRoomProps {
  /** 角色灰度大水印（`artSrc(id, 'charinfo-bg')`）；没有或读不出来时不画 */
  watermark?: string | undefined;
}

/**
 * The stage's span sets where her floor, rings, watermark, dots and crosshair go: the page sets
 * `--room-stage-l`, `--room-stage-r` (insets from the room's sides, default 28 %) and `--room-stage-b` (from its bottom, default 0).
 */
export function TrainingRoom({ watermark }: TrainingRoomProps) {
  const panel = `tr-panel${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const glow = `${panel}-glow`;
  const [failed, setFailed] = useState<string>();
  return (
    <div className={styles.room} aria-hidden="true" data-training-room="" data-stub="TrainingRoom">
      <svg className={styles.lines} viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id={panel} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="0.35" stopColor="#fff" stopOpacity="0.1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className={styles.panels} fill={`url(#${panel})`}>
          {[0, ...WALL_X].map((x, i) => (
            <rect key={x} x={x && x + 0.4} y={0} width={i === WALL_X.length ? 100 - x - 0.4 : 10.6} height={HORIZON} />
          ))}
        </g>
        {WALL_DIM_X.map((x) => (
          <line key={`d${x}`} className={styles.dim} x1={x} y1={0} x2={x} y2={HORIZON} />
        ))}
        {WALL_DIM_Y.map((y) => (
          <line key={`e${y}`} className={styles.dim} x1={0} y1={y} x2={100} y2={y} />
        ))}
        {WALL_X.map((x) => (
          <line key={`v${x}`} x1={x} y1={0} x2={x} y2={HORIZON} />
        ))}
        {WALL_Y.map((y) => (
          <line key={`h${y}`} x1={0} y1={y} x2={100} y2={y} />
        ))}
        {FLOOR_Y.map((y) => (
          <line key={`g${y}`} className={styles.floorh} x1={0} y1={y} x2={100} y2={y} />
        ))}
        <line className={styles.horizon} x1={0} y1={HORIZON} x2={100} y2={HORIZON} />
      </svg>
      <svg className={styles.persp} viewBox="0 0 100 100" preserveAspectRatio="none">
        {FLOOR_X.map((x) => (
          <line key={x} x1={50} y1={HORIZON} x2={x} y2={100} />
        ))}
      </svg>
      <div className={styles.scene}>
        {watermark && watermark !== failed && <img className={styles.wm} src={watermark} alt="" onError={() => setFailed(watermark)} />}
        <span className={styles.dots}>
          {DOTS.map((on, i) => (
            <i key={i}>{on ? '×' : ''}</i>
          ))}
        </span>
        <svg className={styles.reticle} viewBox="0 0 300 300">
          <circle cx={150} cy={150} r={120} strokeWidth={1.2} />
          <circle cx={150} cy={150} r={86} strokeDasharray="2 6" />
          <circle cx={150} cy={150} r={10} />
          <path d="M0 150h120M180 150h120M150 0v120M150 180v120" />
          <path d="M150 26v12M150 262v12M26 150h12M262 150h12" strokeWidth={1.5} />
          <rect x={118} y={112} width={18} height={10} />
        </svg>
        <svg className={styles.rings} viewBox="0 0 100 20" preserveAspectRatio="none">
          <defs>
            <radialGradient id={glow}>
              <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse className={styles.pool} cx={50} cy={10} rx={30} ry={5.5} fill={`url(#${glow})`} />
          <ellipse cx={50} cy={10} rx={49} ry={9} />
          <ellipse cx={50} cy={10} rx={30} ry={5.5} />
        </svg>
      </div>
      <div className={styles.shade} />
    </div>
  );
}

export const TrainingRoomDemos: Array<{ name: string; props: TrainingRoomProps }> = [
  { name: 'default', props: {} },
];
