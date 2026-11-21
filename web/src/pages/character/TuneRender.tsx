import { useEffect, useState } from 'react';
import { getBridge, type AvatarStats, type SettingValue } from '../../bridge';
import { LineChart, type Pt } from '../../charts';
import { msReadout } from '../../domain';
import { useThrottled } from '../../domain/useThrottled';
import type { Native } from '../settings/native';
import { OpenSec, Plate, Seg, SRow, Toggle } from '../../ui';
import { Compass } from './Compass';
import { control } from './settings';
import styles from './Tune.module.css';

export interface TuneRenderProps {
  n: Native;
  set: (id: string, v: SettingValue) => void;
  pending: Set<string>;
  offline: boolean;
  /** Subscribe to avatar.onStats. */
  live: boolean;
  /** avatar.details' suspend reason. */
  suspended: string | null;
}

/** Rows under the frame-rate chart, with the page's short title where the schema label runs long. */
const ROWS: Array<[id: string, title?: string]> = [
  ['rnd.fps', '帧率上限'],
  ['rnd.idle', '空闲时降帧'],
  ['rnd.batt', '使用电池时降帧'],
  ['rnd.aa', '抗锯齿'],
  ['rnd.size'],
  ['rnd.shadow'],
  ['rnd.outline'],
  ['rnd.lightPitch'],
  ['rnd.lightStrength'],
];

const SUSPENDED: Record<string, string> = { system_sleep: '系统睡眠', screen_sleep: '屏幕睡眠', session_inactive: '会话不活跃', switching: '切换角色' };
/** A gap longer than this between samples is drawn as a break. */
const GAP_MS = 1500;
const WINDOW_MS = 60_000;
/** One sample second per axis minute, so the ruler lands on −45 / −30 / −15 s. */
const AX0 = new Date(2026, 0, 1, 1, 0).getTime() - 59 * 60_000;
const nums = (n: Native, id: string) => (n.rows[id]?.options ?? []).map((o) => Number(o.value)).filter((v) => !Number.isNaN(v));

/** The last minute of avatar.onStats. */
function useStats(live: boolean): AvatarStats[] {
  const [list, setList] = useState<AvatarStats[]>([]);
  useEffect(() => {
    if (!live) return;
    return getBridge().avatar.onStats((s) => {
      const at = s.at ?? Date.now();
      setList((l) => [...l, { ...s, at }].filter((x) => (x.at ?? 0) > at - WINDOW_MS));
    });
  }, [live]);
  return list;
}

