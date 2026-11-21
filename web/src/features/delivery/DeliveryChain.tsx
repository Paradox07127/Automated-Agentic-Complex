import { formatClock, formatDuration, type Delivery } from '../../domain';
import { NodeChain, type ChainNode, type ChainSegment } from '../../charts';
import styles from './DeliveryChain.module.css';

/** 交付轨：产出 → 送达 → 查看 → 决定，段长按真实时长；验证来源和产物自检分格接在同一行末尾。 */
export interface DeliveryChainProps {
  /** 交付 */
  delivery: Delivery;
  /** 当前时间，算「等待 N m」开放段 */
  now: number;
  /** compact 用在抽屉和总览刚完成，段时长放第二行，默认 main */
  size?: 'main' | 'compact' | 'desk';
}

// "查看" is the viewed receipt for the detail view, not for the artifacts.
const LABELS = ['产出', '送达', '看过详情', '决定'] as const;
const TIPS = ['角色写出产物', '交付第一次出现在界面上', '你打开过任务详情或抽屉（不代表打开过产物）', '接受或驳回'] as const;

function nodesOf(d: Delivery): ChainNode[] {
  const ts = [d.produced_at, d.presented_at, d.viewed_at, d.decided_at];
  const last = ts.reduce<number>((acc, t, i) => (t != null ? i : acc), -1);
  const verdict = d.state === 'accepted' ? '已接受' : d.state === 'rejected' ? '已退回' : '';
  return LABELS.map((label, i) => {
    const t = ts[i];
    const waiting = t == null && i === last + 1 && i >= 2;
    const state: ChainNode['state'] =
      t != null ? (i === 3 && d.state === 'accepted' ? 'ok' : 'done') : waiting ? 'current' : 'todo';
    const sub = t != null ? `${i === 3 && verdict ? `${verdict} ` : ''}${formatClock(t)}` : waiting ? '待处理' : '—';
    return { label, state, sub, waiting, tip: `${label} │ ${t != null ? formatClock(t) : waiting ? '待处理' : '还没到'}\n${TIPS[i]}` };
  });
}

function segmentsOf(d: Delivery, now: number): ChainSegment[] {
  const ts = [d.produced_at, d.presented_at, d.viewed_at, d.decided_at];
  return [1, 2, 3].map((i) => {
    const a = ts[i - 1];
    const b = ts[i];
    if (a != null && b != null) return { weight: Math.max(1, (b - a) / 60_000), label: formatDuration(b - a) };
    if (a != null && b == null) return { weight: Math.max(1, (now - a) / 60_000), label: `等待 ${formatDuration(now - a)}`, open: true };
    return { weight: 1 };
  });
}

export function DeliveryChain({ delivery, now, size = 'main' }: DeliveryChainProps) {
  const arts = delivery.artifacts;
  const checked = arts.filter((a) => a.validation?.ok === true).length;
  const attempted = arts.filter((a) => a.self_checked).length;
  const hasResults = arts.some((a) => a.validation != null);
  const auto = delivery.verification_source === 'auto';
  return (
    <div data-stub="DeliveryChain" data-size={size} data-state={delivery.state} data-verify={delivery.verification_source} className={styles.root} aria-label="交付状态">
      <NodeChain nodes={nodesOf(delivery)} segments={segmentsOf(delivery, now)} size={size} label="交付状态" category="mission" />
      {size !== 'desk' && (
        <div className={styles.foot}>
          <span
            className={styles.verify}
            data-tone={auto ? 'ok' : 'warning'}
            title={auto ? '交付前已通过自动检查' : delivery.outcome === 'failed' ? '执行或产物检查失败，需要继续修复' : '尚未通过自动检查，结果需用户查看后再决定'}
          >
            {auto ? '✓ 已自动检查' : delivery.outcome === 'failed' ? '▲ 检查或执行失败' : '▲ 未验证'}
          </span>
          {arts.length > 0 && (
            <span className={styles.selfcheck}>
              产物
              <span className={styles.cells} role="img" aria-label={`${hasResults ? checked : attempted}/${arts.length} 个产物${hasResults ? '检查通过' : '尝试自检'}`}>
                {arts.map((a) => (
                  <i key={a.path} data-on={a.validation?.ok || undefined} title={`${a.name} │ ${a.validation ? a.validation.ok ? '检查通过' : '检查失败' : a.self_checked ? '尝试自检，结果未记录' : '未自检'}`} />
                ))}
              </span>
              <span className="num">{hasResults ? checked : attempted}</span>
              <small className={styles.den}>/{arts.length}</small> {hasResults ? '检查通过' : '尝试自检'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
