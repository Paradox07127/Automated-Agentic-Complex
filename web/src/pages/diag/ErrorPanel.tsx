// 诊断 › 总览 › 错误: the shell's error.jsonl and agentd's agentd-error.jsonl (`logs.errors`), one row per component and code
// with its total, last time and last message, newest first; a row opens its records, a record with a turn jumps to 对话轮次.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import type { ErrorRecordRow } from '../../bridge/logs';
import { formatClock } from '../../domain';
import { Btn, Region, SecHead } from '../../ui';
import type { NavTarget } from '../overview/nav';
import s from './ErrorPanel.module.css';

interface Group {
  key: string;
  total: number;
  /** Newest first; the first is the group's last. */
  records: ErrorRecordRow[];
}

function groupsOf(records: ErrorRecordRow[]): Group[] {
  const by = new Map<string, Group>();
  for (const r of [...records].sort((a, b) => b.at - a.at)) {
    const key = `${r.component} │ ${r.code}`;
    const g = by.get(key);
    if (g) {
      g.total += r.count;
      g.records.push(r);
    } else by.set(key, { key, total: r.count, records: [r] });
  }
  return [...by.values()];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The time alone today, with its date on another day. */
function when(at: number, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? formatClock(at) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(at)}`;
}

export function ErrorPanel({ now, go }: { now: number; go: (to: NavTarget) => void }) {
  const q = useQuery({ queryKey: ['diag', 'errors'], queryFn: () => getBridge().logs.errors(), retry: false });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const groups = q.data && groupsOf(q.data.records);
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  return (
    <>
      <SecHead title="错误" count={groups?.length} micro="ERROR RECORD" />
      <Region q={{ ...q, data: groups }} what="错误记录" reserve={{ rows: 3 }} empty={{ text: '没有错误记录' }}>
        {(list) => (
          <ul className={s.list} aria-label="错误">
            {list.map(({ key, total, records }) => {
              const last = records[0]!;
              return (
                <li key={key} className={s.group}>
                  <button type="button" className={s.head} aria-expanded={open.has(key)} onClick={() => toggle(key)}>
                    <b className={s.code}>{last.code}</b>
                    <span className={s.comp}>{last.component}</span>
                    <span className={`${s.n} num`}>×{total}</span>
                    <span className={`${s.at} num`}>{when(last.at, now)}</span>
                    <span className={s.msg}>{last.message}</span>
                  </button>
                  {open.has(key) && (
                    <ul className={s.recs} aria-label={key}>
                      {records.map((r, i) => {
                        const turn = r.trace_id ?? r.turn_id;
                        return (
                          <li key={i} className={s.rec}>
                            <span className={`${s.at} num`}>{when(r.at, now)}</span>
                            <span className={s.msg}>
                              {r.count > 1 && <span className={`${s.n} num`}>×{r.count}</span>}
                              {r.message}
                              {r.detail && <span className={s.detail}>{r.detail}</span>}
                            </span>
                            {turn && (
                              <Btn size="sm" variant="text" onClick={() => go({ page: 'diag', tab: 'turns', turn })}>
                                对话轮次 ›
                              </Btn>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Region>
    </>
  );
}