/** 02 画面：镜头罗盘与光向、帧率 60 秒折线、画质与帧率各行；每次修改即时保存。 */
export function TuneRender({ n, set, pending, offline, live, suspended }: TuneRenderProps) {
  const stats = useStats(live && !offline);
  const [drag, setDrag] = useState<{ yaw?: number; pitch?: number }>({});
  const row = (id: string) => n.rows[id];
  const val = (id: string) => n.saved[id];
  const cap = Number(val('rnd.fps')) || 60;
  const yaw = drag.yaw ?? Number(val('rnd.yaw') ?? 0);
  const pitch = drag.pitch ?? Number(val('rnd.pitch') ?? 0);
  const light = row('rnd.lightYaw') ? Number(val('rnd.lightYaw') ?? 0) : null;
  const last = stats[stats.length - 1];
  const end = last?.at ?? 0;
  // The FPS / P95 / GPU text takes a new sample at most once a second.
  const shown = useThrottled(last);
  const x = (t: number) => AX0 + (59 - Math.round((end - t) / 1000)) * 60_000;
  const pts: Pt[] = [];
  const marks: Array<{ t: number; label: string }> = [];
  stats.forEach((s, i) => {
    const prev = stats[i - 1];
    if (prev && (s.at ?? 0) - (prev.at ?? 0) > GAP_MS) {
      pts.push([x((prev.at ?? 0) + 1000), null]);
      if (!marks.some((m) => m.label === '暂停')) marks.push({ t: x((prev.at ?? 0) + 1000), label: '暂停' });
    }
    pts.push([x(s.at ?? 0), s.fps]);
  });
  const low = stats.reduce<AvatarStats | null>((m, s) => (s.fps < cap * 0.85 && (!m || s.fps < m.fps) ? s : m), null);
  if (low) marks.unshift({ t: x(low.at ?? 0), label: '掉帧' });
  const opts = (id: string) => (row(id)?.options ?? []).map((o) => ({ ...o, disabled: offline }));
  const dis = offline ? { disabled: true, disabledReason: '角色未运行' } : {};
  const empty = offline ? '角色未运行 │ 无帧率数据' : suspended != null ? `画面暂停中${SUSPENDED[suspended] ? ` │ ${SUSPENDED[suspended]}` : ''}` : '还没有收到宿主读数';
  const lightLabel = row('rnd.lightYaw')?.options?.find((o) => o.value === String(val('rnd.lightYaw')))?.label;

  return (
    <div className={styles.col}>
      <OpenSec no="02" title="画面">
        <Plate no="Camera" label="镜头">
          <div className={styles.cam}>
            <Compass
              yaw={yaw}
              pitch={pitch}
              yaws={nums(n, 'rnd.yaw')}
              pitches={nums(n, 'rnd.pitch')}
              light={light}
              disabled={offline || !row('rnd.yaw')}
              onChange={(k, v) => setDrag((d) => ({ ...d, [k]: v }))}
              onEnd={(k) => {
                const v = drag[k];
                if (v != null && String(v) !== String(val(`rnd.${k}`))) set(`rnd.${k}`, String(v));
                setDrag({});
              }}
            />
            <div className={styles.camr}>
              <div className={styles.sub} style={{ marginTop: 0 }}>
                镜头
              </div>
              {row('rnd.cam') && <Seg size="sm" label="镜头预设" value={String(val('rnd.cam'))} options={opts('rnd.cam')} onChange={(v) => set('rnd.cam', v)} />}
              <div className={styles.kvs}>
                <span className={styles.kv}>
                  <span className={styles.kvK} aria-hidden="true">
                    Yaw
                  </span>
                  <b className={styles.num}>{yaw}°</b>
                </span>
                <span className={styles.kv}>
                  <span className={styles.kvK} aria-hidden="true">
                    Pitch
                  </span>
                  <b className={styles.num}>{pitch}°</b>
                </span>
              </div>
              {row('rnd.lightYaw') && (
                <>
                  <div className={styles.sub}>光向</div>
                  <Seg size="sm" label="主光水平" value={String(val('rnd.lightYaw'))} options={opts('rnd.lightYaw')} onChange={(v) => set('rnd.lightYaw', v)} />
                  <div className={styles.cap} style={{ marginTop: 6 }}>
                    左前方 {35 - (light ?? 0)}° │ {lightLabel ?? '原作'}
                  </div>
                </>
              )}
            </div>
          </div>
        </Plate>
        {(row('rnd.ground') || row('rnd.ambient') || row('rnd.wrap')) && (
          <Plate no="Ground" label="落地与环境">
            {row('rnd.ground') && <Seg size="sm" label={row('rnd.ground')!.label} value={String(val('rnd.ground'))} options={opts('rnd.ground')} onChange={(v) => set('rnd.ground', v)} />}
            {row('rnd.ambient') && <Seg size="sm" label={row('rnd.ambient')!.label} value={String(val('rnd.ambient'))} options={opts('rnd.ambient')} onChange={(v) => set('rnd.ambient', v)} />}
            {row('rnd.wrap') && <Toggle size="sm" on={val('rnd.wrap') === true} label={row('rnd.wrap')!.label} disabled={offline} onChange={(v) => set('rnd.wrap', v)} />}
          </Plate>
        )}
        <div className={styles.sub}>
          帧率 │ 最近 60 秒
          <span className={styles.sp} />
          {shown && !offline && (
            <span className={styles.kvs}>
              <span className={styles.kv}>
                <span className={styles.kvK}>FPS</span>
                <b className={styles.num}>{Math.round(shown.fps)}</b>
              </span>
              {shown.frameMsP95 != null && (
                <span className={styles.kv}>
                  <span className={styles.kvK}>P95</span>
                  <b className={styles.num}>{msReadout(shown.frameMsP95)}</b>
                </span>
              )}
              {shown.gpuMs != null && (
                <span className={styles.kv}>
                  <span className={styles.kvK}>GPU</span>
                  <b className={styles.num}>{msReadout(shown.gpuMs)}</b>
                </span>
              )}
            </span>
          )}
        </div>
        <LineChart
          h={96}
          st={offline || stats.length === 0 ? 'empty' : 'ok'}
          empty={empty}
          label="帧率 最近 60 秒"
          t0={AX0}
          t1={AX0 + 59 * 60_000}
          yMin={30}
          yMax={Math.max(66, cap + 6)}
          emph="fps"
          fmtT={(t) => {
            const d = Math.round((AX0 + 59 * 60_000 - t) / 60_000);
            return d ? `−${d} s` : '现在';
          }}
          fmtY={(v) => (v == null ? '—' : String(Math.round(v)))}
          marks={marks}
          limit={{ v: cap, label: `上限 ${cap}` }}
          series={[{ id: 'fps', label: '帧率', pts }]}
        />
        <div className={styles.rows}>
          {ROWS.map(([id, title]) => {
            const s = row(id);
            if (!s) return null;
            return (
              <SRow
                key={id}
                id={id.slice(4)}
                title={title ?? s.label}
                {...(title && title !== s.label ? { desc: s.label } : {})}
                control={control(s, val(id), offline, (v) => set(id, v))}
                effect={s.restart === 'avatar' ? 'character' : s.restart === 'backend' ? 'backend' : 'now'}
                pending={pending.has(id)}
                {...dis}
              />
            );
          })}
        </div>
      </OpenSec>
    </div>
  );
}
