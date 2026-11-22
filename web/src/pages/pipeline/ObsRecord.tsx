import { useQuery } from '@tanstack/react-query';
import { AgentdCallError, get, seg } from '../../bridge/agentd';
import { serverFaultText } from '../../domain/errorText';
import { formatClock, fromObservationDetail, type ObservationDetail, type WireObservationDetail } from '../../domain';
import { RawFold } from '../../features/trace';
import { ErrBar, KV, Skel } from '../../ui';
import { MODE, OBS_REASON } from './labels';

/** agentd serves details only for these request ids (server.py `/diag/observations/<12 hex>`). */
export const OBS_ID = /^[0-9a-f]{12}$/;

const STATUS: Readonly<Record<string, string>> = {
  pending: '正在观察',
  ready: '看到了',
  declined: '被挡住',
  failed: '失败',
  expired: '超时',
  cancelled: '取消',
  unavailable: '看不到',
};

function reasonOf(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '读取失败';
  if (e.code === 'offline') return '后台已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.code === 'observation_not_found') return '这条观察已经不在后台内存里';
  if (e.code === 'observation_unavailable') return '后台没有开启观察';
  return e.status === 0 ? '请求没有发出' : `后台返回 ${e.status}`;
}

function summaryOf(d: ObservationDetail): string[] {
  const head = [MODE[d.mode] ?? d.mode, STATUS[d.status] ?? d.status, d.app].filter(Boolean).join(' │ ');
  const used = d.usedInLastTurn == null ? '' : d.usedInLastTurn ? '，最近一轮用了它' : '，最近一轮没用它';
  const ctx = `${d.current ? '读取时可用于上下文' : '读取时不可用于当前上下文'}${used}`;
  const desc = d.description != null ? '下面是视觉模型的描述，原始截图不保存在这里' : d.status === 'pending' ? '正在观察，还没有结果' : '没有可展开的视觉描述';
  return [head, ctx, desc];
}

const at = (ms: number | null, none: string) => (ms == null ? none : <span className="num">{formatClock(ms, { seconds: true })}</span>);

/** 一条观察请求的详情（GET /diag/observations/{id}）：摘要、字段、视觉模型的描述折叠。展开时才读，收起不留。 */
export function ObsRecord({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['pipeline', 'observation', id],
    queryFn: async () => fromObservationDetail(await get<WireObservationDetail>(`/diag/observations/${seg(id)}`)),
    retry: false,
    // A policy change drops the description agentd holds; never reopen on a cached copy.
    gcTime: 0,
  });
  const d = q.data;
  if (q.isError) return <ErrBar message={reasonOf(q.error)} onRetry={() => void q.refetch()} />;
  if (!d) return <Skel rows={3} />;
  return (
    <RawFold summary={summaryOf(d)} {...(d.description != null ? { raw: `${d.description}${d.truncated ? '\n…（只保留前 4000 字）' : ''}` } : {})} rawLabel="视觉描述">
      <KV
        items={[
          { key: '来源', value: d.app ?? '已遮蔽或不可见' },
          { key: '请求时间', value: at(d.requestedAt, '—') },
          { key: '观察时间', value: at(d.observedAt, '没有结果') },
          ...(d.reason ? [{ key: '原因', value: OBS_REASON[d.reason] ?? '其他原因' }] : []),
          { key: '请求', value: d.id, mono: true },
        ]}
      />
    </RawFold>
  );
}
