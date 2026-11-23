import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { TILT_MAX, type Inspect } from './useInspect';
import styles from './ViewCube.module.css';

/** Each face's view; without `turn` the camera keeps its own. The right face is turn −90, where a drag to the left takes the camera. */
const FACES = [
  { face: 'front', label: '正面', turn: 0, tilt: 0 },
  { face: 'right', label: '右面', turn: -90, tilt: 0 },
  { face: 'back', label: '背面', turn: 180, tilt: 0 },
  { face: 'left', label: '左面', turn: 90, tilt: 0 },
  { face: 'top', label: '顶面', tilt: TILT_MAX },
  { face: 'bottom', label: '底面', tilt: -TILT_MAX },
] as const;
const AXES = ['x', 'y', 'z'] as const;
/** Pixels a press moves before it is a drag. */
const DRAG_SLOP = 4;

/** `to` plus whole turns, the nearest to `from`. */
const nearest = (to: number, from: number) => to + 360 * Math.round((from - to) / 360);

/** 视角方块: a cube turned with the inspection camera, the X, Y and Z axes on its corner; a face pressed turns the camera to it, a drag on it turns the camera as one on her does. */
export function ViewCube({ inspect }: { inspect: Inspect }) {
  const drag = useRef<{ id: number; x: number; y: number; on: boolean } | null>(null);
  // The last press was a drag: its release makes no press on a face.
  const dragged = useRef(false);
  const [turning, setTurning] = useState(false);
  const down = (e: ReactPointerEvent) => {
    if (drag.current || e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false };
    dragged.current = false;
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.on) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      d.on = true;
      dragged.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setTurning(true);
    }
    d.x = e.clientX;
    d.y = e.clientY;
    inspect.spin(dx, dy);
  };
  const up = (e: ReactPointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setTurning(false);
  };
  return (
    <div
      className={styles.cube}
      role="group"
      aria-label="视角方块"
      data-turning={turning || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClickCapture={(e) => {
        // A key's press (detail 0) always counts.
        if (dragged.current && e.detail > 0) e.stopPropagation();
        dragged.current = false;
      }}
    >
      <div className={styles.box} style={{ '--turn': `${inspect.turn}deg`, '--tilt': `${inspect.tilt}deg` } as CSSProperties}>
        {FACES.map((f) => (
          <button
            key={f.face}
            type="button"
            className={styles.face}
            data-face={f.face}
            aria-label={`镜头转到${f.label}`}
            onClick={() => inspect.aim('turn' in f ? nearest(f.turn, inspect.turn) : inspect.turn, f.tilt)}
          />
        ))}
        {AXES.map((a) => (
          <span key={a} className={styles.axis} data-axis={a} aria-hidden="true">
            <i />
            <i />
          </span>
        ))}
        {AXES.map((a) => (
          <b key={a} className={styles.letter} data-axis={a} aria-hidden="true">
            {a.toUpperCase()}
          </b>
        ))}
      </div>
    </div>
  );
}
