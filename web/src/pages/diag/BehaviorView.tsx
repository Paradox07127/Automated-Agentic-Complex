// 诊断 › 行为决策: her state and her behavior decisions on one time axis.
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { formatClock } from '../../domain';
import { useDemo } from '../../shell/demo';
import { BottomBarSlot, PageHeaderSlot } from '../../shell/headerSlot';
import { Btn, ErrBar, Spinner } from '../../ui';
import { StatusLamp } from '../../ui/game';
import { failure, readBeats, readHistory, readState, resetState } from '../character/api';
import { pageNow, useFeedback } from '../character/feedback';
import { DOWN } from '../character/Page';
import { Behavior, type Range } from './Behavior';
import styles from './Behavior.module.css';

const DAY = 24 * 3600_000;
/** readBeats asks agentd for at most this many decisions, newest first. */
const BEAT_LIMIT = 200;

const startOf = (range: Range, now: number) => (range === 'today' ? new Date(now).setHours(0, 0, 0, 0) : now - DAY);

export function BehaviorView({ tabs }: { tabs: ReactNode }) {
  const { state, demo } = useDemo();
  const fb = useFeedback();
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>('today');
  const now = pageNow();
  // Page clock of the last state read: where the curves stop when agentd goes away.
  const [readAt, setReadAt] = useState<number>();
  const cs = useQuery({
    queryKey: ['character', 'state'],
    queryFn: async () => {
      const s = await readState();
      setReadAt(pageNow());
      return s;
    },
  });
  const log = useQuery({ queryKey: ['character', 'history', '24h'], queryFn: () => readHistory('24h', pageNow()) });
  const beats = useQuery({ queryKey: ['character', 'beats', range], queryFn: () => readBeats(startOf(range, pageNow())) });
  const conn = useQuery({ queryKey: ['agentd', 'connection'], queryFn: () => getBridge().agentd.connection() });
  const sup = useQuery({ queryKey: ['supervisor', 'state'], queryFn: () => getBridge().supervisor.state() });

  const avatarState = demo === 'offline' ? 'stopped' : sup.data?.avatar?.state;
  const offline = avatarState != null && DOWN.test(avatarState);
  const disconnected = conn.data === 'offline' || [cs.error, log.error].some((e) => e != null && failure(e).kind === 'offline');
  const stateError = state === 'error' || (cs.isError && !disconnected);
  const none = state === 'empty' || cs.data === null;
  const charState = state === 'loading' ? undefined : none ? null : cs.data;
  const t0 = startOf(range, now);
  const restartAgentd = () => void getBridge().supervisor.restart('agentd').then(() => fb.toast('正在重新连接后台服务…'));

  const reset = () => {
    const s = cs.data;
    if (!s) return;
    resetState(s).then(
      (fresh) => {
        qc.setQueryData(['character', 'state'], fresh);
        void qc.invalidateQueries({ queryKey: ['character', 'history'] });
        fb.toast('已重置状态');
      },
      (e: unknown) => {
        const f = failure(e);
        if (f.kind === 'conflict') void cs.refetch();
        fb.toast(f.kind === 'other' ? `重置没有完成：${f.text}` : f.text, { severity: 'danger' });
      },
    );
  };
  const ask = () =>
    fb.ask({
      title: '重置角色的状态？',
      note: '精神和心情回到默认值，变化原因和状态历史都会删除。记忆不受影响。',
      danger: true,
      confirmLabel: '重置',
      children: (
        <ul className={styles.list}>
          <li>
            状态历史：近 24 小时的 <b>{log.data?.length ?? 0}</b> 个点
          </li>
          <li>
            变化原因：<b>{cs.data?.causes.length ?? 0}</b> 条
          </li>
          <li className={styles.keep}>留着：行为决策记录、记忆、动作开关</li>
        </ul>
      ),
      onConfirm: reset,
    });
  const resetWhy = disconnected ? '后台已断开' : !cs.data || none ? '还没有状态可以重置' : undefined;

  return (
    <div className={styles.page} data-page="diag" data-tab="behavior">
      {fb.node}
      <PageHeaderSlot
        tabs={tabs}
        right={
          state === 'loading' || cs.isPending ? (
            <span className={styles.lamp} role="status">
              <Spinner label="读取中" />
              读取中
            </span>
          ) : (
            <span className={styles.lamp}>
              <StatusLamp state={disconnected ? 'broken' : 'ok'} label={disconnected ? '后台已断开' : '已连接'} />
              {readAt != null && (
                <span data-fold="1">
                  {disconnected ? '停在' : '读取于'} <b>{formatClock(readAt, { seconds: true })}</b>
                </span>
              )}
            </span>
          )
        }
      />
      <BottomBarSlot
        actions={
          <Btn icon="refresh" disabled={resetWhy != null} disabledReason={resetWhy} onClick={ask}>
            重置状态…
          </Btn>
        }
      />
      {(stateError || disconnected) && (
        <div className={styles.bars}>
          {stateError && <ErrBar message={`读取角色状态失败：${cs.error ? failure(cs.error).text : '桌面角色没有回应'}`} {...(readAt != null ? { staleAt: readAt } : {})} onRetry={() => void cs.refetch()} />}
          {disconnected && <ErrBar message={`后台已断开 │ 状态和决策停在 ${readAt != null ? formatClock(readAt) : '断开前'}`} tone="warning" onRetry={restartAgentd} />}
        </div>
      )}
      <Behavior
        state={charState}
        log={log.data ?? []}
        beats={beats.data ?? []}
        capped={(beats.data?.length ?? 0) >= BEAT_LIMIT ? BEAT_LIMIT : null}
        range={range}
        onRange={setRange}
        t0={t0}
        now={now}
        stoppedAt={disconnected ? readAt : undefined}
        offline={offline}
      />
    </div>
  );
}
