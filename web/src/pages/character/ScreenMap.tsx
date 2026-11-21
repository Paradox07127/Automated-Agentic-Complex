import styles from './Tune.module.css';

/** Range rectangles in the 320 × 200 sketch, by `beh.range` value. */
const RANGE: Record<string, { x: number; y: number; w: number; h: number }> = {
  fullscreen: { x: 6, y: 12, w: 308, h: 172 },
  default: { x: 6, y: 12, w: 308, h: 172 },
  window: { x: 96, y: 56, w: 150, h: 96 },
};

/** The fake bridge's screen; the host keeps the real geometry to itself (`/desktop/presence` is host_only). */
export const MOCK_SCREEN = { w: 1512, h: 982 };

export const rangeOf = (v: string) => RANGE[v] ?? RANGE.default!;

/** 屏幕示意图：窗口与窗沿、活动范围、角色此刻的位置。 */
export function ScreenMap({ range, stay }: { range: string; stay: boolean }) {
  const r = rangeOf(range);
  const k = MOCK_SCREEN.w / 320;
  const her = stay ? { x: 228, y: 178 } : { x: 96, y: 40 };
  return (
    <svg className={styles.map} viewBox="0 0 320 200" role="img" aria-label={`屏幕示意：活动范围 ${Math.round(r.w * k)} × ${Math.round(r.h * k)} pt，${stay ? '待在原地' : '自由活动'}`}>
      <rect x=".5" y=".5" width="319" height="199" rx="5" className={styles.scr} />
      <rect x=".5" y=".5" width="319" height="8" className={styles.mbar} />
      <rect x="110" y="188" width="100" height="10" rx="3" className={styles.dock} />
      <g className={styles.win}>
        <rect x="24" y="44" width="150" height="96" />
        <rect x="24" y="44" width="150" height="8" className={styles.tb} />
        <text x="30" y="65" className={styles.wt} aria-hidden="true">
          Terminal
        </text>
      </g>
      <g className={styles.win}>
        <rect x="150" y="76" width="150" height="100" />
        <rect x="150" y="76" width="150" height="8" className={styles.tb} />
        <text x="156" y="97" className={styles.wt} aria-hidden="true">
          Xcode
        </text>
      </g>
      <line x1="24" x2="174" y1="44" y2="44" className={styles.rail} />
      <line x1="174" x2="300" y1="76" y2="76" className={styles.rail} />
      {/* At the rail's right end: the top-left corner belongs to the 活动范围 tag. */}
      <text x="170" y="40" textAnchor="end" className={styles.rl}>
        窗沿
      </text>
      <text x="250" y="72" className={styles.rl}>
        窗沿
      </text>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} className={styles.rb} />
      <rect x={r.x + 4} y={r.y + 4} width="58" height="18" className={styles.rlb} />
      <text x={r.x + 9} y={r.y + 18} className={styles.rlt}>
        活动范围
      </text>
      <g className={styles.her} transform={`translate(${her.x} ${her.y})`}>
        <circle cx="0" cy="-12" r="3.4" />
        <path d="M-3.5 -8h7l1.5 8h-10z" />
      </g>
    </svg>
  );
}
