import type { PlanStep, StepStatus } from '../domain';
import { stateVisual } from '../domain';
import common from './chart.module.css';
import styles from './SegMeter.module.css';

/** 分格计量：已完成填墨，当前格墨描边，等你格黄块 ◆，失败格黄块加墨框；主窗口 >16 格改连续条，桌面 >12 格只写分数；旁边必写「3/5」。 */
export interface SegMeterProps {
  /** 步骤（text + status） */
  steps: PlanStep[];
  /** 类别（角色任务 mission、编码 neutral）；只写进 data-category，格子颜色只表示状态 */
  category?: 'mission' | 'neutral';
  /** 格 6 / 4 / 6 px；desk 上限 12 格，默认 main */
  size?: 'main' | 'mini' | 'desk';
  /** 只有快照：unknown 全画空格并标「重连后显示步骤」，complete 全满 */
  snapshot?: 'unknown' | 'complete';
  /** 读屏前缀，默认「步骤」 */
  label?: string;
  /** 不画自带的「3/5」：调用方旁边已有 Fraction */
  hideFraction?: boolean;
}

const MAX_CELLS = { main: 16, mini: 16, desk: 12 } as const;

/** Cell kind of one step under the snapshot rule. */
export function cellKind(status: StepStatus, snapshot?: 'unknown' | 'complete'): StepStatus {
  if (snapshot === 'complete') return 'completed';
  if (snapshot === 'unknown') return 'pending';
  return status;
}

export function SegMeter({ steps, category = 'mission', size = 'main', snapshot, label = '步骤', hideFraction }: SegMeterProps) {
  const kinds = steps.map((s) => cellKind(s.status, snapshot));
  const n = steps.length;
  const done = kinds.filter((k) => k === 'completed').length;
  const curIdx = kinds.findIndex((k) => k === 'in_progress' || k === 'waiting' || k === 'failed');
  const cur = curIdx >= 0 ? steps[curIdx] : undefined;
  const curKind = curIdx >= 0 ? kinds[curIdx] : undefined;
  const shown = snapshot === 'unknown' ? '—' : String(done);
  const aria = `${label} ${snapshot === 'unknown' ? '逐步状态未知' : `${done}/${n}`}${cur && curKind ? `，${stateVisual(curKind).label}：${cur.text}` : ''}`;
  const mode = n > MAX_CELLS[size] ? (size === 'desk' ? 'fraction' : 'bar') : 'cells';
  const pad = String(n).length < 2 ? 2 : String(n).length;
  return (
    <span role="img" data-stub="SegMeter" data-category={category} data-size={size} data-snapshot={snapshot} data-mode={mode} className={styles.root} aria-label={aria}>
      {mode === 'cells' && (
        <span className={styles.cells} aria-hidden="true">
          {steps.map((s, i) => {
            const k = kinds[i] ?? 'pending';
            const tip = `${String(i + 1).padStart(pad, '0')} │ ${s.text}\n${snapshot === 'unknown' ? '逐步状态未知' : stateVisual(k).label}${s.detail ? `\n${s.detail}` : ''}`;
            return <i key={i} className={`${styles.cell} ${common.tip}`} data-kind={k} data-tip={tip} />;
          })}
        </span>
      )}
      {mode === 'bar' && (
        <span className={styles.bar} aria-hidden="true">
          <i className={styles.barFill} style={{ width: `${(done / n) * 100}%` }} />
          {Array.from({ length: n - 1 }, (_, i) => (
            <b key={i} className={styles.barTick} style={{ left: `${((i + 1) / n) * 100}%` }} />
          ))}
        </span>
      )}
      {!hideFraction && (
        <span className={styles.frac} aria-hidden="true">
          {shown}
          <small>/{n}</small>
        </span>
      )}
      {cur && curKind === 'waiting' && size === 'main' && <span className={styles.waitText}>◆ 待处理</span>}
      {cur && curKind === 'failed' && size === 'main' && <span className={styles.failText}>✕ 失败</span>}
      {snapshot === 'unknown' && size !== 'desk' && <span className={styles.note}>重连后显示步骤</span>}
    </span>
  );
}

const step = (text: string, status: StepStatus): PlanStep => ({ text, status, since: null });
const many = (n: number, done: number): PlanStep[] => Array.from({ length: n }, (_, i) => step(`第 ${i + 1} 步`, i < done ? 'completed' : i === done ? 'in_progress' : 'pending'));

export const SegMeterDemos: Array<{ name: string; props: SegMeterProps }> = [
  { name: 'plan', props: { steps: [step('读取 10 月账单', 'completed'), step('按类别归类', 'completed'), step('汇总金额', 'in_progress'), step('生成开销表', 'pending'), step('自检', 'pending')] } },
  { name: 'waiting', props: { category: 'neutral', size: 'mini', steps: [step('改代码', 'completed'), step('跑测试', 'waiting'), step('提交', 'pending')] } },
  { name: 'waiting-main', props: { category: 'neutral', steps: [step('改代码', 'completed'), step('跑测试', 'waiting'), step('提交', 'pending')] } },
  { name: 'failed', props: { steps: [step('下载索引', 'completed'), step('解析资源', 'failed'), step('写入报告', 'pending')] } },
  { name: 'snapshot', props: { snapshot: 'unknown', steps: [step('一', 'pending'), step('二', 'pending'), step('三', 'pending')] } },
  { name: 'complete', props: { snapshot: 'complete', steps: [step('一', 'pending'), step('二', 'pending'), step('三', 'pending'), step('四', 'pending')] } },
  { name: 'zero', props: { steps: [step('读取', 'pending'), step('整理', 'pending'), step('输出', 'pending')] } },
  { name: 'over-16', props: { steps: many(22, 9) } },
  { name: 'desk-over-12', props: { size: 'desk', steps: many(14, 5) } },
  { name: 'desk', props: { size: 'desk', category: 'neutral', steps: many(6, 2) } },
];
