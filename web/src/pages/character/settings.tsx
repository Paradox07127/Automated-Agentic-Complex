// 行为 and 画面 rows: config.json through settings.read / settings.save, controls and options from settings.schema.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { getBridge, type SettingValue } from '../../bridge';
import type { ToastOptions } from '../../shell/toast';
import { Select, Slider, Switch } from '../../ui';
import { GameSeg } from '../../ui/game';
import { loadNative, type Native, type SchemaRow } from '../settings/native';

const KEY = ['character', 'settings'];

/** Why settings.read failed, for the 读取设置失败 bars. */
export const readFail = (e: unknown): string => {
  const code = (e as { code?: string } | null)?.code;
  return code === 'config_unreadable' ? '无法读取 config.json' : code === 'not_implemented' ? '当前版本暂不支持' : '应用设置服务无响应';
};

export function useCharSettings(enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => loadNative(getBridge(), null), enabled });
  // A menu changed config.json (e.g. 自由活动 flips beh.stay): read it again.
  useEffect(() => getBridge().settings.onChange(() => void qc.invalidateQueries({ queryKey: KEY })), [qc]);
  /** After a save: the written values become the read. */
  const merge = (changes: Record<string, SettingValue>) => qc.setQueryData<Native>(KEY, (n) => n && { ...n, saved: { ...n.saved, ...changes } });
  return { q, merge };
}

const RESTART: Record<string, string> = { none: '立即生效', avatar: '正在重载角色进程', backend: '重启后台服务后生效' };

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
    toast(`${text.fail}：应用设置服务无响应`, { severity: 'danger', persistent: true });
    return false;
  }
  if (res.error) {
    // The shell's text may carry an option key or a system message: logged, not shown.
    console.warn('settings.save refused', res.error);
    toast(`${text.fail}：应用宿主未接受本次修改`, { severity: 'danger', persistent: true });
    return false;
  }
  toast(`${text.ok} │ ${RESTART[res.restart] ?? RESTART.none}`);
  if (res.notApplied.length) toast(`${res.notApplied.map((id) => `「${rows[id]?.label ?? id}」`).join('')}须重启 Agentic Complex 后生效`, { severity: 'warning', persistent: true });
  return true;
}

const UNIT: Record<string, string> = { percent: '%', degrees: '°', days: '天' };
const SEND_GAP_MS = 1000 / 30;

interface SettingSliderProps {
  row: SchemaRow;
  value: SettingValue | undefined;
  disabled: boolean;
  /** `quiet`: a value sent while the pointer still drags the slider. Resolves false when the save failed. */
  onChange: (v: number, quiet: boolean) => Promise<boolean>;
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
  // The value sent last: when its save fails the slider shows the stored value again, unless it moved on since.
  const asked = useRef<number | null>(null);
  const send = (v: number) => {
    sent.current = Date.now();
    asked.current = v;
    void latest.current(Number((v / k).toFixed(6)), drag.current !== null).then((ok) => {
      if (!ok && asked.current === v) setLive((l) => (l === v ? null : l));
    });
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

/** 设定 rows on the training room: 开 | 关 for a toggle row, a slider for a slider row, segments for up to three options (or the
 *  short labels `short` gives), else a dropdown. Sends the option value, never the label. */
export function gameControl(
  row: SchemaRow,
  value: SettingValue | undefined,
  disabled: boolean,
  onChange: (v: SettingValue, quiet?: boolean) => Promise<boolean>,
  short?: Readonly<Record<string, string>>,
  compact = false,
): ReactNode {
  // The settings page's controls: its segments (开 | 关 for a switch) and, past three options, its dropdown.
  const size = compact ? 'compact' : 'normal';
  if (row.kind === 'toggle')
    return <Switch variant="setting" label={row.label} checked={value === true} disabled={disabled} onChange={onChange} />;
  if (row.kind === 'slider') return <SettingSlider row={row} value={value} disabled={disabled} onChange={onChange} />;
  const options = row.options ?? [];
  if (short || options.length <= 3)
    return (
      <GameSeg
        variant="setting"
        label={row.label}
        size={size}
        value={String(value)}
        defaultValue={String(row.default)}
        options={options.map((o) => ({ value: o.value, label: short?.[o.value] ?? o.label }))}
        disabled={disabled}
        onChange={onChange}
      />
    );
  return <Select label={row.label} value={String(value)} defaultValue={String(row.default)} options={options} disabled={disabled} onChange={onChange} />;
}

/** The text of a value: an option's label, 开 / 关, or a slider reading with its unit. */
export function valueText(row: SchemaRow, v: SettingValue | undefined): string {
  if (row.kind === 'toggle') return v === true ? '开' : '关';
  if (row.kind === 'slider') return `${Number((Number(v) * (row.format === 'percent' ? 100 : 1)).toFixed(6))}${UNIT[row.format ?? ''] ?? ''}`;
  return row.options?.find((o) => o.value === String(v))?.label ?? String(v);
}
