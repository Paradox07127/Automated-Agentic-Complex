import { useEffect, useState } from 'react';
import { Menu, Toggle } from '../../../ui';
import { failure, readProactiveSettings, saveProactiveSettings } from '../api';
import { useSettings } from '../ctx';
import { SetRow } from '../SetRow';
import styles from '../groups.module.css';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** GET/PUT /proactive/settings, held by SpeakGroup for both 主动提示 and 她什么时候开口; `on` is null until read. */
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

/** 主动提示 and the quiet hours. */
export function ContextSpeechRow({ ps, disabled }: { ps: ProactiveState; disabled: boolean }) {
  const { model } = useSettings();
  const { quiet } = ps;
  const toggle = (next: boolean) =>
    void ps.saveCompanion(next).catch((e) => model.notify({ message: `没能${next ? '开启' : '关闭'}主动提示：${failure(e).text}`, severity: 'danger', persistent: true }));
  const saveQuiet = (key: 'quiet_start' | 'quiet_end', h: number) =>
    void ps.saveQuiet(key, h).catch((e) => model.notify({ message: `没能保存安静时段：${failure(e).text}`, severity: 'danger', persistent: true }));
  const hourMenu = (key: 'quiet_start' | 'quiet_end', label: string, value: number) => (
    <span role="group" aria-label={label}>
      <Menu
        label={hourText(value)}
        align="right"
        items={HOURS.map((h) => ({ kind: 'item' as const, label: hourText(h), checked: h === value, disabled, onSelect: () => saveQuiet(key, h) }))}
      />
    </span>
  );
  return (
    <>
      <SetRow
        id="companion_mode"
        title="主动提示"
        desc="发现可以帮忙的时机时主动提示。任务结果和你设置的提醒仍会送达。"
        control={<Toggle on={ps.on === true} label="主动提示" size="sm" disabled={disabled} onChange={toggle} />}
      />
      <SetRow
        id="quiet_hours"
        title="安静时段"
        control={
          quiet == null ? (
            <span className={styles.t3} title="安静时段：还没读到后台的状态">
              未读到
            </span>
          ) : (
            <>
              {hourMenu('quiet_start', '安静时段开始', quiet[0])}
              <span className={styles.t3}>–</span>
              {hourMenu('quiet_end', '安静时段结束', quiet[1])}
            </>
          )
        }
      />
    </>
  );
}
