import { useEffect, useState } from 'react';
import { Select } from '../../../ui';
import { failure, readProactiveSettings, saveProactiveSettings } from '../api';
import { useSettings } from '../ctx';
import { SetRow } from '../SetRow';
import styles from '../groups.module.css';

export const HOURS = Array.from({ length: 24 }, (_, h) => h);
export const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** GET/PUT /proactive/settings, held by SpeakGroup for 她什么时候开口 (companion_mode) and 免打扰时段; `on` is null until read. */
export function useProactiveSettings() {
  const [on, setOn] = useState<boolean | null>(null);
  const [quiet, setQuietHours] = useState<[number, number] | null>(null);
  useEffect(() => {
    let live = true;
    readProactiveSettings().then(
      (r) => {
        if (!live) return;
        setOn(Boolean(r?.companion_mode));
        if (typeof r?.quiet_start === 'number' && typeof r?.quiet_end === 'number') setQuietHours([r.quiet_start, r.quiet_end]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const saveCompanion = (next: boolean) => saveProactiveSettings({ companion_mode: next }).then((r) => setOn(Boolean(r?.companion_mode ?? next)));
  const saveQuiet = (key: 'quiet_start' | 'quiet_end', h: number) => saveProactiveSettings({ [key]: h }).then((r) => setQuietHours([r.quiet_start, r.quiet_end]));
  return { on, quiet, saveCompanion, saveQuiet };
}

export type ProactiveState = ReturnType<typeof useProactiveSettings>;

/** 免打扰时段: the hours agentd keeps proactive speech back, shown under 主动. */
export function QuietHoursRow({ ps, disabled }: { ps: ProactiveState; disabled: boolean }) {
  const { model } = useSettings();
  const { quiet } = ps;
  const saveQuiet = (key: 'quiet_start' | 'quiet_end', h: number) =>
    void ps.saveQuiet(key, h).catch((e) => model.notify({ message: `没能保存免打扰时段：${failure(e).text}`, severity: 'danger', persistent: true }));
  const hourMenu = (key: 'quiet_start' | 'quiet_end', label: string, value: number) => (
    <Select label={label} value={String(value)} options={HOURS.map((h) => ({ value: String(h), label: hourText(h) }))} disabled={disabled} onChange={(v) => saveQuiet(key, Number(v))} />
  );
  return (
    <SetRow
      id="quiet_hours"
      title="免打扰时段"
      desc="这段时间不主动开口"
      indent
      control={
        quiet == null ? (
          <span className={styles.t3} title="免打扰时段：还没读到后台的状态">
            未读到
          </span>
        ) : (
          <>
            {hourMenu('quiet_start', '免打扰时段开始', quiet[0])}
            <span className={styles.t3}>–</span>
            {hourMenu('quiet_end', '免打扰时段结束', quiet[1])}
          </>
        )
      }
    />
  );
}
