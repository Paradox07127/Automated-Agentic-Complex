import type { BeltTone } from './model';
import styles from './Belt.module.css';

/** 传送带（游戏 InBeltCell）：中性灰带体、上下细线、▶ 行进（下游在跑才走）、末端竖挡；下游出错红斜纹、堵住橙斜纹（都带 ⊘）、暂停灰斜纹不动。只表达状态，不能点。 */
export interface BeltProps {
  /** 带子上方的一行小字 */
  label?: string;
  flow: boolean;
  tone: BeltTone;
}

export function Belt({ label, flow, tone }: BeltProps) {
  return (
    <span className={styles.belt} data-flow={(flow && tone == null) || undefined} data-tone={tone ?? undefined} aria-hidden="true">
      {label && <span className={styles.label}>{label}</span>}
      <span className={styles.body} />
      <span className={styles.arrows} />
      {(tone === 'fail' || tone === 'block') && <i className={styles.stop} />}
    </span>
  );
}

/** 合流带：上道从「理解」来（观察记录），下道从「对话、任务结果」来源牌出发，两道都进整理。 */
export function MergeBelt({ flow, tone }: Omit<BeltProps, 'label'>) {
  return (
    <span className={styles.merge}>
      <span className={styles.lane} data-at="up">
        <Belt label="观察记录" flow={flow} tone={tone} />
      </span>
      <span className={styles.lane} data-at="low">
        <Belt flow={flow} tone={tone} />
      </span>
      <span className={styles.src}>对话、任务结果</span>
    </span>
  );
}
