// 观察模式（总览的「只看模型」），照游戏角色观察页：横向拖动转她（只绕竖轴、不限角度、松手即停），滚轮和触控板捏合放大缩小。
import { useEffect, useRef } from 'react';
import { getBridge } from '../../bridge';

/** Degrees per device pixel of horizontal drag. */
const TURN_PER_PX = 0.5;
/** Zoom per pixel of wheel `deltaY`: 0.1 a 100 px notch, toward you out. */
const ZOOM_PER_PX = 0.001;
/** Pixels a line of a line-mode wheel counts. */
const LINE_PX = 33;
/** A pinch (Chromium's wheel with `ctrlKey`) scales the zoom by exp(deltaY × this). */
const PINCH_PER_PX = 0.01;

const clampZoom = (zoom: number) => Math.min(1, Math.max(0.3, zoom));
const send = (turn: number, zoom: number) => void getBridge().avatar.preview.view({ turn, zoom }).catch(() => {});

/**
 * While `on`, `stage` takes the pointer drag, the wheel and the pinch, and the live preview's view goes to the shell at most
 * once a frame. Entering, leaving and a new `character` send turn 0, zoom 1.
 */
export function useObserve(stage: HTMLElement | null, on: boolean, character: string): void {
  const reset = useRef(() => {});
  useEffect(() => reset.current(), [character]);
  useEffect(() => {
    if (!stage || !on) return;
    let turn = 0;
    let zoom = 1;
    let frame = 0;
    let drag: { id: number; x: number } | null = null;
    const flush = () => {
      frame = 0;
      send(turn, zoom);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };
    reset.current = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      turn = 0;
      zoom = 1;
      send(turn, zoom);
    };
    // The first pointer down drags until it is released, on the stage or past it; another finger meanwhile does nothing.
    const down = (e: PointerEvent) => {
      if (drag || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX };
      stage.setPointerCapture(e.pointerId);
      stage.dataset.grabbing = '';
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag?.id || e.clientX === drag.x) return;
      turn += TURN_PER_PX * (e.clientX - drag.x) * devicePixelRatio;
      drag.x = e.clientX;
      schedule();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag?.id) return;
      drag = null;
      delete stage.dataset.grabbing;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * LINE_PX : e.deltaY;
      zoom = clampZoom(e.ctrlKey ? zoom * Math.exp(dy * PINCH_PER_PX) : zoom + dy * ZOOM_PER_PX);
      schedule();
    };
    stage.dataset.observe = '';
    send(turn, zoom);
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => {
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      stage.removeEventListener('wheel', wheel);
      cancelAnimationFrame(frame);
      reset.current = () => {};
      delete stage.dataset.observe;
      delete stage.dataset.grabbing;
      send(0, 1);
    };
  }, [stage, on]);
}
