import styles from './Skel.module.css';

/** 加载骨架：形状随区块（行、卡片、图表、整块、头像行），aria-busy，浅色光带扫过；still 和减少动态时不动。「读取中」写在页头，这里默认不写字。 */
export interface SkelProps {
  /** 行数或卡片数，默认 4 */
  rows?: number;
  /** 给了才在骨架上方写一行字；读屏名称默认「正在读取」 */
  label?: string;
  /** 形状，默认 rows；avatar 是头像加两行字的列表行 */
  shape?: 'rows' | 'cards' | 'chart' | 'block' | 'avatar';
  /** rows 每行的高（px），默认 14 的文字行；列表行骨架给行高，行铺满宽 */
  height?: number;
}

export function Skel({ rows = 4, label, shape = 'rows', height }: SkelProps) {
  return (
    <div className={styles.skel} aria-busy="true" role="status" aria-label={label ?? '正在读取'} data-stub="Skel" data-rows={rows} data-shape={shape}>
      {label && <span className={styles.label}>{label}</span>}
      <SkelShapes rows={rows} shape={shape} height={height} />
    </div>
  );
}

/** The skeleton's shapes alone, for a container that already says it is busy (Region). */
export function SkelShapes({ rows = 4, shape = 'rows', height }: Omit<SkelProps, 'label'>) {
  if (shape === 'cards')
    return (
      <span className={styles.cards}>
        {Array.from({ length: rows }, (_, i) => (
          <i key={i} className={styles.card} aria-hidden="true" />
        ))}
      </span>
    );
  if (shape === 'chart') return <i className={styles.chart} aria-hidden="true" />;
  if (shape === 'block') return <i className={styles.block} aria-hidden="true" />;
  if (shape === 'avatar')
    return (
      <>
        {Array.from({ length: rows }, (_, i) => (
          <span key={i} className={styles.avatar} data-skel="avatar" aria-hidden="true">
            <i className={styles.face} />
            <i className={styles.bar} style={{ width: `${70 - ((i * 13) % 30)}%` }} />
            <i className={styles.bar} style={{ width: `${45 - ((i * 7) % 20)}%` }} />
          </span>
        ))}
      </>
    );
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} className={styles.bar} style={height ? { width: '100%', height } : { width: `${92 - ((i * 17) % 40)}%` }} aria-hidden="true" />
      ))}
    </>
  );
}

export const SkelDemos: Array<{ name: string; props: SkelProps }> = [
  { name: 'default', props: {} },
  { name: 'cards', props: { shape: 'cards', rows: 2 } },
  { name: 'chart', props: { shape: 'chart' } },
  { name: 'labelled', props: { rows: 2, label: '正在读取步骤…' } },
  { name: 'block', props: { shape: 'block' } },
  { name: 'avatar', props: { shape: 'avatar', rows: 3 } },
  { name: 'list-rows', props: { rows: 3, height: 58 } },
];
