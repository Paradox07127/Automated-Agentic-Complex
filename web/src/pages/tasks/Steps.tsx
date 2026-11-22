// 步骤 (QuestCell list): the plan's steps on a rail; the step she waits on carries the decision papers, and while one is
// open the steps already done fold into one cell so the decision is on the first screen.
import { useState, type ReactNode } from 'react';
import type { PlanStep } from '../../domain';
import detail from './Detail.module.css';
import styles from './Steps.module.css';

function StepIcon({ status }: { status: PlanStep['status'] }) {
  if (status === 'completed')
    return (
      <svg viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="10" fill="var(--tk-bg0)" />
        <circle cx="11" cy="11" r="9" fill="none" stroke="var(--tk-ok)" strokeWidth="2" strokeDasharray="44 6" />
        <path d="M6.5 11.5l3 3 6-6.5" fill="none" stroke="var(--tk-ok)" strokeWidth="2.4" />
      </svg>
    );
  if (status === 'failed')
    return (
      <svg viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="10" fill="var(--tk-bg0)" />
        <circle cx="11" cy="11" r="9" fill="none" stroke="var(--tk-danger)" strokeWidth="2" />
        <path d="M7.5 7.5l7 7M14.5 7.5l-7 7" stroke="var(--tk-danger)" strokeWidth="2.4" />
      </svg>
    );
  if (status === 'in_progress') return <span className={styles.ring} aria-hidden="true" />;
  if (status === 'waiting') return <span className={styles.dia} aria-hidden="true" />;
  return <span className={styles.sq} aria-hidden="true" />;
}

const WORD: Record<PlanStep['status'], string> = { completed: '做完了', in_progress: '在做', waiting: '待你决定', failed: '没做成', pending: '还没开始' };

function Cell({ status, children }: { status: PlanStep['status']; children: ReactNode }) {
  return (
    <div className={styles.q} data-s={status} role="listitem" aria-label={WORD[status]}>
      <div className={styles.qi}>
        <StepIcon status={status} />
      </div>
      <div className={styles.qb}>{children}</div>
    </div>
  );
}

export interface StepsProps {
  steps: PlanStep[];
  /** Papers for the step she waits on; with none of her steps waiting they get a step of their own. */
  decision: { title: string; note: string; papers: ReactNode } | null;
  /** Ended tasks start folded behind 展开. */
  folded?: boolean;
}

export function Steps({ steps, decision, folded = false }: StepsProps) {
  const [open, setOpen] = useState(false);
  const done = steps.filter((s) => s.status === 'completed');
  const waiting = steps.findIndex((s) => s.status === 'waiting');
  const at = decision ? (waiting >= 0 ? waiting : steps.findIndex((s) => s.status === 'in_progress')) : -1;
  const shown: Array<PlanStep & { wait?: boolean }> = steps.map((s, i) => (i === at ? { ...s, status: 'waiting', wait: true } : s));
  if (decision && at < 0) shown.push({ text: decision.title, status: 'waiting', since: null, wait: true });
  if (shown.length === 0) return null;
  const total = steps.length;
  const toggle = <button type="button" onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</button>;
  if (folded && !open)
    return (
      <div className={detail.sh}>
        步骤<span className="num">{total ? `${done.length} / ${total}` : ''}</span>
        <span className={detail.r}>{toggle}</span>
      </div>
    );
  // While a decision is open the finished steps fold into one cell, so the decision needs no scrolling.
  const fold = decision != null && !open && done.length > 0;
  const list = fold ? shown.filter((s) => s.status !== 'completed') : shown;
  return (
    <>
      <div className={detail.sh}>
        步骤<span className="num">{total ? `${done.length} / ${total}` : ''}</span>
        {(folded || (decision && open)) && <span className={detail.r}>{toggle}</span>}
      </div>
      <div className={styles.steps} role="list" aria-label="步骤">
        {fold && (
          <Cell status="completed">
            <div className={styles.d}>
              前 <span className="num">{done.length}</span> 步做完了
              <small>{done.map((s) => s.text).join('、')}</small>
            </div>
            <button type="button" className={styles.unfold} onClick={() => setOpen(true)}>
              展开
            </button>
          </Cell>
        )}
        {list.map((s, i) => (
          <Cell key={`${i}-${s.text}`} status={s.status}>
            <div className={styles.d}>
              {s.text}
              {s.wait && decision ? <small>{decision.note}</small> : s.detail && <small>{s.detail}</small>}
              {s.wait && decision?.papers}
            </div>
          </Cell>
        ))}
      </div>
    </>
  );
}
