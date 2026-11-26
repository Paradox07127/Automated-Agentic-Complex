// 检查镜头：角色页每个分区都能看她。左键（一根手指）拖动转向、俯仰，右键、中键或 Shift + 左键平移，滚轮和触控板捏合在指针处放大缩小；
// 松手即停。镜头跨分区保留，换人和离开角色页回正。
import { useEffect, useRef, useState } from 'react';
import { getBridge, type PreviewView } from '../../bridge';
import { PREVIEW_LAYER } from '../../features/character/usePreview';

/** Degrees per device pixel of drag, on her yaw and on her pitch. */
const TURN_PER_PX = 0.5;
export const TILT_MAX = 80;
/** A wheel scales the zoom by exp(deltaY × this); a pinch (Chromium's wheel with `ctrlKey`) by exp(deltaY × PINCH_PER_PX). */
const ZOOM_PER_PX = 0.0015;
const PINCH_PER_PX = 0.01;
/** Pixels a line of a line-mode wheel counts. */
const LINE_PX = 33;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Camera {
  turn: number;
  tilt: number;
  zoom: number;
  pan: [number, number];
}

const home = (): Camera => ({ turn: 0, tilt: 0, zoom: 1, pan: [0, 0] });
const atHome = (c: Camera) => c.turn === 0 && c.tilt === 0 && c.zoom === 1 && c.pan[0] === 0 && c.pan[1] === 0;
const send = (v: PreviewView) => void getBridge().avatar.preview.view(v).catch(() => {});
/** A drag of (dx, dy) CSS px on her: dragging down raises the camera. */
const spun = (c: Camera, dx: number, dy: number) => {
  c.turn += TURN_PER_PX * dx * devicePixelRatio;
  c.tilt = clamp(c.tilt + TURN_PER_PX * dy * devicePixelRatio, -TILT_MAX, TILT_MAX);
};

export interface Inspect {
  moved: boolean;
  reset: () => void;
  /** The camera's turn and tilt now, in degrees. */
  turn: number;
  tilt: number;
  /** Puts the camera at `turn` and `tilt`, keeping its zoom and pan. */
  aim: (turn: number, tilt: number) => void;
  /** Turns the camera as a drag of (dx, dy) px on the grip does. */
  spin: (dx: number, dy: number) => void;
}

/** Where `stage` sits in the page's preview layer, as x, y, w, h shares of it inside 0–1; the whole rect without a layer. */
export function stageFrame(stage: Element): [number, number, number, number] {
  const layer = document.querySelector(PREVIEW_LAYER);
  const l = layer?.getBoundingClientRect();
  if (!l || l.width <= 0 || l.height <= 0) return [0, 0, 1, 1];
  const s = stage.getBoundingClientRect();
  const x = clamp((s.left - l.left) / l.width, 0, 1);
  const y = clamp((s.top - l.top) / l.height, 0, 1);
  return [x, y, clamp(s.width / l.width, 0, 1 - x), clamp(s.height / l.height, 0, 1 - y)];
}

/**
 * `grip` takes the drag, the wheel and the pinch that move the live preview's camera about her on `stage`; the view, with the
 * stage's place in the preview layer as its frame, goes to the shell at most once a frame and only when it changed, on every
 * frame of the stage's own transitions too. A new `character` and unmounting send the default view. `moved` is true while the
 * view is not the default one; `reset` returns it there.
 */
