// 观察简报（character_agent/routes/observation_briefs_http.py）：列表、单份、不再显示、现在生成。
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { AgentdCallError, del, get, post, seg } from '../../bridge/agentd';
import type { ObservationBriefsResponse } from '../../bridge/agentd-routes.generated';
import { errorText } from './data';

export type Brief = ObservationBriefsResponse['reports'][number];
/** GET /observation/briefs/:id: the whole report, or only its state while it is not a completed one. */
export type BriefStatus = Partial<Brief> & { id: string; state: string };

const LIST = ['observe', 'briefs'] as const;

const REASON: Readonly<Record<string, string>> = {
  brief_busy: '已有一份简报正在生成，稍后再试',
  brief_disabled: '简报没有开启，或观察已关闭、暂停',
  brief_period_incomplete: '这段时间还没过完',
  brief_period_expired: '这段时间的观察记录已经清理',
  brief_not_found: '这份简报已经不在了',
  observation_briefs_unavailable: '后台的简报模块没有运行',
};

export const briefError = (e: unknown): string => (e instanceof AgentdCallError && REASON[e.code]) || errorText(e);

export function useBriefs() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: LIST, queryFn: () => get<ObservationBriefsResponse>('/observation/briefs'), retry: false, refetchOnWindowFocus: false });
  // observation_briefs.py publishes when a report is written, dismissed or deleted; 现在生成 answers before the model is done.
  useEffect(
    () =>
      getBridge().feed.subscribe(
        (e) => {
          if (e.event !== 'observation_brief') return;
          void qc.invalidateQueries({ queryKey: LIST });
          // An invalidated, dismissed or deleted report's text must not stay on screen; `deleted` names no id.
          const { id } = JSON.parse(e.data) as { id?: string };
          void qc.resetQueries({ queryKey: id ? ['observe', 'brief', id] : ['observe', 'brief'] });
        },
        () => void qc.invalidateQueries({ queryKey: LIST }),
      ),
    [qc],
  );
  // agentd sends them by end time, newest first; a week ends with its Sunday's daily.
  const reports = [...(list.data?.reports ?? [])].sort((a, b) => b.end - a.end || a.period.localeCompare(b.period));
  const dismiss = async (id: string) => {
    await del<{ id: string; state: string }>(`/observation/briefs/${seg(id)}`);
    qc.setQueryData<ObservationBriefsResponse>(LIST, (d) => d && { ...d, reports: d.reports.filter((r) => r.id !== id) });
  };
  /** Yesterday's daily; agentd writes it in the background and answers 202 at once. */
  const generate = async (period = 'daily', date?: string) => {
    await post<{ id: string; state: string }>('/observation/briefs', { period, ...(date ? { date } : {}), retry: true });
    void qc.invalidateQueries({ queryKey: LIST });
  };
  return { list, reports, settings: list.data?.settings ?? null, dismiss, generate };
}

export function useBrief(id: string | null) {
  return useQuery({
    queryKey: ['observe', 'brief', id],
    queryFn: () => get<BriefStatus>(`/observation/briefs/${seg(id ?? '')}`),
    enabled: id != null,
    retry: false,
    // The text quotes what was observed; nothing is kept after the sheet closes.
    gcTime: 0,
  });
}
