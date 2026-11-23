import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type AvatarStats, type SettingValue } from '../../bridge';
import { BracketMeter } from '../../charts';
import { useWidth } from '../../charts/useWidth';
import { msReadout } from '../../domain';
import { useThrottled } from '../../domain/useThrottled';
import { BottomBarSlot } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { Btn, ErrBar, IconBtn, SecHead, Skel, SRow } from '../../ui';
import { GameSeg, ReadoutPlate, type ReadoutCell } from '../../ui/game';
import type { Toast } from '../character/feedback';
import { readFail, saveSettings, useCharSettings, valueText } from '../character/settings';
import styles from './Tune.module.css';

export interface RenderProps {
  /** The character's host is not running: the rows are read-only and there is no reading. */
  offline: boolean;
  onRestart: () => void;
  toast: Toast;
}

/** The three developer-only quality rows; each makes her reappear once saved. */
const ROWS = ['rnd.aa', 'rnd.size', 'rnd.shadow'] as const;
const TIP: Record<(typeof ROWS)[number], string> = {
  'rnd.aa': '超采样抗锯齿；关掉省一半像素，边缘变硬',
  'rnd.size': '「跟随显示」按显示器像素画，是试验项',
  'rnd.shadow': '自阴影贴图边长；低档省显存，阴影边缘起锯齿',
};
const SHORT: Record<string, string> = { display: '跟随显示' };
const ON_OFF = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
];
const SUSPENDED: Record<string, string> = { system_sleep: '系统睡眠', screen_sleep: '屏幕睡眠', session_inactive: '会话不活跃', switching: '切换角色' };

/** The newest avatar.onStats sample, stamped with when it came. */
function useLastStats(live: boolean): AvatarStats | null {
  const [last, setLast] = useState<AvatarStats | null>(null);
  useEffect(() => {
    if (!live) return;
    return getBridge().avatar.onStats((s) => setLast({ ...s, at: s.at ?? Date.now() }));
  }, [live]);
  return last;
}

