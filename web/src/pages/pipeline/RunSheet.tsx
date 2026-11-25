import { useQuery } from '@tanstack/react-query';
import { AgentdCallError, get, seg } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';
import { formatClock, formatMs } from '../../domain';
import { secToMs } from '../../domain/units';
import { RawFold } from '../../features/trace';
import { ErrBar, KV, SecHead, Sheet, Skel } from '../../ui';
import { StatusLamp } from '../../ui/game';
import { BACKEND, RUN_STATE, runLamp } from './labels';
import styles from './RunSheet.module.css';

/** GET /memory/runs/{id} (memory_service.py `get`); `detail` is null once redacted, `events` stay. */
interface WireRunDetail {
  run_id: string;
  backend: string;
  model: string;
  started_at: number;
  finished_at: number | null;
  state: string;
  prompt_version: string;
  redacted_reason: string | null;
  detail: {
    user_input: string;
    request: string;
    request_truncated: boolean;
    proposals: Array<{
      proposal: { operation: string; text?: string; evidence_quote?: string; target_quote?: string };
      receipt: { outcome?: string; fact_id?: string; error?: { code: string } };
    }>;
    output?: string | null;
  } | null;
  events: Array<{ seq: number; at: number; event: string } & Record<string, unknown>>;
}

/** Proposal operations (memory_service.py). */
const OP: Readonly<Record<string, string>> = { add: '新增', correct: '更正', forget: '删除' };
/** Receipt outcomes (memory_service.py `_change`, memory_pipeline.py). */
const OUTCOME: Readonly<Record<string, string>> = {
  stored: '已写入',
  candidate: '待确认',
  corrected: '已更正',
  forgotten: '已删除',
  unchanged: '已存在，未变更',
};
/** Why the detail was dropped (memory_service.py, integration.py `redact`). */
const REDACTED: Readonly<Record<string, string>> = {
  expired: '超过 48 小时',
  context_revoked: '来源权限已撤回',
  scope_revoked: '资料授权已撤回',
  context_changed: '隐私设置已变更',
  memory_changed: '关联记忆已更正或删除',
};
const PURPOSE: Readonly<Record<string, string>> = { memory_extract: '记忆提炼（后台整理）', conversation: '对话记录' };

function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'unknown_memory_run') return '该生成记录已不存在';
  if (e.code === 'no_memory') return '后台服务未开启记忆功能';
  return e.status === 0 ? '未能发送请求' : `后台服务返回状态码 ${e.status}`;
}

function rawOf(r: WireRunDetail): string {
  const parts = [`【操作回执】\n${r.events.map((e) => JSON.stringify(e)).join('\n')}`];
  if (r.detail?.output) parts.push(`【可见生成结果】\n${r.detail.output}`);
  if (r.detail?.request) parts.push(`【生成请求${r.detail.request_truncated ? '（已截取）' : ''}】\n${r.detail.request}`);
  return parts.join('\n\n');
}

/** The last reason code a failed or rejected run left in its events. */
const codeOf = (r: WireRunDetail) => [...r.events].reverse().find((e) => typeof e.reason === 'string' && e.reason)?.reason as string | undefined;

/** 生成记录：一批整理拿到了什么、提了什么、写进了什么。只在打开时读，关掉不留。 */
export function RunSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['pipeline', 'run-sheet', id],
    queryFn: () => get<WireRunDetail>(`/memory/runs/${seg(id ?? '')}`),
    enabled: id != null,
    retry: false,
    // The detail holds what the user said; nothing is kept after the sheet closes.
    gcTime: 0,
  });
  const r = q.data;
  const bad = r?.state === 'failed' || r?.state === 'rejected';
  const code = r && bad ? codeOf(r) : undefined;
  return (
    <Sheet open={id != null} title="生成记录" width={480} onClose={onClose}>
      {q.isError ? (
        <ErrBar message={reasonOf(q.error)} onRetry={() => void q.refetch()} />
      ) : !r ? (
        <Skel rows={5} />
      ) : (
        <div className={styles.sheet}>
          <KV
            items={[
              { key: '用途', value: PURPOSE[r.prompt_version.replace(/-v\d+$/, '')] ?? '其他用途' },
              { key: '开始', value: <span className="num">{formatClock(secToMs(r.started_at), { seconds: true })}</span> },
              { key: '结果', value: <StatusLamp {...runLamp(r.state)} /> },
              ...(r.finished_at != null ? [{ key: '用时', value: <span className="num">{formatMs(secToMs(r.finished_at - r.started_at))}</span> }] : []),
              { key: '内核', value: <span title={r.backend}>{BACKEND[r.backend] ?? '其他内核'}</span> },
              { key: '模型', value: r.model, mono: true },
              { key: '记录', value: r.run_id, mono: true },
            ]}
          />
          {bad && <ErrBar message={`${RUN_STATE[r.state] ?? '失败'}${code ? `（${code}）` : ''}`} />}
          {r.detail == null ? (
            <p className={styles.note}>详细内容已清理（{REDACTED[r.redacted_reason ?? ''] ?? '已过保留期'}），仅保留操作回执。</p>
          ) : (
            <>
              {r.detail.user_input && (
                <section className={styles.part}>
                  <SecHead title="本轮用户陈述" />
                  <p className={styles.quote}>{r.detail.user_input}</p>
                </section>
              )}
              <section className={styles.part}>
                <SecHead title="提炼候选项" count={r.detail.proposals.length} />
                {r.detail.proposals.length === 0 ? (
                  <p className={styles.note}>本次未产生待记录候选项</p>
                ) : (
                  <ol className={styles.list}>
                    {r.detail.proposals.map((p, i) => (
                      <li key={i} className={styles.item} data-bad={p.receipt.error ? '' : undefined}>
                        <span className={styles.caption}>{`候选 ${i + 1} │ ${OP[p.proposal.operation] ?? '其他操作'}`}</span>
                        <span className={styles.text}>{p.proposal.text || p.proposal.evidence_quote || '—'}</span>
                        {p.proposal.evidence_quote && p.proposal.evidence_quote !== p.proposal.text && <span className={styles.caption}>依据原文：{p.proposal.evidence_quote}</span>}
                        <span className={styles.result} title={p.receipt.error?.code}>
                          结果：{p.receipt.error ? '未通过校验' : (OUTCOME[p.receipt.outcome ?? ''] ?? '其他结果')}
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
