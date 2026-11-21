import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type AvatarAction, type SettingValue } from '../../bridge';
import type { CharacterState } from '../../domain';
import { Btn, ErrBar, Skel, StatusTag } from '../../ui';
import { mockOnly, readScales } from './api';
import type { Toast } from './feedback';
import { saveSettings, useCharSettings } from './settings';
import { TuneBehavior } from './TuneBehavior';
import { TuneRender } from './TuneRender';
import styles from './Tune.module.css';

export interface TuneProps {
  offline: boolean;
  backoff: number | null;
  onRestart: () => void;
  actions: AvatarAction[];
  state: CharacterState | null;
  toast: Toast;
}

export const readFail = (e: unknown): string => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'config_unreadable' ? '读不了 config.json' : code === 'not_implemented' ? '这个版本还不支持' : '原生设置服务没有响应';
};

/** 行为与画面：左栏行为，右栏画面；每行即时保存，要角色重新出现的行在保存后标出来。 */
export function Tune({ offline, backoff, onRestart, actions, state, toast }: TuneProps) {
  const { q, merge } = useCharSettings();
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const live = getBridge().capabilities.avatar;
  const details = useQuery({ queryKey: ['character', 'avatarDetails'], queryFn: () => getBridge().avatar.details(), enabled: live });

  if (q.isError) return <ErrBar message={`读取设置失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  const n = q.data;
  if (!n) return <Skel rows={8} />;

  const set = (id: string, v: SettingValue) => {
    const row = n.rows[id];
    void saveSettings({ [id]: v }, { ok: '已保存', fail: `没有保存「${row?.label ?? id}」` }, n.rows, toast).then((ok) => {
      if (!ok) return;
      merge({ [id]: v });
      if (row?.restart === 'avatar') setPending((s) => new Set(s).add(id));
    });
  };

  return (
    <div className={styles.tune} data-view="tune">
      {offline && (
        <div className={styles.ro} role="status">
          <StatusTag state="unreachable" label="角色未运行" />
          <span>行为与画面暂为只读</span>
          {backoff != null && <span className={styles.cap}>退避 {backoff} 秒后重试</span>}
          <span className={styles.sp} />
          <Btn size="sm" variant="secondary" onClick={onRestart}>
            重启角色
          </Btn>
        </div>
      )}
      <TuneBehavior n={n} set={set} pending={pending} offline={offline} actions={actions} state={state} scales={readScales()} map={mockOnly()} />
      <TuneRender n={n} set={set} pending={pending} offline={offline} live={live} suspended={details.data?.pipeline?.suspended ?? null} />
    </div>
  );
}
