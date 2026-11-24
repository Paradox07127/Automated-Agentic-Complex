// 定时 tab data: GET /schedules and its writes, the scopes and conversations a task can use, and the trigger wording.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentdCallError, del, get, post, put, seg } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import type { ConversationsResponse } from '../../bridge/agentd-routes.generated';
import { failureText } from '../../domain/errorText';
import { formatClock } from '../../domain';
import { fromSchedule, weekdayLabel, type Schedule, type ScheduleTrigger, type WireSchedule } from '../../domain/schedules';
import type { DemoState } from '../../shell/demo';
import type { PushToast } from '../../shell/toast';
import type { WireScope } from '../settings/wire';

/** Why a schedule could not run or be saved, for the codes that name a fix. */
export function scheduleError(code: string | null): string | null {
  switch (code) {
    case 'scope_expired': return '资料授权已到期，编辑任务重新选资料';
    case 'scope_revoked': return '资料授权已撤销，编辑任务重新选资料';
    case 'unknown_scope': return '原资料范围已不可用，编辑任务重新选资料';
    case 'scope_changed': return '原资料已移动或替换，编辑任务重新选资料';
    case 'schedule_conversation_unavailable': return '原对话已不可用，编辑任务重新选对话';
    default: return null;
  }
}

export function scheduleErrMsg(e: unknown): string {
  if (e instanceof AgentdCallError) return scheduleError(e.code) ?? failureText(e).text;
  if (e instanceof Error && e.message) return e.message;
  return '操作没有完成，稍后再试';
}

export function useSchedules(state: DemoState | null, enabled: boolean) {
  return useQuery<Schedule[], Error>({
    queryKey: ['schedules', state],
    enabled: enabled && state !== 'loading',
    retry: false,
    queryFn: async () => {
      if (state === 'empty') return [];
      const res = await get<{ schedules: WireSchedule[] }>(`/schedules${!window.agenticComplex && state === 'error' ? '?fail=1' : ''}`).catch((e: unknown) => {
        throw new Error(scheduleErrMsg(e), { cause: e });
      });
      return res.schedules.map(fromSchedule);
    },
  });
}

export interface Choice {
  id: string;
  label: string;
}

/** Scopes still in force and conversations not archived: what a task or schedule may read and report to. */
export function useContextOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['schedule-context-options'],
    queryFn: async () => {
      const [scopes, conversations] = await Promise.all([
        get<{ scopes: Array<WireScope & { files?: Array<{ path: string }> }> }>('/agent/scopes'),
        get<ConversationsResponse>('/conversations'),
      ]);
      return {
        scopes: scopes.scopes
          .filter((s) => !s.revoked && s.expires_at * 1000 > appNow())
          .map((s): Choice & { expires: number } => ({ id: s.scope_id, label: [...s.roots, ...(s.files ?? [])].map((e) => e.path).join('、') || s.output.path, expires: s.expires_at * 1000 })),
        conversations: conversations.conversations.filter((c) => !c.archived).map((c): Choice => ({ id: c.id, label: c.title || '未命名对话' })),
      };
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export interface SchedulePayload {
  title: string;
  instruction: string;
  trigger: ScheduleTrigger;
  scope_id: string | null;
  conversation_id: string | null;
}

/** PUT enabled, POST run, DELETE, POST / PUT a schedule; each toasts its outcome and reads the list again, failed or not. */
export function useScheduleWrites(push: PushToast) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['schedules'] });
  // Each run request claims a fresh occurrence, so one schedule has at most one on its way.
  const sending = useRef(new Set<string>());
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const run = async <T,>(op: () => Promise<T>, done: string): Promise<T | null> => {
    try {
      const r = await op();
      push(done);
      return r;
    } catch (e) {
      push(scheduleErrMsg(e), { severity: 'danger' });
      return null;
    } finally {
      refresh();
    }
  };
  const runNow = async (s: Schedule) => {
    const id = s.schedule_id;
    if (sending.current.has(id)) return null;
    sending.current.add(id);
    setRunning(new Set(sending.current));
    try {
      return await run(() => post(`/schedules/${seg(id)}/run`, {}), `已开始运行「${s.title}」，在「进行中」里看`);
    } finally {
      sending.current.delete(id);
      setRunning(new Set(sending.current));
    }
  };
  return {
    toggle: (s: Schedule, on: boolean) => run(() => put(`/schedules/${seg(s.schedule_id)}`, { enabled: on }), on ? `已启用「${s.title}」` : `已暂停「${s.title}」`),
    runNow,
    running: (id: string) => running.has(id),
    remove: (s: Schedule) => run(() => del(`/schedules/${seg(s.schedule_id)}`), `已删除「${s.title}」`),
    /** Resolves with the schedule's id; null when it failed. */
    save: async (id: string | null, body: SchedulePayload) => {
      const r = await run(
        () => (id ? put<{ schedule: WireSchedule }>(`/schedules/${seg(id)}`, body) : post<{ schedule: WireSchedule }>('/schedules', { ...body, enabled: true })),
        id ? `已更新「${body.title}」` : `已新建「${body.title}」`,
      );
      return r ? (r.schedule?.schedule_id ?? id) : null;
    },
  };
}

const WORKDAYS = '1,2,3,4,5';

/** 「每个工作日 18:30」「每周一、三 09:00」「Codex │ app 会话结束后」. */
export function triggerText(t: ScheduleTrigger): string {
  if (t.kind === 'daily') {
    const days = [...new Set(t.weekdays)].sort((a, b) => a - b);
    const when = days.join() === WORKDAYS ? '每个工作日' : days.length === 7 ? '每天' : `每周${days.map(weekdayLabel).join('、')}`;
    return `${when} ${t.at}`;
  }
  if (t.kind === 'weekly') return `每周${weekdayLabel(t.weekday)} ${t.at}`;
  const tool = t.target === 'claude' ? 'Claude Code' : t.target === 'codex' ? 'Codex' : '编码';
  return `${tool}${t.project ? ` │ ${t.project}` : ''} 会话结束后`;
}

const DAY = 86_400_000;
const startOf = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** 「今天 18:30」「明天 09:00」「昨天 18:30」「11.18 周三 09:26」. */
export function dayText(ms: number, now: number): string {
  const diff = Math.round((startOf(ms) - startOf(now)) / DAY);
  const word = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : null;
  const d = new Date(ms);
  return `${word ?? `${d.getMonth() + 1}.${d.getDate()} 周${'日一二三四五六'[d.getDay()]}`} ${formatClock(ms)}`;
}

/** 「4 小时 16 分」 from minutes, rounded. */
export function spanText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}

/** Next run of a draft trigger from `now`; null when the time is not HH:MM or no day is picked. */
export function nextRun(t: ScheduleTrigger, now: number): number | null {
  if (t.kind === 'session_done' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.at)) return null;
  const [h = 0, m = 0] = t.at.split(':').map(Number);
  const days = t.kind === 'weekly' ? [t.weekday] : t.weekdays;
  for (let k = 0; k < 8; k += 1) {
    const d = new Date(now);
    d.setDate(d.getDate() + k);
    d.setHours(h, m, 0, 0);
    if (days.includes(d.getDay() || 7) && d.getTime() > now) return d.getTime();
  }
  return null;
}
