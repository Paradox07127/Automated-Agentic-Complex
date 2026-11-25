import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { ActionProgress, MmdDetail, MmdEntry } from '../../bridge';
import { Icon } from '../../ui';
import { GameSeg, MicroLabel, WhiteCapsule } from '../../ui/game';
import type { TransportOp } from '../character/Transport';
import styles from './Timeline.module.css';

/** ← / → on the timeline while the desktop plays. */
const STEP_S = 5;

/** m:ss.t, tenths cut down (the epsilon keeps 0.3 s from reading 0.2). */
function clock(s: number): string {
  const t = Math.floor(Math.max(0, s) * 10 + 1e-6) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** The ruler's step: the shortest that leaves at most seven marks. */
const rulerStep = (total: number) => [5, 10, 15, 30, 60, 120].find((s) => total / s <= 8) ?? 300;

const LOOP = [
  { value: 'once', label: '一次' },
  { value: 'loop', label: '循环' },
];

interface TimelineProps {
  entry: MmdEntry;
  detail: MmdDetail | null;
  /** The desktop's report while it plays this dance. */
  desk: ActionProgress | null;
  onControl: (op: TransportOp, at?: number) => void;
  baked: boolean;
  canLoop: boolean;
  loop: boolean;
  onLoop: (loop: boolean) => void;
  /** The desktop plays or loops this dance: 停止桌面播放 in place of 桌面播放. */
  onDesk: boolean;
  playOff: string | null;
  onPlay: () => void;
  onStop: () => void;
}

/** 时间线：播放键、时钟、来源（页内预览 / 桌面）、桌面播放、一次 / 循环；身体、口型、镜头切点、音源四条轨和播放头。桌面在播这支舞时跟着桌面走，拖动或 ← → 跳转。 */
export function Timeline(p: TimelineProps) {
  const desk = p.desk;
  const total = desk?.durationS ?? p.entry.durationS;
  const [drag, setDrag] = useState<number | null>(null);
  const held = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  // No preview position yet: the playhead stays at the start.
  const t = desk ? Math.min(total, Math.max(0, drag ?? desk.tS)) : 0;
  const f = total > 0 ? t / total : 0;
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total : 0;
  };
  const toggle = () => desk && p.onControl(desk.paused ? 'resume' : 'pause');
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!desk || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    held.current = true;
    setDrag(at(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (held.current) setDrag(at(e.clientX));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!held.current) return;
    held.current = false;
    setDrag(null);
    p.onControl('seek', at(e.clientX));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!desk) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') p.onControl('seek', Math.min(total, Math.max(0, desk.tS + (e.key === 'ArrowLeft' ? -STEP_S : STEP_S))));
    else if (e.key === ' ') toggle();
    else return;
    e.preventDefault();
  };
  const step = rulerStep(total);
  const marks = Array.from({ length: Math.max(0, Math.ceil(total / step) - 1) }, (_, i) => (i + 1) * step);
  const lanes = p.detail?.lanes;
  const cuts = p.detail?.camera?.cuts;
  const paused = desk?.paused === true;
  return (
    <section className={styles.tl} aria-label="时间线" data-source={desk ? 'desktop' : 'preview'}>
      <div className={styles.ctl}>
        <button type="button" className={styles.pp} aria-label={paused ? '继续' : '暂停'} title={desk ? (paused ? '继续' : '暂停') : '页内预览还不能暂停'} disabled={!desk} onClick={toggle}>
          {paused ? <Icon name="play" size={14} /> : <i className={styles.pause} aria-hidden="true" />}
        </button>
        <span className={styles.clock} aria-label="时钟">
          <b>{clock(t)}</b>
          <span className={styles.of}>/ {clock(total)}</span>
        </span>
        <span className={styles.src}>
          <MicroLabel>{desk ? 'DESKTOP' : 'PREVIEW'}</MicroLabel>
          <b>{desk ? '桌面' : '页内预览'}</b>
        </span>
        <span className={styles.sp} />
        {p.baked && (
          <span className={styles.deskKey} title={p.playOff ?? undefined}>
            {p.onDesk ? (
              <WhiteCapsule label="停止桌面播放" icon="stop" size="lg" disabled={p.playOff != null} disabledReason={p.playOff ?? ''} onClick={p.onStop} />
            ) : (
              <WhiteCapsule label="桌面播放" icon="g-window" size="lg" disabled={p.playOff != null} disabledReason={p.playOff ?? ''} onClick={p.onPlay} />
            )}
          </span>
        )}
        {p.baked && <GameSeg label={p.canLoop ? '播放方式' : '舞台播放方式'} value={p.loop ? 'loop' : 'once'} options={LOOP} onChange={(v) => p.onLoop(v === 'loop')} />}
      </div>
      <div className={styles.lanes} style={{ '--f': f } as CSSProperties}>
        <div className={styles.ruler} aria-hidden="true">
          {marks.map((s) => (
            <span key={s} style={{ left: `${(s / total) * 100}%` }}>
              {clock(s).replace(/\.0$/, '')}
            </span>
          ))}
        </div>
        <Lane row={2} label="身体" micro="BODY" name="身体">
          <i className={styles.body} />
        </Lane>
        <Lane row={3} label="口型" micro="FACE" name="口型">
          {lanes?.mouth && <Bars values={lanes.mouth} kind="mouth" />}
        </Lane>
        <Lane row={4} label="镜头" micro="CAM" name="镜头切点">
          {cuts && total > 0 && <Cuts cuts={cuts} total={total} />}
        </Lane>
        <Lane row={5} label="音源" micro="BGM" name="音源">
          {lanes?.loudness && <Bars values={lanes.loudness} kind="wave" />}
        </Lane>
        <div
          ref={track}
          className={styles.track}
          role="slider"
          tabIndex={desk ? 0 : -1}
          aria-label="播放进度"
          aria-disabled={!desk || undefined}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={t}
          aria-valuetext={`${clock(t)} / ${clock(total)}`}
          data-transport-bar=""
          data-seek={desk ? '' : undefined}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            held.current = false;
            setDrag(null);
          }}
          onKeyDown={key}
        >
          <i className={styles.head} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

