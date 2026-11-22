import styles from './TrainingRoom.module.css';

const HORIZON = 62;
const WALL_X = Array.from({ length: 9 }, (_, i) => 11 * (i + 1));
const WALL_Y = [12, 27, 44];
const FLOOR_X = [-60, -22, 8, 30, 70, 92, 122, 160];

/** 训练场：页面内容区的浅灰房间（墙面网格、地面透视线），不随主题，用来对照看渲染。 */
export function TrainingRoom() {
  return (
    <div className={styles.room} aria-hidden="true" data-training-room="">
      <svg className={styles.lines} viewBox="0 0 100 100" preserveAspectRatio="none">
        {WALL_X.map((x) => (
          <line key={`d${x}`} className={styles.dim} x1={x - 5.5} y1={0} x2={x - 5.5} y2={HORIZON} />
        ))}
        {WALL_X.map((x) => (
          <line key={`v${x}`} x1={x} y1={0} x2={x} y2={HORIZON} />
        ))}
        {WALL_Y.map((y) => (
          <line key={`h${y}`} x1={0} y1={y} x2={100} y2={y} />
        ))}
        {FLOOR_X.map((x) => (
          <line key={`f${x}`} className={styles.floor} x1={50} y1={HORIZON} x2={x} y2={100} />
        ))}
        <line className={styles.horizon} x1={0} y1={HORIZON} x2={100} y2={HORIZON} />
      </svg>
    </div>
  );
}
