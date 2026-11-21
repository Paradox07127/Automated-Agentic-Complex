import { InfoTip } from './InfoTip';
import styles from './Missing.module.css';

/** 字段级缺值：后台没有、没读到写「—」加可聚焦的 ⓘ；不适用写一个词，不写破折号。 */
export interface MissingProps {
  /** unsupported：后台不提供；failed：这次没读到；na：业务上本来就没有 */
  why: 'unsupported' | 'failed' | 'na';
  /** failed 时是原因；na 时是要写的词（不需要 / 无 / 未设置），默认「无」 */
  reason?: string;
}

export function Missing({ why, reason }: MissingProps) {
  if (why === 'na') {
    return (
      <span className={styles.word} data-stub="Missing" data-why="na">
        {reason ?? '无'}
      </span>
    );
  }
  return (
    <span className={styles.missing} data-stub="Missing" data-why={why}>
      <span className={styles.dash}>—</span>
      <InfoTip label="为什么没有值">{why === 'unsupported' ? '后台暂不提供' : `没读到：${reason ?? '原因不明'}`}</InfoTip>
    </span>
  );
}

export const MissingDemos: Array<{ name: string; props: MissingProps }> = [
  { name: 'unsupported', props: { why: 'unsupported' } },
  { name: 'failed', props: { why: 'failed', reason: '后台拒绝访问' } },
  { name: 'na', props: { why: 'na', reason: '不需要' } },
];
