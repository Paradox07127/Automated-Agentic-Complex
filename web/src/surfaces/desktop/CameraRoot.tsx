import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import { getBridge, type CameraAction, type CameraOverlayState } from '../../bridge';
import { Btn } from '../../ui';
import { useRegions } from './hooks/useRegions';
import styles from './CameraRoot.module.css';

/** AvatarCameraLayout.barGap: the bar's distance from the area. */
const BAR_GAP = 12;
/** AvatarCameraModel.pointsPerScrollLine. */
const POINTS_PER_LINE = 10;

/** AvatarCameraLayout.bar: centred under the area, above it when that leaves the page, kept inside the page. */
function barPosition(area: CameraOverlayState['area'], w: number, h: number) {
  let top = area.y + area.height + BAR_GAP;
  if (top + h > window.innerHeight) top = area.y - BAR_GAP - h;
  return {
    left: Math.min(Math.max(area.x + area.width / 2 - w / 2, 0), window.innerWidth - w),
    top: Math.min(Math.max(top, 0), window.innerHeight - h),
  };
}

/** `stack.html#/camera`: 调整镜头 (AvatarCameraOverlayView). Native covers her screen with the page and owns the camera; the
 *  page draws the receiving area and the bar and sends the pointer and the buttons. */
export function CameraRoot() {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CameraOverlayState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => getBridge().camera.onState(setState), []);
  useRegions(ref);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const camera = getBridge().camera;

  const drag = (e: MouseEvent) => {
    if (e.button !== 0) return;
    let last = { x: e.clientX, y: e.clientY };
    const move = (m: globalThis.MouseEvent) => {
      void camera.drag(m.clientX - last.x, m.clientY - last.y);
      last = { x: m.clientX, y: m.clientY };
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      void camera.endDrag();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  // Chromium reports a trackpad pinch as a wheel with ctrlKey.
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey) void camera.magnify(-e.deltaY / 100);
    else void camera.scroll(-e.deltaY * (e.deltaMode === 1 ? POINTS_PER_LINE : 1));
  };

  if (!state) return <div ref={ref} className={styles.root} />;
  const { area, editing, closeup } = state;
  const button = (title: string, action: CameraAction, enabled: boolean, primary = false) => (
    <Btn size="sm" variant={primary ? 'primary' : 'secondary'} disabled={!enabled} onClick={() => void camera.act(action)}>
      {title}
    </Btn>
  );
  return (
    <div ref={ref} className={styles.root} data-theme="dark" onWheel={wheel}>
      <div
        role="application"
        aria-label="镜头"
        className={styles.area}
        data-region
        style={{ left: area.x, top: area.y, width: area.width, height: area.height }}
        onMouseDown={drag}
      />
      <div ref={bar} role="toolbar" className={styles.bar} data-region style={barPosition(area, size.w, size.h)}>
        {button('全身', 'fullBody', editing)}
        {button('近景', 'closeup', closeup)}
        {button('复位', 'reset', editing)}
        {button('完成', 'commit', editing, true)}
      </div>
    </div>
  );
}
