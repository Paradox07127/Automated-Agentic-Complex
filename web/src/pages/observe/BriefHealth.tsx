import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import { get, post } from '../../bridge/agentd';
import type { ObservationBriefsResponse } from '../../bridge/agentd-routes.generated';
import { Btn, ErrBar } from '../../ui';
import { toast } from '../../shell/toast';
import { briefError } from './useBriefs';

const STATE: Record<string, string> = { completed: '已生成', empty: '无可用资料', queued: '排队中', running: '正在生成',
  failed: '生成失败', interrupted: '生成中断', cancelled: '已取消' };
const ERROR: Record<string, string> = { invalid_brief_shape: '输出结构不符合要求', invalid_brief_evidence: '引用未通过逐字核验',
  unsupported_brief_recurrence: '反复出现的依据不足', usage_cap: '已达用量上限', timeout: '生成超时',
  brief_sources_changed: '生成期间来源或授权发生变化', invalid_semantic_json: '模型未返回有效 JSON',
  semantic_repair_budget: '结构修复已达到本次限额', semantic_output_limit: '输出超过长度上限' };

/** Settings groups can also render outside the query-backed page host. */
export function useBriefHealth(enabled: boolean) {
  const [data, setData] = useState<ObservationBriefsResponse | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => { if (enabled) void get<ObservationBriefsResponse>('/observation/briefs').then((v) => live && setData(v), () => {}); };
    read();
    const off = getBridge().feed.subscribe((e) => { if (e.event === 'observation_brief') read(); }, read);
    return () => { live = false; off(); };
  }, [enabled]);
  const generate = async (period: string, date: string) => {
    await post('/observation/briefs', { period, date, retry: true });
    setData(await get<ObservationBriefsResponse>('/observation/briefs'));
  };
  return { data: enabled ? data : null, generate };
}

/** Switches express intent; this readout shows only a failed or interrupted production and its bounded retry state. */
export function BriefHealth({ attempts, onRetry }: { attempts: ObservationBriefsResponse['attempts'] | undefined;
  onRetry: (period: string, date: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const latest = ['daily','weekly'].flatMap((period) => attempts?.find((a) => a.period === period) ?? []);
  const retry = async (a: (typeof latest)[number]) => {
    setBusy(a.id);
    try { await onRetry(a.period,a.date); toast('已请求重新生成，用量上限仍然生效'); }
    catch (e) { toast(`重试失败：${briefError(e)}`); }
    finally { setBusy(null); }
  };
  const failed = latest.filter((a) => a.state === 'failed' || a.state === 'interrupted');
  if (failed.length === 0) return null;
  return <div aria-label="简报生成状态" role="status">{failed.map((a) => <div key={a.id} title={a.validation_path ? `失败的输出字段：${a.validation_path}` : undefined}>
    <ErrBar message={[`${a.period === 'daily' ? '日报' : '周报'} ${a.date}`, STATE[a.state] ?? a.state, `已尝试 ${a.attempts} 次`,
      a.error_code && (ERROR[a.error_code] ?? '后台生成未完成'),
      a.automatic_retry && a.retry_at != null ? `${new Date(a.retry_at * 1000).toLocaleString()} 后自动重试` : a.can_retry ? '自动重试已停止' : null].filter(Boolean).join(' │ ')}
      extra={a.can_retry && <Btn size="sm" variant="text" disabled={busy != null} loading={busy === a.id} onClick={() => void retry(a)}>重试这一期</Btn>} />
  </div>)}</div>;
}
