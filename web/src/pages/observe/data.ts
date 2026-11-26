// 观察页读的接口，按 agentd 发来的样子；逻辑从记忆页「她看到的」复制过来，不 import memory 目录。
import { useMemo } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { AgentdCallError, BRIDGE_REFUSED, CONFLICT_CODES, get } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import { serverFaultText } from '../../domain/errorText';
import { activityLabel, isoToMs, isoToMsOrNull, secToMs, type WireContextBlock, type WireDiagBudget, type WireObservation } from '../../domain';

export const KEY = {
  diag: ['observe', 'diag'],
  task: ['observe', 'task'],
  episodes: ['observe', 'episodes'],
  attention: ['observe', 'attention'],
  browser: ['observe', 'browser'],
  blacklist: ['observe', 'blacklist'],
  memory: ['observe', 'memory'],
} as const;

export const pageNow = appNow;

/** No native bridge: the fake bridge serves the mocks. */
export const isMock = (): boolean => window.agenticComplex == null;

/** Page-specific hash query next to the shell's demo flags. */
export function usePageParams(): URLSearchParams {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => new URLSearchParams(search), [search]);
}

/** The /diag/state blocks this page reads. */
export interface WireDiagSeen {
  context?: WireContextBlock;
  budget?: Pick<WireDiagBudget, 'screenshots'>;
  observation?: Partial<WireObservation> & {
    recent?: Array<{
      request_id: string;
      mode: string;
      state: string;
      reason: string | null;
      at: string;
    }>;
  };
  proactive?: { focus: { category: string; dwell_s: number } | null } | null;
}

/** task_understanding.py `context()`; both sources include hypothesis state and epoch-second timestamps. */
export interface WireTaskUnderstanding {
  available: boolean;
  reason: string | null;
  hypotheses: Array<{
    id: string;
    revision: number;
    state: string;
    created_at: number;
    expires_at: number;
    task: string;
    goal?: string;
    next_step?: string;
  }>;
}

/** blacklist.py v1. */
export type BlacklistField = 'bundle_ids' | 'app_names' | 'domains' | 'title_patterns';
export type WireBlacklist = Record<BlacklistField, string[]> & {
  version: number;
  incognito: boolean;
};

/** `GET /memory` facts: only what the episode detail needs. */
export interface WireFactRef {
  fact_id: string;
  text: string;
  evidence: string[];
}

