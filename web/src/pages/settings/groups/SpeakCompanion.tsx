import { useEffect, useState } from 'react';
import { Btn, IconBtn, Select, Switch } from '../../../ui';
import { failure, readProactiveSettings, saveProactiveSettings, type QuietRange } from '../api';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import styles from '../groups.module.css';

export const HOURS = Array.from({ length: 24 }, (_, h) => h);
export const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** GET/PUT /proactive/settings, held by SpeakGroup for 主动开口 (companion_mode) and 免打扰时段; `on` and `quiet` are null until read. */
export function useProactiveSettings() {
  const [on, setOn] = useState<boolean | null>(null);
  const [quiet, setQuiet] = useState<Quiet | null>(null);
  useEffect(() => {
    let live = true;
    readProactiveSettings().then(
      (r) => {
        if (!live) return;
        setOn(r.companion_mode);
        setQuiet({ enabled: r.quiet_enabled, ranges: r.quiet_ranges });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const saveCompanion = (next: boolean) => saveProactiveSettings({ companion_mode: next }).then((r) => setOn(r.companion_mode));
  const saveQuiet = (body: { quiet_enabled?: boolean; quiet_ranges?: QuietRange[] }) =>
    saveProactiveSettings(body).then((r) => setQuiet({ enabled: r.quiet_enabled, ranges: r.quiet_ranges }));
  return { on, quiet, saveCompanion, saveQuiet };
}

type Quiet = { enabled: boolean; ranges: QuietRange[] };

export type ProactiveState = ReturnType<typeof useProactiveSettings>;

/** agentd takes at most this many quiet ranges. */
const MAX_RANGES = 8;

/** 免打扰时段: a switch under 主动; while on, 添加时段 beside it and one row per range with its hours. */
export function QuietHoursRow({ ps, disabled }: { ps: ProactiveState; disabled: boolean }) {
  const { model } = useSettings();
  const { quiet } = ps;
  const save = (body: { quiet_enabled?: boolean; quiet_ranges?: QuietRange[] }) =>
    void ps.saveQuiet(body).catch((e) => model.notify({ message: `未能保存免打扰时段：${failure(e).text}`, severity: 'danger', persistent: true }));
  if (quiet == null) {
    return (
      <SetRow
        id="quiet_hours"
        title={labelOf('quiet_hours')}
        indent
        control={
          <span className={styles.t3} title="免打扰时段：尚未读取后台状态">
            未读取
          </span>
        }
      />
    );
  }
  const { ranges } = quiet;
  const setRange = (i: number, next: QuietRange) => save({ quiet_ranges: ranges.map((r, j) => (j === i ? next : r)) });
  const hourMenu = (label: string, value: number, other: number, pick: (h: number) => void) => (
    <Select
      label={label}
      value={String(value)}
      options={HOURS.filter((h) => h !== other).map((h) => ({ value: String(h), label: hourText(h) }))}
      disabled={disabled}
      onChange={(v) => pick(Number(v))}
    />
  );
  return (
    <>
      <SetRow
        id="quiet_hours"
        title={labelOf('quiet_hours')}
        desc="在以下时段内不主动发起交互"
        indent
        control={
          <>
            {quiet.enabled && ranges.length < MAX_RANGES && (
              <Btn disabled={disabled} onClick={() => save({ quiet_ranges: [...ranges, [12, 13]] })}>
                添加时段
              </Btn>
            )}
            <Switch variant="setting" checked={quiet.enabled} label={labelOf('quiet_hours')} disabled={disabled} onChange={(on) => save({ quiet_enabled: on })} />
          </>
        }
      />
      {quiet.enabled &&
        ranges.map(([start, end], i) => (
          <SetRow
            key={i}
            id={`quiet_range_${i}`}
            title={`时段 ${i + 1}`}
            indent
            control={
              <>
                {hourMenu(`时段 ${i + 1} 开始`, start, end, (h) => setRange(i, [h, end]))}
                <span className={styles.t3}>–</span>
                {hourMenu(`时段 ${i + 1} 结束`, end, start, (h) => setRange(i, [start, h]))}
                <IconBtn icon="close" label={`删除时段 ${i + 1}`} disabled={disabled || ranges.length === 1} onClick={() => save({ quiet_ranges: ranges.filter((_, j) => j !== i) })} />
              </>
            }
          />
        ))}
    </>
  );
}
