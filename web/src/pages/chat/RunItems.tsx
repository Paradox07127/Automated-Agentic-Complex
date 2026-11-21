import { AgentdCallError } from '../../bridge/agentd';
import { formatClock, formatMs, secToMs, type WireRunItem } from '../../domain';
import { Btn, ErrBar, Icon, Skel } from '../../ui';
import { useRunItems } from './useChatData';
import styles from './RunItems.module.css';

const STATUS: Readonly<Record<string, string>> = { started: '执行中', in_progress: '执行中', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

function ToolReceipt({ call, result }: { call: WireRunItem; result?: WireRunItem }) {
  const [open, setOpen] = useState(false);
  const outcome = result?.summary ?? call.summary;
  const status = /\bfailed\b/i.test(outcome ?? '') ? 'failed' : result?.status ?? call.status;
  const statusLabel = STATUS[status] ?? status;
  return (
    <div className={styles.receipt}>
      <button type="button" aria-label={`${call.name ?? '工具调用'}，${statusLabel}，查看工具回执`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="tool" size={16} />
        <b>{call.name ?? '工具调用'}</b>
        <span className={styles.status} data-failed={status === 'failed' || undefined}>{statusLabel}</span>
      </button>
      {open && <dl className={styles.details}>
        <dt>开始</dt><dd>{formatClock(secToMs(call.created_at), { seconds: true })}</dd>
        {status !== 'started' && status !== 'in_progress' && <><dt>耗时</dt><dd>{formatMs(Math.max(0, secToMs(call.updated_at - call.created_at)))}</dd></>}
        {call.summary && <><dt>调用</dt><dd>{call.summary}</dd></>}
        {result?.summary && result.summary !== call.summary && <><dt>结果</dt><dd>{result.summary}</dd></>}
      </dl>}
    </div>
  );
}

/** Read the persisted run items on demand. Only summaries published by the ledger are shown. */
export function RunItems({ runId, running = false }: { runId: string; running?: boolean }) {
  const q = useRunItems(runId, undefined, running);
  const calls = (q.data ?? []).filter((i) => i.kind === 'tool_call');
  const results = new Map((q.data ?? []).filter((i) => i.kind === 'tool_result' && i.parent_item_id).map((i) => [i.parent_item_id, i]));
  const missing = q.error instanceof AgentdCallError && q.error.status === 404;
  return (
    <section className={styles.root} aria-label="工具调用">
      <header><h3>工具调用</h3>{calls.length > 0 && <span>{calls.length} 次</span>}</header>
      {q.isPending ? <Skel rows={2} /> : missing ? <p>此轮没有保留工具记录。</p> : q.isError ? (
        <ErrBar message="工具记录读取失败" onRetry={() => void q.refetch()} />
      ) : calls.length === 0 ? <p>还没有工具调用记录。</p> : calls.map((call) => {
        const result = results.get(call.item_id);
        return <ToolReceipt key={call.item_id} call={call} {...(result ? { result } : {})} />;
      })}
      {calls.length > 0 && <Btn variant="text" size="sm" loading={q.isFetching} onClick={() => void q.refetch()}>刷新工具记录</Btn>}
    </section>
  );
}
import { useState } from 'react';
