// 行为 and 画面 rows: config.json through settings.read / settings.save, controls and options from settings.schema.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { getBridge, type SettingValue } from '../../bridge';
import type { ToastOptions } from '../../shell/toast';
import { Select, Seg, Slider, Switch } from '../../ui';
import { loadNative, type Native, type SchemaRow } from '../settings/native';

const KEY = ['character', 'settings'];

export function useCharSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => loadNative(getBridge(), null) });
  // A menu changed config.json (e.g. 自由活动 flips beh.stay): read it again.
  useEffect(() => getBridge().settings.onChange(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  /** After a save: the written values become the read. */
  const merge = (changes: Record<string, SettingValue>) => qc.setQueryData<Native>(KEY, (n) => n && { ...n, saved: { ...n.saved, ...changes } });
  return { q, merge };
}

const RESTART: Record<string, string> = { none: '立即生效', avatar: '角色正在重新出现', backend: '重启后台服务后生效' };

/** settings.save and one toast from its receipt: `ok · what happened`, or `fail：the shell's reason`. */
export async function saveSettings(
  changes: Record<string, SettingValue>,
  text: { ok: string; fail: string },
  rows: Record<string, SchemaRow>,
  toast: (message: string, opts?: ToastOptions) => void,
): Promise<boolean> {
  let res;
  try {
    res = await getBridge().settings.save(changes);
  } catch {
    toast(`${text.fail}：原生设置服务没有响应`, { severity: 'danger', persistent: true });
    return false;
  }
  if (res.error) {
    // The shell's text may carry an option key or a system message: logged, not shown.
    console.warn('settings.save refused', res.error);
    toast(`${text.fail}：桌面端没有接受这次修改`, { severity: 'danger', persistent: true });
    return false;
  }
  toast(`${text.ok} │ ${RESTART[res.restart] ?? RESTART.none}`);
  if (res.notApplied.length) toast(`${res.notApplied.map((id) => `「${rows[id]?.label ?? id}」`).join('')}要重启 Agentic Complex 后生效`, { severity: 'warning', persistent: true });
  return true;
}

const UNIT: Record<string, string> = { percent: '%', degrees: '°', days: '天' };
const SEND_GAP_MS = 1000 / 30;

interface SettingSliderProps {
  row: SchemaRow;
  value: SettingValue | undefined;
  disabled: boolean;
  /** `quiet`: a value sent while the pointer still drags the slider. */
  onChange: (v: number, quiet: boolean) => void;
}

/** Slider row: a `percent` value reads ×100. While dragging it sends at most 30 changes a second, then the released value once more without `quiet`. */
function SettingSlider({ row, value, disabled, onChange }: SettingSliderProps) {
  const k = row.format === 'percent' ? 100 : 1;
  const shown = (v: number) => Number((v * k).toFixed(6));
  const stored = shown(Number(value ?? row.default));
  // The dragged value until the saved one catches up with it.
  const [live, setLive] = useState<number | null>(null);
  if (live !== null && live === stored) setLive(null);
  const sent = useRef(-Infinity);
  const queued = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onChange);
  latest.current = onChange;
  // A pointer drag in progress: its window listeners and its last value.
  const drag = useRef<{ off: AbortController; last: number | null } | null>(null);
  const send = (v: number) => {
    sent.current = Date.now();
    latest.current(Number((v / k).toFixed(6)), drag.current !== null);
  };
  const flush = () => {
    timer.current = undefined;
    if (queued.current !== null) send(queued.current);
    queued.current = null;
  };
  const release = () => {
    const d = drag.current;
    if (!d) return;
    d.off.abort();
    drag.current = null;
    clearTimeout(timer.current);
    timer.current = undefined;
    queued.current = null;
    if (d.last !== null) send(d.last);
  };
  useEffect(() => () => {
    clearTimeout(timer.current);
    release();
    flush();
  }, []);
  const press = (e: PointerEvent) => {
    if ((e.target as HTMLInputElement).type !== 'range' || drag.current) return;
    const off = new AbortController();
    drag.current = { off, last: null };
    for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, release, { signal: off.signal });
  };
  const change = (v: number) => {
    setLive(v);
    if (drag.current) drag.current.last = v;
    const wait = sent.current + SEND_GAP_MS - Date.now();
    if (wait <= 0 && timer.current === undefined) return send(v);
    queued.current = v;
    timer.current ??= setTimeout(flush, Math.max(0, wait));
  };
  return (
    <div style={{ display: 'contents' }} onPointerDown={press}>
      <Slider
        label={row.label}
        min={shown(row.min ?? 0)}
        max={shown(row.max ?? 1)}
        step={shown(row.step ?? 0.01)}
        value={live ?? stored}
        defaultValue={shown(Number(row.default))}
        unit={UNIT[row.format ?? '']}
        disabled={disabled}
        onChange={change}
      />
    </div>
  );
}

/** Switch for a toggle row; a slider for a slider row; segments for up to three options, else a menu. Sends the option value, never the label. */
export function control(row: SchemaRow, value: SettingValue | undefined, disabled: boolean, onChange: (v: SettingValue, quiet?: boolean) => void): ReactNode {
  if (row.kind === 'toggle') return <Switch label={row.label} checked={value === true} disabled={disabled} onChange={onChange} />;
  if (row.kind === 'slider') return <SettingSlider row={row} value={value} disabled={disabled} onChange={onChange} />;
  const options = row.options ?? [];
  if (options.length <= 3) return <Seg label={row.label} value={String(value)} onChange={onChange} options={options.map((o) => ({ ...o, disabled }))} />;
  return <Select label={row.label} value={String(value)} defaultValue={String(row.default)} disabled={disabled} onChange={onChange} options={options} />;
}
