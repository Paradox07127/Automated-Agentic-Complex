import { useEffect, useRef, useState, type PointerEvent } from 'react';
import styles from './Tune.module.css';

export interface CompassProps {
  yaw: number;
  pitch: number;
  /** Allowed yaw and pitch values (the settings' options); a drag snaps to the nearest. */
  yaws: number[];
  pitches: number[];
  /** Main light's horizontal offset in degrees; null hides the sun. */
  light: number | null;
  disabled: boolean;
  onChange: (key: 'yaw' | 'pitch', v: number) => void;
  /** A drag ended: save. */
  onEnd: (key: 'yaw' | 'pitch') => void;
}

const C = 78;
const R = 60;
const PX = 172;
const PY = 78;
const PR = 52;
const rad = (d: number) => (d * Math.PI) / 180;
const pt = (deg: number, r: number): [number, number] => [C + r * Math.cos(rad(deg + 90)), C + r * Math.sin(rad(deg + 90))];
const pp = (d: number): [number, number] => [PX + PR * Math.cos(rad(d)), PY - PR * Math.sin(rad(d))];
const nearest = (v: number, opts: number[]) => opts.reduce((b, o) => (Math.abs(o - v) < Math.abs(b - v) ? o : b), opts[0] ?? v);
/** The light's base direction: front left. */
const LIGHT0 = -35;

/** 镜头罗盘（俯视：水平朝向和光向）加侧视俯仰弧，都能拖，松手保存。 */
export function Compass({ yaw, pitch, yaws, pitches, light, disabled, onChange, onEnd }: CompassProps) {
  const [drag, setDrag] = useState<'yaw' | 'pitch' | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const latest = useRef({ yaw, pitch, onChange, onEnd });
  latest.current = { yaw, pitch, onChange, onEnd };

  useEffect(() => {
    if (!drag) return;
    const move = (e: globalThis.PointerEvent) => {
      const b = ref.current?.getBoundingClientRect();
      if (!b) return;
      const s = 260 / b.width;
      const x = (e.clientX - b.left) * s;
      const y = (e.clientY - b.top) * s;
      if (drag === 'yaw') {
        let d = Math.round((Math.atan2(y - C, x - C) * 180) / Math.PI - 90);
        if (d <= -180) d += 360;
        if (d > 180) d -= 360;
        const v = nearest(d, yaws);
        if (v !== latest.current.yaw) latest.current.onChange('yaw', v);
      } else {
        const d = Math.round((Math.atan2(PY - y, Math.max(1, x - PX)) * 180) / Math.PI);
        const v = nearest(d, pitches);
        if (v !== latest.current.pitch) latest.current.onChange('pitch', v);
      }
    };
    const up = () => {
      setDrag(null);
      latest.current.onEnd(drag);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [drag, yaws, pitches]);

  const start = (k: 'yaw' | 'pitch') => (e: PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    setDrag(k);
  };
  const cam = pt(yaw, R);
  const c1 = pt(yaw - 16, R - 6);
  const c2 = pt(yaw + 16, R - 6);
  const sun = light == null ? null : pt(LIGHT0 + light, R + 9);
  const pc = pp(pitch);
  const [a30, b30] = [pp(30), pp(-30)];
  return (
    <svg ref={ref} className={styles.cmp} data-disabled={disabled || undefined} data-drag={drag ?? undefined} viewBox="0 0 260 156" role="img" aria-label={`镜头水平 ${yaw}°，俯仰 ${pitch}°`}>
      <circle cx={C} cy={C} r={R} className={styles.ring} onPointerDown={start('yaw')} />
      {Array.from({ length: 24 }, (_, i) => {
        const [x1, y1] = pt(i * 15, R);
        const [x2, y2] = pt(i * 15, R - (i % 3 === 0 ? 7 : 3));
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={styles.tk} />;
      })}
      <text x={C - 16} y={C + R - 6} textAnchor="middle" className={styles.lbZh}>
        正
      </text>
      <text x={C} y={C - R + 20} textAnchor="middle" className={styles.lbZh}>
        背
      </text>
      <text x={C - R + 14} y={C + 4} textAnchor="middle" className={styles.lbZh}>
        左
      </text>
      <text x={C + R - 14} y={C + 4} textAnchor="middle" className={styles.lbZh}>
        右
      </text>
      <path d={`M${C} ${C}L${c1[0]} ${c1[1]}L${c2[0]} ${c2[1]}Z`} className={styles.cone} />
      <circle cx={C} cy={C} r="5" className={styles.me} />
      <path d={`M${C - 3} ${C + 6}L${C} ${C + 11}L${C + 3} ${C + 6}Z`} className={styles.me} />
      <g className={styles.camk} transform={`translate(${cam[0]} ${cam[1]}) rotate(${yaw})`} onPointerDown={start('yaw')}>
        <rect x="-7" y="-5" width="14" height="10" rx="1.5" />
        <path d="M-3 -5l3 -4 3 4z" />
      </g>
      {sun && (
        <g className={styles.sun} transform={`translate(${sun[0]} ${sun[1]})`}>
          <circle r="4.5" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line key={a} x1={6.5 * Math.cos(rad(a))} y1={6.5 * Math.sin(rad(a))} x2={9.5 * Math.cos(rad(a))} y2={9.5 * Math.sin(rad(a))} />
          ))}
        </g>
      )}
      <path d={`M${a30[0]} ${a30[1]}A${PR} ${PR} 0 0 1 ${b30[0]} ${b30[1]}`} className={`${styles.ring} ${styles.arc}`} onPointerDown={start('pitch')} />
      <line x1={PX} x2={PX + PR + 8} y1={PY} y2={PY} className={styles.tk} />
      <rect x={PX - 3} y={PY - 12} width="6" height="24" className={styles.me} />
      <line x1={PX} y1={PY} x2={pc[0]} y2={pc[1]} className={styles.pl} />
      <circle cx={pc[0]} cy={pc[1]} r="5" className={styles.pk} onPointerDown={start('pitch')} />
      <text x={a30[0] + 6} y={a30[1] + 2} className={styles.lb}>
        +30°
      </text>
      <text x={b30[0] + 6} y={b30[1] + 8} className={styles.lb}>
        −30°
      </text>
      <text x={C} y="152" textAnchor="middle" className={styles.lbZh}>
        俯视 │ 水平
      </text>
      <text x={PX + 22} y="152" textAnchor="middle" className={styles.lbZh}>
        侧视 │ 俯仰
      </text>
    </svg>
  );
}