/** 画质：渲染负载一行读数，三项开发者画质参数；每项点了即时保存，她随后重新出现一次。 */
export function Render({ offline, onRestart, toast }: RenderProps) {
  const { q, merge } = useCharSettings();
  const live = getBridge().capabilities.avatar;
  const details = useQuery({ queryKey: ['character', 'avatarDetails'], queryFn: () => getBridge().avatar.details(), enabled: live });
  const last = useLastStats(live && !offline);
  // The FPS / P95 / GPU text takes a new sample at most once a second.
  const shown = useThrottled(last);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [root, width] = useWidth<HTMLDivElement>(1200);
  const compact = width < 1000;

  // While this tab is open she walks clear of the main window, as on the character page's 设定.
  useEffect(() => {
    if (!live) return;
    getBridge().avatar.keepClearOfMain(true).catch(() => {});
    return () => void getBridge().avatar.keepClearOfMain(false).catch(() => {});
  }, [live]);

  const n = q.data;
  const ids = n ? ROWS.filter((id) => n.rows[id]) : [];
  const changed = n ? ids.filter((id) => n.saved[id] !== n.rows[id]!.default) : [];
  const save = (changes: Record<string, SettingValue>, fail: string) => {
    if (!n) return;
    void saveSettings(changes, { ok: '已保存', fail }, n.rows, toast).then((ok) => {
      if (!ok) return;
      merge(changes);
      const again = Object.keys(changes).filter((id) => n.rows[id]?.restart === 'avatar');
      if (again.length === 0) return;
      setPending((s) => new Set([...s, ...again]));
      setSavedAt(Date.now());
    });
  };

  const budget = 1000 / (Number(n?.saved['rnd.fps']) || 60);
  // After a save the old renderer's numbers no longer count: wait for one taken after it.
  const waiting = savedAt != null && (shown?.at ?? 0) <= savedAt;
  const suspended = details.data?.pipeline?.suspended ?? null;
  const why = offline
    ? '角色未运行 │ 没有读数'
    : waiting
      ? '等读数 │ 她重新出现前没有读数'
      : suspended != null
        ? `画面暂停中${SUSPENDED[suspended] ? ` │ ${SUSPENDED[suspended]}` : ''}`
        : '还没有收到宿主读数';
  const p95 = shown?.frameMsP95 ?? shown?.frameMs;
  const reading = !offline && !waiting && shown != null && p95 != null ? { s: shown, p95 } : null;
  const cells: ReadoutCell[] = reading
    ? [
        {
          label: '帧耗时 │ 帧预算',
          meter: <BracketMeter value={Number(reading.p95.toFixed(1))} max={Number(budget.toFixed(1))} size="lg" readout={`${reading.p95.toFixed(1)} / ${budget.toFixed(1)} ms`} label="P95 帧耗时对帧预算" />,
        },
        // At 925 the meter and its reading keep the row; FPS and GPU are on 诊断.
        ...(compact ? [] : [{ label: 'FPS', value: Math.round(reading.s.fps) }]),
        ...(!compact && reading.s.gpuMs != null ? [{ label: 'GPU', value: msReadout(reading.s.gpuMs) }] : []),
      ]
    : [{ label: '帧耗时 │ 帧预算', meter: <BracketMeter value={0} max={1} size="lg" disabled disabledReason={why} label="P95 帧耗时对帧预算" /> }];

  return (
    <div ref={root} className={styles.render}>
      <BottomBarSlot
        actions={
          <>
            {offline && (
              <Btn variant="secondary" icon="refresh" onClick={onRestart}>
                重启角色
              </Btn>
            )}
            <Btn
              icon="refresh"
              disabled={offline || changed.length === 0}
              disabledReason={offline ? '角色未运行' : '没有改动'}
              onClick={() => n && save(Object.fromEntries(changed.map((id) => [id, n.rows[id]!.default])), '没有恢复默认')}
            >
              {changed.length > 0 ? `恢复默认（${changed.length}）` : '恢复默认'}
            </Btn>
          </>
        }
      />
      <section className={styles.sec} aria-label="渲染负载">
        <SecHead
          title="渲染负载"
          micro="RENDER LOAD"
          right={
            <Btn size="sm" onClick={() => navigate({ page: 'diag' })}>
              完整曲线在诊断
            </Btn>
          }
        />
        <ReadoutPlate label="帧读数" eyebrow="LOAD" cells={cells} compact={compact} />
      </section>
      <section className={styles.sec} aria-label="画质">
        <SecHead
          title="画质"
          dev
          micro="QUALITY"
          right={
            <span className={styles.headR}>
              {n && (
                <span className={styles.count}>
                  已改 <b>{changed.length}</b> / {ids.length}
                </span>
              )}
              <Btn size="sm" onClick={() => navigate({ page: 'character', tab: 'render' })}>
                角色 › 设定 › 画面
              </Btn>
            </span>
          }
        />
        {q.isError ? (
          <ErrBar message={`读取设置失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />
        ) : !n ? (
          <Skel rows={3} />
        ) : (
          <div className={styles.rows}>
            {ids.map((id) => {
              const row = n.rows[id]!;
              const v = n.saved[id];
              const off = v !== row.default;
              const set = (next: SettingValue) => save({ [id]: next }, `没有保存「${row.label}」`);
              const seg =
                row.kind === 'toggle' ? (
                  <GameSeg variant="setting" size="compact" label={row.label} value={v === true ? 'on' : 'off'} options={ON_OFF} disabled={offline} onChange={(x) => set(x === 'on')} />
                ) : (
                  <GameSeg
                    variant="setting"
                    label={row.label}
                    value={String(v)}
                    options={(row.options ?? []).map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))}
                    disabled={offline}
                    onChange={set}
                  />
                );
              return (
                <SRow
                  key={id}
                  id={id}
                  title={row.label}
                  tip={TIP[id]}
                  {...(off ? { desc: `默认：${valueText(row, row.default)}` } : {})}
                  control={
                    <>
                      {off && <IconBtn size="sm" icon="refresh" label={`恢复「${row.label}」的默认`} disabled={offline} onClick={() => set(row.default)} />}
                      {seg}
                    </>
                  }
                  effect="character"
                  pending={pending.has(id)}
                  {...(offline ? { disabled: true, disabledReason: '角色未运行' } : {})}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
