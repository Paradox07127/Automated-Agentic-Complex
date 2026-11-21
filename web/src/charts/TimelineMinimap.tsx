import { useRef, type MouseEvent } from 'react';
import type { TimelineLaneSpec } from './TimelineLane';
import { clampN, hm } from './v3';
import m from './TimelineMinimap.module.css';

interface MinimapProps {
  t0: number;
  t1: number;
  view: [number, number];
  /** Narrowest window, ms. */
  min: number;
  lanes: TimelineLaneSpec[];
  pauses: Array<{ t0: number; t1: number }>;
  now?: number;
  /** Moves the window to start `a` with span `s` (clamped by the caller). */
  setWindow: (a: number, s: number) => void;
  setView: (v: [number, number]) => void;
}

/** Whole-day strip under the timeline: drag the window to pan, its ends to stretch, click elsewhere to centre there. */
export function TimelineMinimap({ t0, t1, view, min, lanes, pauses, now, setWindow, setView }: MinimapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const full = t1 - t0 || 1;
  const MP = (t: number) => ((t - t0) / full) * 100;
  const [v0, v1] = view;
  const down = (mode: 'bg' | 'move' | 'l' | 'r') => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = r.width || 1;
    if (mode === 'bg') {
      const tc = t0 + clampN((e.clientX - r.left) / width, 0, 1) * full;
      setWindow(tc - (v1 - v0) / 2, v1 - v0);
      return;
    }
    const x0 = e.clientX;
    const mv = (ev: globalThis.MouseEvent) => {
      const dt = ((ev.clientX - x0) / width) * full;
      if (mode === 'move') setWindow(v0 + dt, v1 - v0);
      else if (mode === 'l') setView([clampN(v0 + dt, t0, v1 - min), v1]);
      else setView([v0, clampN(v1 + dt, v0 + min, t1)]);
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };
  const rails = lanes.filter((l) => l.kind === 'blocks' || l.kind === 'spans' || l.kind === 'strip').slice(0, 3);
  return (
    <div className={m.mm}>
      <span className={m.label}>全日</span>
      <div ref={ref} className={m.track} onMouseDown={down('bg')} role="slider" tabIndex={-1} aria-label="全日缩略带" aria-valuemin={t0} aria-valuemax={t1} aria-valuenow={v0} aria-valuetext={`${hm(v0)}–${hm(v1)}`} data-minimap="">
        {rails.map((l, li) => l.items.map((it, i) => it.t0 != null && it.t1 != null && <i key={`${l.id}${i}`} style={{ left: `${MP(it.t0)}%`, width: `max(1px, ${MP(it.t1) - MP(it.t0)}%)`, top: 3 + li * 4 }} />))}
        {pauses.map((p, i) => (
          <span key={`z${i}`} className={m.pz} style={{ left: `${MP(p.t0)}%`, width: `${MP(p.t1) - MP(p.t0)}%` }} />
        ))}
        {now != null && <span className={m.now} style={{ left: `${MP(now)}%` }} />}
        <span className={m.win} style={{ left: `${MP(v0)}%`, width: `${MP(v1) - MP(v0)}%` }} onMouseDown={down('move')} data-window="">
          <i className={m.l} onMouseDown={down('l')} />
          <i className={m.r} onMouseDown={down('r')} />
        </span>
      </div>
    </div>
  );
}