/** `row`: its row of the grid; the seek surface over every row takes the lanes' column, so nothing there places itself. */
function Lane({ row, label, micro, name, children }: { row: number; label: string; micro: string; name: string; children?: ReactNode }) {
  return (
    <>
      <span className={styles.lb} style={{ gridRow: row }} aria-hidden="true">
        {label}
        <MicroLabel>{micro}</MicroLabel>
      </span>
      <div className={styles.lane} style={{ gridRow: row }} role="img" aria-label={name} data-lane={micro.toLowerCase()}>
        <i className={styles.played} />
        {children}
      </div>
    </>
  );
}

/** One bar per slice: the mouth from the lane's floor, the music's loudness both ways from its middle. */
function Bars({ values, kind }: { values: number[]; kind: 'mouth' | 'wave' }) {
  const d = useMemo(
    () =>
      values
        .map((v, i) => {
          const h = Math.min(1, Math.max(0, v)) * (kind === 'mouth' ? 86 : 44);
          return kind === 'mouth' ? `M${i} ${100 - h}V100h1V${100 - h}z` : `M${i} ${50 - h}V${50 + h}h1V${50 - h}z`;
        })
        .join(''),
    [values, kind],
  );
  return (
    <svg className={styles.svg} viewBox={`0 0 ${values.length} 100`} preserveAspectRatio="none" data-bins={values.length} aria-hidden="true">
      <path className={styles[kind]} d={d} />
    </svg>
  );
}

function Cuts({ cuts, total }: { cuts: number[]; total: number }) {
  return (
    <svg className={styles.svg} viewBox="0 0 1000 100" preserveAspectRatio="none" data-cuts={cuts.length} aria-hidden="true">
      {cuts.map((c) => (
        <rect key={c} className={styles.cut} x={(c / total) * 1000 - 0.6} y={12} width={1.2} height={76} />
      ))}
    </svg>
  );
}
