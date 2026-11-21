import { TraceLine, type TraceLineProps } from './TraceLine';
import styles from './TraceGroup.module.css';

/** 轨迹组：一行组头（图标、标题、描述、状态、时长）下挂若干 TraceLine，可展开，键盘同 TraceLine。 */
export interface TraceGroupProps extends Omit<TraceLineProps, 'children'> {
  /** 组内各行 */
  items: TraceLineProps[];
}

export function TraceGroup({ items, desc, ...head }: TraceGroupProps) {
  return (
    <div data-stub="TraceGroup" className={styles.root}>
      <TraceLine {...head} desc={desc ?? `${items.length} 步`}>
        <div role="group" aria-label={head.title} className={styles.list}>
          {items.map((it, i) => (
            <TraceLine key={`${i}-${it.title}`} {...it} />
          ))}
        </div>
      </TraceLine>
    </div>
  );
}
