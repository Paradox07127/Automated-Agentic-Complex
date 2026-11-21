import { useQuery } from '@tanstack/react-query';
import { AgentdCallError, get, seg } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';
import { formatClock, formatMs } from '../../domain';
import { secToMs } from '../../domain/units';
import { RawFold } from '../../features/trace';
import { ErrBar, KV, Sheet, Skel } from '../../ui';
import { RUN_STATE, SUM_BACKEND, SUM_KIND } from './model';
import type { WireMemoryProposal, WireMemoryRunDetail } from './wire';
import styles from './RunSheet.module.css';

/** Proposal operations (memory_service.py). */
const OP: Readonly<Record<string, string>> = { add: '记下', correct: '更正', forget: '删除' };
/** Receipt outcomes (memory_service.py `_change`, memory_pipeline.py). */
const OUTCOME: Readonly<Record<string, string>> = {
  stored: '已记下',
  candidate: '待确认',
  corrected: '已更正',
  forgotten: '已删除',
  unchanged: '已有，没有变化',
};
/** Why the detail was dropped (memory_service.py, integration.py `redact`). */
const REDACTED: Readonly<Record<string, string>> = {
  expired: '超过 48 小时',
  context_revoked: '来源权限已撤回',
  scope_revoked: '资料授权已撤回',
  context_changed: '隐私设置变了',
  memory_changed: '相关记忆被更正或删除',
};

function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'unknown_memory_run') return '这条生成记录已经不在了';
  if (e.code === 'no_memory') return '后台没有开启记忆';
  return e.status === 0 ? '请求没有发出' : `后台返回 ${e.status}`;
}

const result = (p: WireMemoryProposal) => (p.receipt.error ? '没有通过校验' : (OUTCOME[p.receipt.outcome ?? ''] ?? '其他结果'));

function rawOf(r: WireMemoryRunDetail): string {
  const parts = [`【操作回执】\n${r.events.map((e) => JSON.stringify(e)).join('\n')}`];
  if (r.detail?.output) parts.push(`【可见生成结果】\n${r.detail.output}`);
  if (r.detail?.request) parts.push(`【生成请求${r.detail.request_truncated ? '（已截取）' : ''}】\n${r.detail.request}`);
  return parts.join('\n\n');
}

/** GET /memory/runs/{id}: what one memory generation run was given, what it proposed and what was written. Read only while open. */
export function MemoryRunSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['diag', 'memory-run', id],
    queryFn: () => get<WireMemoryRunDetail>(`/memory/runs/${seg(id ?? '')}`),
    enabled: id != null,
    retry: false,
    // The detail holds what the user said; nothing is kept after the sheet closes.
    gcTime: 0,
  });
  const r = q.data;
  const purpose = r ? SUM_KIND[r.prompt_version.replace(/-v\d+$/, '')] : undefined;
  return (
    <Sheet open={id != null} title="记忆生成记录" width={480} onClose={onClose}>
      {q.isError ? (
        <ErrBar message={reasonOf(q.error)} onRetry={() => void q.refetch()} />
      ) : !r ? (
        <Skel rows={5} />
      ) : (
        <div className={styles.sheet}>
          <KV
            items={[
              ...(purpose ? [{ key: '用途', value: purpose }] : []),
              { key: '开始', value: <span className="num">{formatClock(secToMs(r.started_at), { seconds: true })}</span> },
              { key: '结果', value: RUN_STATE[r.state] ?? '其他状态' },
              ...(r.finished_at != null ? [{ key: '用时', value: <span className="num">{formatMs(secToMs(r.finished_at - r.started_at))}</span> }] : []),
              { key: '内核', value: <span title={r.backend}>{SUM_BACKEND[r.backend] ?? '其他内核'}</span> },
              { key: '模型', value: r.model, mono: true },
            ]}
          />
          {r.detail == null ? (
            <p className={styles.note}>详细内容已清理（{REDACTED[r.redacted_reason ?? ''] ?? '已过保留期'}），只剩操作回执。</p>
          ) : (
            <>
              {r.detail.user_input && (
                <section className={styles.part}>
                  <h3 className={styles.head}>这一轮的用户陈述</h3>
                  <p className={styles.text}>{r.detail.user_input}</p>
                </section>
              )}
              <section className={styles.part}>
                <h3 className={styles.head}>提出要记的</h3>
                {r.detail.proposals.length === 0 ? (
                  <p className={styles.note}>这一次没有提出要记的内容</p>
                ) : (
                  <ol className={styles.list}>
                    {r.detail.proposals.map((p, i) => (
                      <li key={i} className={styles.item}>
                        <span className={styles.caption}>{`候选 ${i + 1} │ ${OP[p.proposal.operation] ?? '其他操作'}`}</span>
                        <span className={styles.text}>{p.proposal.text || p.proposal.evidence_quote || '—'}</span>
                        {p.proposal.evidence_quote && p.proposal.evidence_quote !== p.proposal.text && <span className={styles.caption}>依据原文：{p.proposal.evidence_quote}</span>}
                        <span className={styles.caption} title={p.receipt.error?.code}>
                          结果：{result(p)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
          <RawFold summary={[`${r.events.length} 条操作回执${r.detail?.request ? '，含生成请求原文' : ''}`]} raw={rawOf(r)} rawLabel="原始记录" />
        </div>
      )}
    </Sheet>
  );
}
