import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getBridge, type ActionProgress } from '../../bridge';
import { Icon } from '../../ui';
import type { Toast } from './feedback';
import styles from './Transport.module.css';

export type TransportOp = 'pause' | 'resume' | 'seek';
/** ← / → on the bar. */
const STEP_S = 5;

/** m:ss, or h:mm:ss from an hour; whole seconds, cut down. */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The shell's report of the desktop play (`avatar.onActionProgress`) and the page's control of it; a seek shows where it
 *  was let go until her first report after she took it. */
export function useActionTransport(toast: Toast) {
  const [progress, setProgress] = useState<ActionProgress | null>(null);
  const [seek, setSeek] = useState<{ at: number; taken: boolean } | null>(null);
  useEffect(
    () =>
      getBridge().avatar.onActionProgress((p) => {
        setProgress(p);
        setSeek((s) => (s?.taken || p === null ? null : s));
      }),
    [],
  );
  const control = (op: TransportOp, at?: number) => {
    if (op === 'seek' && at !== undefined) setSeek({ at, taken: false });
    void (op === 'seek' ? getBridge().avatar.controlAction(op, at) : getBridge().avatar.controlAction(op)).then(
      () => setSeek((s) => (s && s.at === at ? { ...s, taken: true } : s)),
      (e: unknown) => {
        setSeek(null);
        const code = (e as { code?: string } | null)?.code;
        if (code !== 'not_playing') toast(`无法${op === 'pause' ? '暂停' : op === 'resume' ? '继续' : '跳转'}：${code === 'busy' ? '角色正在被拖动' : '角色渲染进程无响应'}`, { severity: 'danger' });
      },
    );
  };
  return { progress: progress && seek ? { ...progress, tS: Math.min(seek.at, progress.durationS) } : progress, control };
}

export interface TransportProps {
  progress: ActionProgress;
  onControl: (op: TransportOp, at?: number) => void;
}

/** 桌面播放器：暂停 / 继续方键、已播 / 总长（数字字体）、一条可点可拖的进度线（黄色已播段、白菱形头）；进度线上 ← / → 跳 5 秒，空格暂停或继续。 */
export function Transport({ progress, onControl }: TransportProps) {
  const { durationS: total, paused } = progress;
  const [drag, setDrag] = useState<number | null>(null);
  // The pointer is down on the bar; read by events that come before the next render.
  const held = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);
  const t = Math.min(total, Math.max(0, drag ?? progress.tS));
  const at = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total : 0;
  };
  const toggle = () => onControl(paused ? 'resume' : 'pause');
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
    onControl('seek', at(e.clientX));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onControl('seek', Math.min(total, Math.max(0, progress.tS + (e.key === 'ArrowLeft' ? -STEP_S : STEP_S))));
    else if (e.key === ' ') toggle();
    else return;
    e.preventDefault();
  };
  const text = `${clock(t)} / ${clock(total)}`;
  return (
    <div role="group" aria-label="播放器" className={styles.tr} data-transport="" data-paused={paused || undefined}>
      <button type="button" className={styles.key} aria-label={paused ? '继续' : '暂停'} title={paused ? '继续' : '暂停'} onClick={toggle}>
        {paused ? <Icon name="play" size={14} /> : <i className={styles.pause} aria-hidden="true" />}
      </button>
      <span className={styles.time} aria-hidden="true">
        <b>{clock(t)}</b>
        <span className={styles.of}> / </span>
        {clock(total)}
      </span>
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={t}
        aria-valuetext={text}
        className={styles.bar}
        data-transport-bar=""
        data-dragging={drag !== null || undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          held.current = false;
          setDrag(null);
        }}
        onKeyDown={key}
      >
        <span className={styles.track}>
          <span className={styles.fill} style={{ width: `${total > 0 ? (t / total) * 100 : 0}%` }} />
        </span>
      </div>
    </div>
  );
}
