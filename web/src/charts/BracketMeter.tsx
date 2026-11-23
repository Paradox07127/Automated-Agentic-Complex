import { clamp, fraction, usageLevel, usageText } from './scale';
import { ShapeGlyph } from './StateMark';
import styles from './BracketMeter.module.css';

/** 括号计量条：轨道 6 高、每 20% 刻度；<70% 墨、70–90% 黄块 ▲、≥90% 黄块 ✕（≤100% 写「接近上限」，>100% 写「超限」）；预留段斜纹；读数在右。 */
export interface BracketMeterProps {
  /** 当前值 */
  value: number;
  /** 上限 */
  max: number;
  /** 读屏名称，例如「今日截图」 */
  label: string;
  /** 预留量，紧接填充画斜纹 */
  reserved?: number;
  /** 宽 48 / 80 / 120 / 300，默认 md */
  size?: 'mini' | 'sm' | 'md' | 'lg';
  /** 轨道宽（px），给了就不按 size 取宽 */
  width?: number;
  /** usage 按阈值着色；level 是状态量（精神、投入），填主序列色 */
  tone?: 'usage' | 'level';
  /** 凹口或参考刻度（与 value 同单位） */
  marks?: number[];
  /** 右侧读数，默认「value/max」 */
  readout?: string;
  /** 置灰（未授权、未接入） */
  disabled?: boolean;
  /** 置灰原因，写在读数位置 */
  disabledReason?: string;
  /** 发散基线：轨道中点是这个值，范围 center ± max；高于向右填主序列色，低于向左填 s2 灰 */
  center?: number;
}

const WIDTH = { mini: 48, sm: 80, md: 120, lg: 300 } as const;

/** Meter level: usage thresholds, `level` for state quantities, `negative` below zero (s2 grey). */
export function meterLevel(value: number, max: number, tone: 'usage' | 'level'): 'ok' | 'high' | 'over' | 'level' | 'negative' {
  if (value < 0) return 'negative';
  return tone === 'level' ? 'level' : usageLevel(value, max);
}

export function BracketMeter({ value, max, label, reserved = 0, size = 'md', width, tone = 'usage', marks = [], readout, disabled, disabledReason, center }: BracketMeterProps) {
  const div = center != null;
  const lo = div ? center - max : 0;
  const hi = div ? center + max : max;
  const pos = (v: number) => (div ? clamp((v - lo) / (hi - lo), 0, 1) : fraction(v, max));
  const level = div ? (value < center ? 'negative' : 'level') : meterLevel(value, max, tone);
  const fill = div ? 0 : fraction(value, max);
  const mid = div ? pos(center) : 0;
  const at = div ? pos(value) : 0;
  const rsv = clamp(fraction(reserved, max), 0, 1 - fill);
  const shape = disabled ? null : level === 'high' ? 'triangle' : level === 'over' ? 'square' : null;
  const token = level === 'over' ? '--ef-state-failed' : '--ef-state-warning';
  const over = max > 0 && value > max;
  const text = disabled ? (disabledReason ?? '未接入') : (readout ?? (div ? String(value) : `${value}/${max}`));
  const levelText = level === 'ok' || level === 'high' || level === 'over' ? usageText(value, max) : null;
  const aria = `${label} ${div ? `${value}，基线 ${center}` : `${value}/${max}`}${reserved ? `，预留 ${reserved}` : ''}${levelText && !disabled ? `，${levelText}` : ''}${disabled ? `，${text}` : ''}`;
  return (
    <span
      role="img"
      data-stub="BracketMeter"
      data-size={size}
      data-tone={tone}
      data-level={level}
      data-reserved={reserved || undefined}
      data-center={center}
      data-marks={marks.join(',') || undefined}
      className={styles.root}
      aria-label={aria}
      aria-disabled={disabled}
      style={{ ['--w' as string]: `${width ?? WIDTH[size]}px` }}
    >
      <span className={styles.bk} aria-hidden="true">
        [
      </span>
      <span className={styles.track} aria-hidden="true">
        {fill > 0 && <i className={styles.fill} style={{ width: `${fill * 100}%` }} />}
        {div && <i className={styles.fill} style={{ left: `${Math.min(mid, at) * 100}%`, width: `${Math.abs(at - mid) * 100}%` }} />}
        {div && <i className={styles.center} style={{ left: `${mid * 100}%` }} />}
        {level === 'negative' && !div && <i className={styles.under} />}
        {rsv > 0 && <i className={styles.reserved} style={{ left: `${fill * 100}%`, width: `${rsv * 100}%` }} />}
        {marks.map((m) => (
          <i key={m} className={styles.notch} style={{ left: `${pos(m) * 100}%` }} />
        ))}
      </span>
      <span className={styles.bk} aria-hidden="true">
        ]
      </span>
      {shape && (
        <span className={styles.shape} data-shape={shape}>
          <ShapeGlyph shape={shape} token={token} size={8} />
        </span>
      )}
      <span className={styles.readout} data-over={over || undefined}>
        {text}
        {levelText && level !== 'ok' && !disabled && size === 'lg' && <span className={styles.levelText}> │ {levelText}</span>}
      </span>
    </span>
  );
}

export const BracketMeterDemos: Array<{ name: string; props: BracketMeterProps }> = [
  { name: 'usage', props: { value: 37, max: 200, reserved: 1, label: '今日截图' } },
  { name: 'high', props: { value: 10, max: 12, label: '主动发言', readout: '10/12 │ 已拦截 3' } },
  { name: 'level', props: { value: 0.31, max: 1, tone: 'level', marks: [0.2, 0.35, 0.7], label: '精神', readout: '困 0.31', size: 'sm' } },
  { name: 'disabled', props: { value: 0, max: 200, label: '今日截图', disabled: true, disabledReason: '截图未授权' } },
  { name: 'zero', props: { value: 0, max: 48, label: '后台调用', size: 'sm' } },
  { name: 'full', props: { value: 200, max: 200, label: '今日截图', size: 'lg' } },
  { name: 'over', props: { value: 231, max: 200, label: '今日截图', size: 'lg', readout: '231/200 │ 超出 31' } },
  { name: 'threshold-70', props: { value: 70, max: 100, label: '额度', size: 'lg', readout: '70 %' } },
  { name: 'negative', props: { value: -0.12, max: 1, tone: 'level', label: '心情', readout: '−0.12', size: 'sm' } },
  { name: 'diverging', props: { value: -0.1, max: 0.6, center: 0.2, marks: [0], label: '心情', readout: '−0.10', size: 'sm' } },
  { name: 'diverging-up', props: { value: 0.5, max: 0.6, center: 0.2, marks: [0], label: '心情', readout: '+0.50', size: 'sm' } },
  { name: 'mini', props: { value: 5, max: 12, label: '后台调用', size: 'mini' } },
];
