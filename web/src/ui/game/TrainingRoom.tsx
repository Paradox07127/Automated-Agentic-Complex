import { useState } from 'react';
import styles from './TrainingRoom.module.css';

type Seg = readonly [number, number, number, number];

/** The game's free-standing lattice seen from its 总览 camera, [x1, y1, x2, y2] in % of the screen. */
const LATTICE_OVERVIEW: readonly Seg[] = [
  [99.98, 29.03, 65.57, 33.79], [99.97, 21.9, 30.16, 33.65], [99.97, 10.86, 2.09, 31.85], [71.17, 0, 0.03, 21.01],
  [100, 28.94, 65.03, 0.02], [79.55, 33.18, 10.22, 0.02], [56.38, 33.99, 0.01, 15.03], [30.19, 33.65, 0.03, 25.82],
  [100, 17.64, 99.87, 0.04], [77.6, 78.04, 77.27, 0.02], [93.31, 82.87, 92.77, 0.04], [67.56, 80.58, 67.35, 0.02],
  [46.94, 78.75, 46.98, 0.04], [30.06, 77.25, 30.19, 33.36], [83, 87.42, 82.56, 0.03], [53.69, 84.09, 53.64, 0.01],
  [31.2, 81.54, 31.43, 0.03], [13.41, 79.52, 13.85, 0.01], [66.86, 94.53, 66.62, 0.03], [33.26, 89.26, 33.49, 0.06],
  [9.08, 85.47, 9.61, 0.03], [38.08, 99.96, 38.26, 0.01], [0.22, 97.63, 0.95, 0.06],
];

/** The same lattice from its 档案 camera: 0.9 m closer and turned 12.7°, so the room pans about 29 % left. */
const LATTICE_CLOSE: readonly Seg[] = [
  [99.97, 37.15, 39.17, 42.51], [99.95, 29.74, 0.1, 40.51], [100, 18.05, 0, 31.95], [84.08, 0.02, 0.04, 16.42],
  [99.28, 40.29, 94.86, 0], [75.83, 41.91, 36.35, 0], [53.36, 42.56, 0.01, 12.5], [29.48, 42.26, 0.03, 30.96],
  [0.13, 40.51, 0.02, 40.48], [99.62, 91.24, 98.49, 0.02], [73.84, 89.8, 73.31, 0.03], [51.38, 88.55, 51.35, 0],
  [98.95, 95.95, 97.78, 0.05], [67.92, 93.82, 67.5, 0.01], [41.63, 92.03, 41.82, 0.02], [19.07, 90.48, 19.77, 0.03],
  [0, 50.37, 0.13, 40.19], [97.86, 99.94, 96.67, 0.03], [58.92, 99.93, 58.7, 0.04], [27.3, 97.13, 27.85, 0.06],
  [1.14, 94.82, 2.29, 0.01], [95.8, 99.94, 94.66, 0.09], [43.63, 99.92, 43.79, 0.01], [4.22, 99.99, 5.36, 0.03],
  [90.95, 99.93, 89.93, 0.06], [12.07, 99.91, 13.02, 0.08],
];

/** Faint contour curves on the floor, in a box from the floor line down, 130 wide so the close camera can pan over it. */
const CONTOURS = [
  'M-2 58C8 54 13 49 11 45S2 40-2 42',
  'M24 66C34 58 48 54 62 52S84 45 96 41',
  'M76 38C82 31 98 30 104 35S100 47 89 46 71 45 76 38Z',
  'M14 82C18 75 29 74 31 79S23 88 14 82Z',
  'M40 96C54 86 70 83 88 85S114 82 132 76',
  'M102 62C110 56 118 63 132 57',
];

/** 训练场：角色页和 MMD 页内容区的灰色房间，照游戏 CharInfo 场景自绘，不随主题，用来对照看渲染。一面无缝渐变的墙、偏暗的地面和几条淡等高线、一架深色细线格架、角色灰度水印、几乎看不出的暗角；详情分区里她脚下一块柔和的灰影。全在模型画布下面，不接点击。 */
export interface TrainingRoomProps {
  /** 角色灰度大水印（`artSrc(id, 'charinfo-bg')`）；没有或读不出来时不画 */
  watermark?: string | undefined;
}

/**
 * The page sets the camera: `--room-floor-y` (the floor line, from the top; default 76.9 %) and `--room-close`
 * (0 the 总览 camera, 1 the closer 档案 one: its lattice, the floor panned left, her shadow, no watermark), and the
 * stage's span: `--room-stage-l`, `--room-stage-r` (insets from the room's sides, default 28 %) and `--room-stage-b` (from its bottom, default 0).
 */
export function TrainingRoom({ watermark }: TrainingRoomProps) {
  const [failed, setFailed] = useState<string>();
  return (
    <div className={styles.room} aria-hidden="true" data-training-room="" data-stub="TrainingRoom">
      <svg className={styles.floor} viewBox="0 0 130 100" preserveAspectRatio="none">
        {CONTOURS.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <svg className={styles.lattice} viewBox="0 0 100 100" preserveAspectRatio="none">
        {[LATTICE_OVERVIEW, LATTICE_CLOSE].map((segs, i) => (
          <g key={i} className={i ? styles.close : styles.overview}>
            {segs.map(([x1, y1, x2, y2]) => (
              <line key={`${x1} ${y1} ${x2} ${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ))}
      </svg>
      {watermark && watermark !== failed && <img className={styles.wm} src={watermark} alt="" onError={() => setFailed(watermark)} />}
      <div className={styles.scene}>
        <i className={styles.disk} />
      </div>
      <div className={styles.shade} />
    </div>
  );
}

export const TrainingRoomDemos: Array<{ name: string; props: TrainingRoomProps }> = [
  { name: 'default', props: {} },
];
