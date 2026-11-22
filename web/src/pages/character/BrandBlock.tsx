import { MicroLabel } from '../../ui/game';
import styles from './BrandBlock.module.css';

/** 总览右侧的黄色斜块（游戏 CharInfo 右侧压重）：只有竖排品牌字、斜纹和半调点，不放数据、不接点击，在舞台矩形之外。 */
export function BrandBlock() {
  return (
    <div className={styles.yb} data-g="detail" aria-hidden="true">
      <span className={styles.shape} />
      <span className={styles.edge} />
      <span className={styles.rule} />
      <span className={styles.brand}>
        <span className={`${styles.w} ${styles.o}`}>AGENTIC COMPLEX</span>
        <span className={`${styles.w} ${styles.s}`}>AGENTIC COMPLEX</span>
        <span className={styles.w2}>
          <MicroLabel>Desktop Agent</MicroLabel>
        </span>
      </span>
      <span className={styles.orn}>
        <i />
        <MicroLabel>Charinfo</MicroLabel>
      </span>
    </div>
  );
}