export function useInspect(grip: HTMLElement | null, stage: HTMLElement | null, character: string): Inspect {
  const [moved, setMoved] = useState(false);
  const [look, setLook] = useState({ turn: 0, tilt: 0 });
  const camera = useRef(home());
  const reset = useRef(() => {});
  const update = useRef(() => {});
  useEffect(() => reset.current(), [character]);
  useEffect(() => {
    if (!grip || !stage) return;
    let frame = 0;
    let sent = '';
    let drag: { id: number; x: number; y: number; pan: boolean } | null = null;
    // The stage's properties in transition: the frame follows them every frame until they end.
    const moving = new Set<string>();
    const flush = () => {
      frame = 0;
      if (moving.size > 0) schedule();
      const v: PreviewView = { ...camera.current, frame: stageFrame(stage) };
      const key = JSON.stringify(v);
      if (key === sent) return;
      sent = key;
      send(v);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const changed = () => {
      setMoved(!atHome(camera.current));
      setLook({ turn: camera.current.turn, tilt: camera.current.tilt });
      schedule();
    };
    update.current = changed;
    reset.current = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      camera.current = home();
      setMoved(false);
      setLook({ turn: 0, tilt: 0 });
      flush();
    };
    // The first pointer down drags until it is released, on the grip or past it; another finger meanwhile does nothing.
    const down = (e: PointerEvent) => {
      if (drag || e.button > 2) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey };
      grip.setPointerCapture(e.pointerId);
      grip.dataset.grabbing = '';
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag?.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const c = camera.current;
      if (drag.pan) {
        // The point under the pointer stays under it: a stage width of drag is `zoom` fit widths.
        const s = stage.getBoundingClientRect();
        if (s.width <= 0 || s.height <= 0) return;
        c.pan = [c.pan[0] - (dx / s.width) * c.zoom, c.pan[1] - (dy / s.height) * c.zoom];
      } else {
        spun(c, dx, dy);
      }
      changed();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag?.id) return;
      drag = null;
      delete grip.dataset.grabbing;
    };
    // Zoom at the pointer: with q its offset from the stage's centre in stage sizes, the fit point under it stays.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * LINE_PX : e.deltaY;
      const c = camera.current;
      const zoom = clamp(c.zoom * Math.exp(dy * (e.ctrlKey ? PINCH_PER_PX : ZOOM_PER_PX)), ZOOM_MIN, ZOOM_MAX);
      const s = stage.getBoundingClientRect();
      if (s.width > 0 && s.height > 0) {
        const q = [(e.clientX - s.left) / s.width - 0.5, (e.clientY - s.top) / s.height - 0.5] as const;
        c.pan = [c.pan[0] + q[0] * (c.zoom - zoom), c.pan[1] + q[1] * (c.zoom - zoom)];
      }
      c.zoom = zoom;
      changed();
    };
    const menu = (e: Event) => e.preventDefault();
    const run = (e: Event) => {
      if (e.target !== stage) return;
      moving.add((e as TransitionEvent).propertyName);
      schedule();
    };
    const end = (e: Event) => {
      if (e.target !== stage) return;
      moving.delete((e as TransitionEvent).propertyName);
      schedule();
    };
    flush();
    grip.addEventListener('pointerdown', down);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    grip.addEventListener('wheel', wheel, { passive: false });
    grip.addEventListener('contextmenu', menu);
    stage.addEventListener('transitionrun', run);
    stage.addEventListener('transitionend', end);
    stage.addEventListener('transitioncancel', end);
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(stage);
    const layer = document.querySelector(PREVIEW_LAYER);
    if (layer) ro?.observe(layer);
    return () => {
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      grip.removeEventListener('wheel', wheel);
      grip.removeEventListener('contextmenu', menu);
      stage.removeEventListener('transitionrun', run);
      stage.removeEventListener('transitionend', end);
      stage.removeEventListener('transitioncancel', end);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      cancelAnimationFrame(frame);
      reset.current = () => {};
      update.current = () => {};
      delete grip.dataset.grabbing;
      send(home());
    };
  }, [grip, stage]);
  return {
    moved,
    reset: () => reset.current(),
    ...look,
    aim: (turn, tilt) => {
      camera.current.turn = turn;
      camera.current.tilt = clamp(tilt, -TILT_MAX, TILT_MAX);
      update.current();
    },
    spin: (dx, dy) => {
      spun(camera.current, dx, dy);
      update.current();
    },
  };
}
