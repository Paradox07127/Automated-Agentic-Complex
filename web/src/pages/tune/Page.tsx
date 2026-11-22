// 调参（开发者）: 行为与画面, the 24 h state curves with 行为决策, and the full motion table, moved here from the 角色 page.
// As there, 屏幕示意, 状态倍数 and today's plays come from the fake bridge only (agentd and the host do not send them yet).
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type AvatarAction } from '../../bridge';
import type { ChartStatus } from '../../charts';
import { useDemo } from '../../shell/demo';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { ErrBar, Menu, Skel, Spinner } from '../../ui';
import { failure, readBeats, readHistory, readMotionHours, readState, resetState } from '../character/api';
import { pageNow, useFeedback, usePageParams } from '../character/feedback';
import { MotionTable } from '../character/MotionTable';
import { DOWN } from '../character/Page';
import { StatePanel, type PanelTab } from '../character/StatePanel';
import { Tune } from '../character/Tune';
import { groupMotions, useMotions } from '../character/useMotions';
import { ToolBar } from '../diag/ToolBar';
import styles from './Tune.module.css';

const NO_ACTIONS: AvatarAction[] = [];
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export function TunePage() {
  const { state, demo } = useDemo();
  const params = usePageParams();
  const fb = useFeedback();
  const qc = useQueryClient();
  const canAvatar = getBridge().capabilities.avatar;
  const now = pageNow();
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
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
  const beats = useQuery({ queryKey: ['character', 'beats', dayStart], queryFn: () => readBeats(dayStart) });
  const conn = useQuery({ queryKey: ['agentd', 'connection'], queryFn: () => getBridge().agentd.connection() });
  const sup = useQuery({ queryKey: ['supervisor', 'state'], queryFn: () => getBridge().supervisor.state() });
  const motions = useQuery({ queryKey: ['character', 'motions'], queryFn: () => getBridge().avatar.actions(), enabled: canAvatar });
  const actions = motions.data ?? NO_ACTIONS;
  const m = useMotions({ actions, toast: fb.toast });
  const [sel, setSel] = useState('');
  const [ptab, setPtab] = useState<PanelTab>(params.get('ptab') === 'beat' ? 'beat' : 'state');

  const avatarState = demo === 'offline' ? 'stopped' : sup.data?.avatar?.state;
  const offline = avatarState != null && DOWN.test(avatarState);
  const backoff = demo === 'offline' ? null : (sup.data?.avatar?.backoff ?? null);
  const disconnected = conn.data === 'offline' || [cs.error, log.error].some((e) => e != null && failure(e).kind === 'offline');
  const stateError = state === 'error' || (cs.isError && !disconnected);
  const none = state === 'empty' || cs.data === null;
  const stop = readAt != null ? { stoppedAt: readAt } : {};
  const status = (q: { isPending: boolean; isError: boolean }): ChartStatus =>
    disconnected ? 'disconnected' : state === 'loading' ? 'loading' : state === 'error' || q.isError ? 'error' : q.isPending ? 'loading' : 'ok';
  const restart = () => {
    void getBridge().supervisor.restart('avatar');
    fb.toast('正在重启角色…');
  };
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
  const motionsError = !canAvatar ? '桌面角色没有接入' : motions.isError ? (codeOf(motions.error) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应') : null;
  const groups = groupMotions(actions);
  const pick = groups.flatMap((g) => g.rows).find((r) => r.a.id === sel)?.a.id ?? '';

  const table = motionsError ? (
    <ErrBar message={`读取动作失败：${motionsError}`} onRetry={() => void motions.refetch()} />
  ) : state === 'loading' || motions.data == null ? (
    <Skel rows={8} />
  ) : (
    <MotionTable
      groups={groups}
      value={m.value}
      changed={m.changed}
      sel={pick}
      onSel={setSel}
      onToggle={m.toggle}
      hours={readMotionHours(demo === 'sparse')}
      offline={offline}
      lock={false}
      sparse={demo === 'sparse'}
      saving={m.saving}
      onUndo={m.undo}
      onSave={m.save}
    />
  );

  return (
    <div className={styles.page} data-page="tune">
      {fb.node}
      <PageHeaderSlot
        right={
          state === 'loading' && (
            <span className={styles.loading} role="status">
              <Spinner label="读取中" />
              读取中
            </span>
          )
        }
      />
      <ToolBar
        action={
          <Menu
            label="更多"
            icon="more"
            align="right"
            items={[
              {
                kind: 'item',
                label: '重置角色状态…',
                danger: true,
                disabled: !cs.data || none,
                reason: '还没有状态可以重置',
                onSelect: () =>
                  fb.ask({
                    title: '重置角色的状态？',
                    note: '精神和心情回到默认值，变化原因和状态历史都会删除。记忆不受影响。',
                    danger: true,
                    confirmLabel: '重置',
                    onConfirm: reset,
                  }),
              },
            ]}
          />
        }
      />
      {(stateError || disconnected) && (
        <div className={styles.bars}>
          {stateError && (
            <ErrBar message={`读取角色状态失败：${cs.error ? failure(cs.error).text : '桌面角色没有回应'}`} {...(readAt != null ? { staleAt: readAt } : {})} onRetry={() => void cs.refetch().then(() => fb.toast('正在重新读取…'))} />
          )}
          {disconnected && (
            <ErrBar
              message="后台已断开 │ 角色状态和读数停在断开前"
              tone="warning"
              {...(readAt != null ? { staleAt: readAt } : {})}
              onRetry={() => void getBridge().supervisor.restart('agentd').then(() => fb.toast('正在重新连接后台服务…'))}
            />
          )}
        </div>
      )}
      <Tune offline={offline} backoff={backoff} onRestart={restart} actions={actions} state={none ? null : (cs.data ?? null)} toast={fb.toast} />
      <div className={styles.lower}>
        <StatePanel
          tab={ptab}
          onTab={setPtab}
          log={none ? [] : (log.data ?? [])}
          logStatus={status(log)}
          causes={none ? [] : (cs.data?.causes ?? [])}
          beats={beats.data ?? []}
          beatStatus={status(beats)}
          now={now}
          {...stop}
        />
        <div className={styles.motions}>{table}</div>
      </div>
    </div>
  );
}
