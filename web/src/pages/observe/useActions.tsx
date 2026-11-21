// 观察页的写操作：暂停（/observation/paused）、按时间段清除（DELETE /observation）、删除片段、排除名单（/blacklist）、更正推断、清除本轮上下文。
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { del, post, put, seg } from '../../bridge/agentd';
import { paused } from '../../domain/bodies';
import { formatClock, type Episode } from '../../domain';
import { toast } from '../../shell/toast';
import { Modal, type ModalProps } from '../../ui';
import { errorText, FIELD_OF, KEY, ruleLabel, type ExKind, type ExRule, type TaskGuess, type WireDiagSeen } from './data';

export type ConfirmSpec = Omit<ModalProps, 'open' | 'onCancel' | 'onConfirm'> & { onConfirm: () => void };

/** Minutes an activity correction holds. */
const CORRECTION_MIN = 60;

export type ClearRange = '15m' | '1h' | 'today';
export const CLEAR_LABEL: Record<ClearRange, string> = {
  '15m': '最近 15 分钟',
  '1h': '最近 1 小时',
  today: '今天',
};

export interface ObserveActions {
  confirmNode: ReactNode;
  pause: (minutes: number, until: string) => void;
  resume: () => void;
  clear: (range: ClearRange) => void;
  deleteEpisode: (e: Episode, memories: number, done: () => void) => void;
  exclude: (app: string) => void;
  addRule: (kind: ExKind, value: string) => void;
  removeRule: (r: ExRule) => void;
  correct: (code: string | null, label: string) => void;
  rejectGuess: (g: TaskGuess) => void;
  clearItems: (types: string[]) => void;
}

/** `setPausedDemo` overrides the read pause in the paused demo; undefined hands it back to /diag/state. */
export function useActions(setPausedDemo: (v: number | null | undefined) => void): ObserveActions {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const refresh = (...keys: ReadonlyArray<readonly unknown[]>) => keys.forEach((queryKey) => void qc.invalidateQueries({ queryKey }));
  const run = async (what: string, write: () => Promise<unknown>, done: string, keys: ReadonlyArray<readonly unknown[]>, undo?: () => void) => {
    try {
      await write();
      toast(done, undo ? { action: { label: '撤销', onClick: undo } } : {});
    } catch (e) {
      toast(`没有${what}：${errorText(e)}`);
    }
    refresh(...keys);
  };
  const setPause = async (minutes: number) => {
    const r = await put<{ paused_until: string | null }>('/observation/paused', paused(minutes));
    setPausedDemo(undefined);
    qc.setQueryData<WireDiagSeen>(KEY.diag, (d) => ({
      ...d,
      observation: { ...d?.observation, paused_until: r.paused_until },
    }));
  };
  const resume = () => void run('恢复', () => setPause(0), '已恢复观察', []);

  const addRule = (kind: ExKind, value: string, what = '加入') => {
    const field = FIELD_OF[kind];
    void run(
      what,
      () => post('/blacklist', { field, value, delete_existing: false }),
      `已加入排除名单：${ruleLabel({ field, kind, value })}`,
      [KEY.blacklist],
      () => void run('撤销', () => del('/blacklist', { field, value }), '已撤销', [KEY.blacklist]),
    );
  };

  const confirmNode = confirm && (
    <Modal
      {...confirm}
      open
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        setConfirm(null);
        confirm.onConfirm();
      }}
    />
  );

  return {
    confirmNode,
    pause: (minutes, until) => void run('暂停', () => setPause(minutes), `观察已暂停 │ ${until}`, [], resume),
    resume,
    clear: (range) =>
      setConfirm({
        title: `清除${CLEAR_LABEL[range]}的观察记录？`,
        note: '该时段内的截图、窗口文字和活动片段将被删除。由这些记录生成的记忆也会一并删除。',
        warning: '清除后无法恢复',
        danger: true,
        confirmLabel: '清除',
        onConfirm: () =>
          void (async () => {
            try {
              const r = await del<{ facts?: number }>(`/observation?range=${range}`);
              toast(`已清除${CLEAR_LABEL[range]}的观察记录${r.facts ? ` │ 连带删除 ${r.facts} 条记忆` : ''}`);
            } catch (e) {
              toast(`没有清除：${errorText(e)}`);
            }
            void qc.invalidateQueries({ queryKey: ['observe'] });
          })(),
      }),
    deleteEpisode: (e, memories, done) =>
      setConfirm({
        title: `删除片段「${e.title}」？`,
        note: `这段时间的截图和窗口文字将被删除。${memories > 0 ? `由该片段生成的 ${memories} 条记忆也会一并删除。` : ''}`,
        warning: '删除后无法恢复',
        danger: true,
        confirmLabel: '删除片段',
        onConfirm: () =>
          void (async () => {
            try {
              const r = await del<{ facts: number }>(`/episodes/${seg(e.id)}`);
              toast(r.facts > 0 ? `已删除片段 │ 连带删除 ${r.facts} 条记忆` : '已删除片段');
              done();
            } catch (err) {
              toast(`没有删除：${errorText(err)}`);
            }
            refresh(KEY.episodes, KEY.memory);
          })(),
      }),
    exclude: (app) =>
      setConfirm({
        title: `排除 ${app}？`,
        note: `此后 ${app} 位于前台时，不截图、不读取窗口文字。已有记录保留，可在排除名单中移除。`,
        confirmLabel: '排除此应用',
        onConfirm: () => addRule('app', app, '排除'),
      }),
    addRule: (kind, value) => addRule(kind, value),
    removeRule: (r) =>
      void run(
        '移除',
        () => del('/blacklist', { field: r.field, value: r.value }),
        `已移除：${ruleLabel(r)}`,
        [KEY.blacklist],
        () =>
          void run(
            '撤销',
            () =>
              post('/blacklist', {
                field: r.field,
                value: r.value,
                delete_existing: false,
              }),
            '已撤销',
            [KEY.blacklist],
          ),
      ),
    correct: (code, label) =>
      void run(
        '更正',
        () => put('/context/activity', code == null ? { activity: null } : { activity: code, minutes: CORRECTION_MIN }),
        code == null ? '已撤销更正' : `已更正：${label} │ 一小时内按此理解`,
        [KEY.diag],
      ),
    rejectGuess: (g) =>
      void run(
        '否认',
        () =>
          post(`/task-understanding/${seg(g.id)}/correct`, {
            revision: g.revision,
            action: 'reject',
          }),
        `已记录：当前任务不是「${g.task}」`,
        [KEY.task],
      ),
    clearItems: (types) => void run('清除', () => Promise.all(types.map((t) => del(`/context/items/${seg(t)}`))), '已清除本轮的上下文', [KEY.diag]),
  };
}

/** The pause menu's two choices: an hour, and until 08:00 tomorrow (agentd caps a pause at 1440 minutes). */
export function pauseChoices(now: number): Array<{ label: string; hint: string; minutes: number; until: string }> {
  const d = new Date(now);
  const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0).getTime();
  const hour = now + 3_600_000;
  return [
    {
      label: '暂停 1 小时',
      hint: `${formatClock(hour)} 恢复`,
      minutes: 60,
      until: `${formatClock(hour)} 恢复`,
    },
    {
      label: '暂停至明天',
      hint: '明天 08:00 恢复',
      minutes: Math.min(1440, Math.ceil((morning - now) / 60_000)),
      until: '明天 08:00 恢复',
    },
  ];
}
