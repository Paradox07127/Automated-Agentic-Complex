import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { formatClock } from '../../domain';
import { navigate } from '../../shell/nav';
import type { PushToast } from '../../shell/toast';
import type { RowAction } from './Processes';
import type { ProcessKey } from './status';

export type RestartTarget = 'agentd' | 'avatar' | 'all';

const NAME: Record<'agentd' | 'avatar', string> = { agentd: '后台服务', avatar: '角色' };

/** The 运行记录 log source of a process row; voice runs inside agentd. */
const LOG_OF: Record<ProcessKey, string> = { agentd: 'agentd', avatar: 'avatar', voice: 'agentd', tunnel: 'tunnel' };

/** 查看日志 opens that process's log on the 运行记录 page. */
export const viewLogs = (key: ProcessKey) => navigate({ page: 'trace', tab: 'logs', src: LOG_OF[key] });

export const CONFIRM: Record<RestartTarget, { title: string; note: string; danger: boolean; label: string }> = {
  all: { title: '全部重启？', note: '依次重启 Companion、后台服务和角色。进行中的任务会中断，重启后不会自动重跑。', danger: true, label: '全部重启' },
  agentd: { title: '重启后台服务？', note: '进行中的任务会中断，重启后不会自动重跑。', danger: true, label: '重启后台服务' },
  avatar: { title: '重启角色？', note: '角色会消失几秒再出现，任务不受影响。', danger: false, label: '重启角色' },
};

/** A bridge op's rejection as one short reason; the shell may not implement the op. */
const why = (e: unknown) => ((e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本的窗口不支持' : '没有成功');

/** Restart and copy: every control shows progress in its row and ends with a toast. */
export function useDiagActions(now: number, toast: PushToast) {
  const qc = useQueryClient();
  const [actions, setActions] = useState<Partial<Record<ProcessKey, RowAction>>>({});
  const mark = useCallback((keys: ProcessKey[], a: RowAction) => setActions((x) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, a])) })), []);

  const restart = useCallback(
    (target: RestartTarget) => {
      const keys: ProcessKey[] = target === 'all' ? ['agentd', 'avatar'] : [target];
      mark(keys, { kind: 'restart', phase: 'busy', at: now });
      getBridge()
        .supervisor.restart(target)
        .then(() => {
          mark(keys, { kind: 'restart', phase: 'done', at: now, text: `✓ 已重启 │ ${formatClock(now)}` });
          toast(target === 'all' ? '已全部重启：Companion、后台服务、角色' : `已重启${NAME[target]}`, { severity: 'success' });
          void qc.invalidateQueries({ queryKey: ['diag', 'supervisor'] });
        })
        .catch((e: unknown) => {
          mark(keys, { kind: 'restart', phase: 'done', at: now, text: '■ 重启失败' });
          toast(`重启失败：${why(e)}`, { severity: 'danger', persistent: true });
        });
    },
    [mark, now, toast, qc],
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
