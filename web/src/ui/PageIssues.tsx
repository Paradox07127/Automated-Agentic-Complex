import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ErrBar } from './ErrBar';

/** One failed read a section hands to the page top. */
export interface PageIssue {
  /** 读的是什么，例如「会话」 */
  what: string;
  /** 原因 */
  reason: string;
  /** 下面旧数据的时间（epoch ms） */
  at?: number;
  retry?: () => void;
}

interface Ctx {
  offline: boolean;
  report: (id: string, issue: PageIssue | null) => void;
}

const IssuesCtx = createContext<Ctx | null>(null);
/** The data time each page banner shows: per failure reason, and the page's own offline banner under `null`. */
const BannerAtCtx = createContext<ReadonlyMap<string | null, number>>(new Map());

/** 页级错误去重：同一原因在页顶只出一条 ErrBar，区块里只留时间签；断开时页顶不写，交给外壳横幅。 */
export interface PageIssuesProps {
  /** 后台已断开：区块只加时间签 */
  offline?: boolean;
  /** 断开时页面自己的横幅写的数据时间（epoch ms） */
  at?: number;
  children: ReactNode;
}

export function PageIssues({ offline = false, at, children }: PageIssuesProps) {
  const [issues, setIssues] = useState<ReadonlyMap<string, PageIssue>>(new Map());
  const report = useCallback((id: string, issue: PageIssue | null) => {
    setIssues((prev) => {
      if (!issue && !prev.has(id)) return prev;
      const next = new Map(prev);
      if (issue) next.set(id, issue);
      else next.delete(id);
      return next;
    });
  }, []);
  const ctx = useMemo(() => ({ offline, report }), [offline, report]);
  const groups = new Map<string, PageIssue[]>();
  for (const i of issues.values()) groups.set(i.reason, [...(groups.get(i.reason) ?? []), i]);
  const bars = [...groups].map(([reason, list]) => {
    const ats = list.flatMap((i) => (i.at != null ? [i.at] : []));
    return { reason, list, staleAt: ats.length ? Math.min(...ats) : undefined };
  });
  const bannerAt = new Map<string | null, number>();
  if (offline && at != null) bannerAt.set(null, at);
  if (!offline) for (const b of bars) if (b.staleAt != null) bannerAt.set(b.reason, b.staleAt);
  return (
    <IssuesCtx.Provider value={ctx}>
      <BannerAtCtx.Provider value={bannerAt}>
        {!offline &&
          bars.map(({ reason, list, staleAt }) => {
            const whats = [...new Set(list.map((i) => i.what))].join('、');
            const retries = list.flatMap((i) => (i.retry ? [i.retry] : []));
            return <ErrBar key={reason} message={`读取${whats}失败：${reason}`} staleAt={staleAt} onRetry={retries.length ? () => retries.forEach((r) => r()) : undefined} />;
          })}
        {children}
      </BannerAtCtx.Provider>
    </IssuesCtx.Provider>
  );
}

/** The data time the page banner shows for a failure with `reason`, or for the offline banner with null. */
export const useBannerAt = (reason: string | null) => useContext(BannerAtCtx).get(reason);

/** The surrounding PageIssues, or null outside one. */
export const usePageIssues = () => useContext(IssuesCtx);

/** Hands `issue` to the page top while it is set; true when a PageIssues shows it there. */
export function usePageIssue(issue: PageIssue | null): boolean {
  const ctx = useContext(IssuesCtx);
  const id = useId();
  const retry = useRef(issue?.retry);
  retry.current = issue?.retry;
  const what = issue?.what;
  const reason = issue?.reason;
  const at = issue?.at;
  const canRetry = issue?.retry != null;
  useEffect(() => {
    if (!ctx) return;
    ctx.report(id, what != null && reason != null ? { what, reason, at, retry: canRetry ? () => retry.current?.() : undefined } : null);
  }, [ctx, id, what, reason, at, canRetry]);
  useEffect(() => () => ctx?.report(id, null), [ctx, id]);
  return ctx != null && !ctx.offline && issue != null;
}