export const readDiag = () => get<WireDiagSeen>('/diag/state');
export const readTask = () => get<WireTaskUnderstanding>('/task-understanding');

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day as `/episodes?date=` takes it. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayStart(day: string): number {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** The `ep` URL value: `{id}`, or `{id}@{YYYY-MM-DD}` when it came from a fact's evidence. */
export function parseEp(ep: string | null): { id: string; date: string | null } | null {
  if (!ep) return null;
  const [id = '', date] = ep.split('@');
  return { id, date: date ?? null };
}

/** server.py CLEARABLE plus `lore`, which only the turn itself drops. */
const ITEM_LABEL: Readonly<Record<string, string>> = {
  view: '截图',
  window_text: '窗口文字',
  page: '页面文字',
  selection: '选中文字',
  lore: '设定资料',
};
const CLEARABLE = new Set(['view', 'window_text', 'page', 'selection']);
const MODE_LABEL: Readonly<Record<string, string>> = {
  image: '截图',
  text: '窗口文字',
  ocr: '识别文字',
};
const REASON_LABEL: Readonly<Record<string, string>> = {
  blacklisted: '命中排除名单',
  incognito: '无痕窗口，始终排除',
  budget: '截图额度已满',
  timeout: '超时',
  paused: '观察暂停中',
};

export interface ContextItem {
  type: string;
  label: string;
  clearable: boolean;
}

export interface ObsRequest {
  id: string;
  at: number;
  mode: string;
  ok: boolean;
  text: string;
}

export interface NowData {
  focus: { app: string; title: string; dwellS: number | null } | null;
  activity: { code: string; label: string; corrected: boolean } | null;
  items: ContextItem[];
  screenshots: {
    used: number;
    reserved: number;
    released: number;
    limit: number;
  } | null;
  recent: ObsRequest[];
}

/** Null when the reply has no context block. */
export function nowOf(w: WireDiagSeen | undefined): NowData | null {
  const c = w?.context;
  if (!c) return null;
  return {
    focus: c.window?.app
      ? {
          app: c.window.app,
          title: c.window.title?.head ?? '',
          dwellS: w?.proactive?.focus?.dwell_s ?? null,
        }
      : null,
    activity: c.activity && {
      code: c.activity.activity,
      label: activityLabel(c.activity.activity),
      corrected: c.activity.corrected,
    },
    items: c.items
      .filter((i) => !i.expired)
      .map((i) => ({
        type: i.type,
        label: ITEM_LABEL[i.type] ?? '其他上下文',
        clearable: CLEARABLE.has(i.type),
      })),
    screenshots: w?.budget?.screenshots ?? null,
    recent: (w?.observation?.recent ?? []).map((r) => ({
      id: r.request_id,
      at: isoToMs(r.at),
      mode: r.mode,
      ok: r.state === 'ready',
      text: r.state === 'ready' ? (MODE_LABEL[r.mode] ?? '屏幕识读') : `已拦截 │ ${(r.reason && REASON_LABEL[r.reason]) ?? '未完成'}`,
    })),
  };
}

/** `observation.paused_until` as epoch ms. */
export const pausedUntilOf = (w: WireDiagSeen | undefined): number | null => isoToMsOrNull(w?.observation?.paused_until);

export interface TaskGuess {
  id: string;
  revision: number;
  task: string;
  expiresAt: number | null;
}

/** The newest hypothesis still standing: agentd lists only live ones (active or corrected, unexpired), newest first. */
export function taskGuessOf(w: WireTaskUnderstanding | undefined): TaskGuess | null {
  const h = w?.available ? w.hypotheses.find((x) => x.state !== 'rejected') : undefined;
  return h
    ? {
        id: h.id,
        revision: h.revision,
        task: h.task,
        expiresAt: h.expires_at == null ? null : secToMs(h.expires_at),
      }
    : null;
}

/** Facts whose evidence cites this episode (`episode:{id}@{date}`). */
export const memoriesOf = (facts: ReadonlyArray<WireFactRef>, id: string): WireFactRef[] => facts.filter((f) => f.evidence.some((r) => r.startsWith(`episode:${id}@`)));

export type ExKind = 'app' | 'site' | 'title';
export interface ExRule {
  field: BlacklistField;
  kind: ExKind;
  value: string;
}

const KIND_OF: Record<BlacklistField, ExKind> = {
  bundle_ids: 'app',
  app_names: 'app',
  domains: 'site',
  title_patterns: 'title',
};
export const FIELD_OF: Record<ExKind, BlacklistField> = {
  app: 'app_names',
  site: 'domains',
  title: 'title_patterns',
};

export function rulesOf(b: WireBlacklist | undefined): ExRule[] {
  if (!b) return [];
  const fields: BlacklistField[] = ['app_names', 'bundle_ids', 'domains', 'title_patterns'];
  return fields.flatMap((field) => (b[field] ?? []).map((value) => ({ field, kind: KIND_OF[field], value })));
}

export const ruleLabel = (r: ExRule) => (r.kind === 'title' ? `窗口标题含「${r.value}」` : r.value);

const REASON: Readonly<Record<string, string>> = {
  unknown_fact: '该条目已不存在',
  no_episodes: '活动记录未开启',
  unknown_episode: '该活动片段已不存在',
  evidence_expired: '出处仅保留 48 小时，现已清理',
  task_understanding_unavailable: '任务推断功能未开启',
  task_hypothesis_changed: '该任务推断已变更',
  no_attention: '观察功能未开启',
  invalid_range: '时间范围无效',
  invalid_payload: '请求内容无效',
};

/** One short line for a failed request; never the raw JSON. */
export function errorText(e: unknown): string {
  if (!(e instanceof AgentdCallError)) return '操作未完成';
  if (e.code === 'offline') return '后台服务已断开';
  const fault = serverFaultText(e);
  if (fault) return fault;
  if (e.status === 409 || CONFLICT_CODES.has(e.code)) return '数据已在别处更新';
  if (BRIDGE_REFUSED.has(e.code)) return '当前窗口无权发送此请求';
  return REASON[e.code] ?? `后台服务未接受（${e.status}）`;
}
