import type { Plan } from '../../domain';
import { SegMeter } from '../../charts';
import { Fraction, Spinner } from '../../ui';
import styles from './PlanProgress.module.css';

/** 计划进度：SegMeter + 「3/5」+「当前：<步骤>」；还没有计划写加载环；只有快照时 SegMeter 写「重连后显示步骤」，下面只写「已保存的计划」（落库的计划不带版本）。 */
export interface PlanProgressProps {
  /** 计划；null 表示还没有计划 */
  plan: Plan | null;
  /** 实时 / 只有落库快照，默认 live */
  source?: 'live' | 'snapshot';
  /** 快照且整体已完成：全部画满 */
  completed?: boolean;
  /** A terminal run cannot still be waiting for its first plan. */
  ended?: boolean;
  /** 已有运行；false 时整行隐藏 */
  hasRun?: boolean;
  /** 抽屉 288 宽 / 对话任务卡 / 列表行迷你，默认 drawer */
  size?: 'drawer' | 'card' | 'row';
  /** 在任务中打开 */
  onOpen?: () => void;
}

export function PlanProgress({ plan, source = 'live', completed, ended, hasRun = true, size = 'drawer', onOpen }: PlanProgressProps) {
  if (!hasRun) return null;
  if (plan == null) {
    return (
      <div data-stub="PlanProgress" data-source={source} data-size={size} className={styles.root}>
        <span className={styles.line}>
          {!ended && <Spinner label="正在等计划" />}
          <span className={styles.note}>{ended ? '运行已结束 │ 没有保存的计划' : '已在运行 │ 还没有计划'}</span>
        </span>
      </div>
    );
  }
  const snapshot = source === 'snapshot';
  const done = snapshot ? (completed ? plan.steps.length : null) : plan.steps.filter((s) => s.status === 'completed').length;
  const current = snapshot ? undefined : plan.steps.find((s) => s.status === 'in_progress' || s.status === 'waiting');
  return (
    <div data-stub="PlanProgress" data-source={source} data-size={size} data-completed={completed || undefined} className={styles.root}>
      <span className={styles.line}>
        <SegMeter
          steps={plan.steps}
          size={size === 'drawer' ? 'main' : 'mini'}
          snapshot={snapshot ? (completed ? 'complete' : 'unknown') : undefined}
          label="计划步骤"
          hideFraction
        />
        <Fraction value={done} total={plan.steps.length} label="步骤" />
      </span>
      {size !== 'row' && (
        <span className={styles.note}>
          {snapshot
            ? completed
              ? '已保存的计划 │ 已全部完成'
              : '已保存的计划'
            : `当前：${current?.text ?? '—'}`}
        </span>
      )}
      {onOpen && size !== 'row' && (
        <button type="button" className={styles.link} onClick={onOpen}>
          在任务中打开 │ 看运行瀑布 ↗
        </button>
      )}
    </div>
  );
}
