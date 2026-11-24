import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import type { ProcessState, ServiceId, SupervisorTarget } from '../../bridge/protocol';
import { formatClock } from '../../domain';
import { navigate } from '../../shell/nav';
import type { PushToast } from '../../shell/toast';
import { parseChild, type ProcessKey } from './status';
import { clock } from './useDiag';

export type RestartTarget = 'agentd' | 'avatar' | 'all';

/** Per-row action state after the user acted: restart in flight, or done. */
export type RowAction = { kind: 'restart'; phase: 'busy' | 'done'; at: number; text?: string };

const NAME: Record<'agentd' | 'avatar', string> = { agentd: '后台服务', avatar: '角色' };

/** The 日志 tab's source of a process row; voice runs inside agentd, the services share one log. */
const LOG_OF: Record<ProcessKey, string> = { agentd: 'agentd', avatar: 'avatar', voice: 'agentd', tts: 'services', motion: 'services', llm: 'services' };

/** 查看日志 opens that process's log on the 日志 tab. */
export const viewLogs = (key: ProcessKey) => navigate({ page: 'diag', tab: 'logs', src: LOG_OF[key] });

/** A service's row in 设置 › 服务. */
export const serviceSettings = (key: ServiceId) => navigate({ page: 'settings', group: 'services', item: `svc_${key}` });

export const CONFIRM: Record<RestartTarget, { title: string; note: string; danger: boolean; label: string }> = {
  all: { title: '全部重启？', note: '依次重启后台服务和角色。进行中的任务会中断，重启后不会自动重跑。', danger: true, label: '全部重启' },
  agentd: { title: '重启后台服务？', note: '进行中的任务会中断，重启后不会自动重跑。', danger: true, label: '重启后台服务' },
  avatar: { title: '重启角色？', note: '角色会消失几秒再出现，任务不受影响。', danger: false, label: '重启角色' },
};

/** A bridge op's rejection as one short reason; the shell may not implement the op. */
export const why = (e: unknown) => ((e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本的窗口不支持' : '没有成功');

/** How long a dispatched restart waits for supervisor.state to show the process up again. */
const RESTART_WAIT_MS = 60_000;

/** One restart the shell took: each process's state and pid when it was asked, and how each came back. */
interface Restart {
  target: RestartTarget;
  keys: SupervisorTarget[];
  from: Partial<Record<SupervisorTarget, ProcessState>>;
  result: Partial<Record<SupervisorTarget, 'ok' | 'failed'>>;
  timer?: ReturnType<typeof setTimeout>;
}

const names = (keys: SupervisorTarget[]) => keys.map((k) => NAME[k]).join('、');

/** Restart and copy: every control shows progress in its row and ends with a toast. A restart is done when
 *  supervisor.state (`sup`) shows the process running with a new pid, or failed. */
export function useDiagActions(now: number, toast: PushToast, sup: Partial<Record<SupervisorTarget, ProcessState>> | null) {
  const qc = useQueryClient();
  const [actions, setActions] = useState<Partial<Record<ProcessKey, RowAction>>>({});
  const mark = useCallback((keys: ProcessKey[], a: RowAction) => setActions((x) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, a])) })), []);
  // Every entry point goes through `restart`: a process in here is not asked again.
  const inFlight = useRef(new Map<SupervisorTarget, Restart>());
  const supRef = useRef(sup);
  supRef.current = sup;

  const settle = useCallback(
    (r: Restart, key: SupervisorTarget, result: 'ok' | 'failed' | 'unseen') => {
      if (inFlight.current.get(key) !== r) return;
      inFlight.current.delete(key);
      r.result[key] = result === 'ok' ? 'ok' : 'failed';
      const at = clock();
      mark([key], { kind: 'restart', phase: 'done', at, text: result === 'ok' ? `✓ 已重启 │ ${formatClock(at)}` : result === 'failed' ? '■ 重启失败' : '■ 没看到重启' });
      if (r.keys.some((k) => !r.result[k])) return;
      clearTimeout(r.timer);
      const ok = r.keys.filter((k) => r.result[k] === 'ok');
      const bad = r.keys.filter((k) => r.result[k] !== 'ok');
      if (bad.length === 0) toast(r.target === 'all' ? `已全部重启：${names(ok)}` : `已重启${names(ok)}`, { severity: 'success' });
      else toast([ok.length ? `已重启${names(ok)}` : '', `${names(bad)}没有重新起来`].filter(Boolean).join('；'), { severity: 'danger', persistent: true });
    },
    [mark, toast],
  );

  useEffect(() => {
    if (!sup) return;
    for (const [key, r] of [...inFlight.current]) {
      const s = sup[key], from = r.from[key];
      if (!s) continue;
      const kind = parseChild(s.state).kind;
      if (kind === 'running' && s.pid != null && s.pid !== from?.pid) settle(r, key, 'ok');
      else if ((kind === 'failed' || kind === 'portInUse') && s.state !== from?.state) settle(r, key, 'failed');
    }
  }, [sup, settle]);
  useEffect(() => {
    const pending = inFlight.current;
    return () => pending.forEach((r) => clearTimeout(r.timer));
  }, []);

  const restart = useCallback(
    (target: RestartTarget) => {
      const keys: SupervisorTarget[] = target === 'all' ? ['agentd', 'avatar'] : [target];
      const busy = keys.filter((k) => inFlight.current.has(k));
      if (busy.length > 0) return void toast(`${names(busy)}正在重启`);
      const r: Restart = { target, keys, from: Object.fromEntries(keys.map((k) => [k, supRef.current?.[k]])), result: {} };
      for (const k of keys) inFlight.current.set(k, r);
      mark(keys, { kind: 'restart', phase: 'busy', at: now });
      getBridge()
        .supervisor.restart(target)
        .then(() => {
          // The shell only dispatched it; the rows wait for supervisor.state.
          void qc.invalidateQueries({ queryKey: ['diag', 'supervisor'] });
          if (keys.some((k) => inFlight.current.get(k) === r)) r.timer = setTimeout(() => keys.forEach((k) => settle(r, k, 'unseen')), RESTART_WAIT_MS);
        })
        .catch((e: unknown) => {
          for (const k of keys) if (inFlight.current.get(k) === r) inFlight.current.delete(k);
          mark(keys, { kind: 'restart', phase: 'done', at: now, text: '■ 重启失败' });
          toast(`重启失败：${why(e)}`, { severity: 'danger', persistent: true });
        });
    },
    [mark, now, toast, qc, settle],
  );

  /** The shell builds the report itself; it holds no conversation text. */
  const copyDiag = useCallback(() => {
    getBridge()
      .app.action('copy_diagnostics')
      .then(() => toast('诊断信息已复制（不含对话内容）'))
      .catch((e: unknown) => toast(`复制失败：${why(e)}`, { severity: 'danger' }));
  }, [toast]);

  return { actions, restart, copyDiag };
}
