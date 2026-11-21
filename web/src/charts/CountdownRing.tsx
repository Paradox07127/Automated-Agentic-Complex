import { formatRemaining, isUrgent } from '../domain';
import { fraction } from './scale';
import styles from './CountdownRing.module.css';

/** 倒计时环：直径 28（迷你 14）环，方头，缺口是已过时间；≤10 s 环改 trace 并写黄块 urgentText（到 0 不写）；没有分母不画环。 */
export interface CountdownRingProps {
  /** 剩余秒数；null 写「不限时」 */
  secondsLeft: number | null;
  /** 分母（window_s、backoff 秒数）；null 时只写剩余时间 */
  windowS: number | null;
  /** 默认 md */
  size?: 'md' | 'mini';
  /** 画在白纸卡上（环用深色） */
  onPaper?: boolean;
  /** 读屏前缀；读数已带「剩余」，默认不加 */
  label?: string;
  /** ≤10 s 时的提示，默认「即将超时」（重启倒计时写「即将重启」） */
  urgentText?: string;
}

const GEOM = { md: { d: 28, w: 2 }, mini: { d: 14, w: 2 } } as const;

export function CountdownRing({ secondsLeft, windowS, size = 'md', onPaper, label, urgentText = '即将超时' }: CountdownRingProps) {
  const urgent = isUrgent(secondsLeft);
  const soon = urgent && secondsLeft != null && secondsLeft > 0;
  const ring = windowS != null && windowS > 0 && secondsLeft != null;
  const left = ring ? fraction(secondsLeft, windowS) : 0;
  const { d, w } = GEOM[size];
  const r = (d - w) / 2;
  const c = 2 * Math.PI * r;
  const text = formatRemaining(secondsLeft);
  const aria = `${label ? `${label} ` : ''}${text}${ring ? `，窗口 ${windowS} 秒` : ''}${soon ? `，${urgentText}` : ''}`;
  return (
    <span
      role="timer"
      data-stub="CountdownRing"
      data-size={size}
      data-paper={onPaper || undefined}
      data-ring={ring ? 'yes' : 'no'}
      data-urgent={urgent || undefined}
      data-fraction={ring ? left.toFixed(2) : undefined}
      className={styles.root}
      aria-label={aria}
      title={ring ? `窗口 ${windowS} s │ ${text}\n悬停不会暂停倒计时` : undefined}
    >
      {ring && (
        <svg className={styles.ring} width={d} height={d} viewBox={`0 0 ${d} ${d}`} aria-hidden="true">
          <circle className={styles.track} cx={d / 2} cy={d / 2} r={r} strokeWidth={w} />
          {left > 0 && <circle className={styles.left} cx={d / 2} cy={d / 2} r={r} strokeWidth={w} strokeDasharray={`${(left * c).toFixed(2)} ${c.toFixed(2)}`} transform={`rotate(-90 ${d / 2} ${d / 2})`} />}
        </svg>
      )}
      <span className={styles.text} aria-hidden="true">
        {text}
      </span>
      {soon && (
        <span className={styles.urgent} aria-hidden="true">
          {urgentText}
        </span>
      )}
    </span>
  );
}

export const CountdownRingDemos: Array<{ name: string; props: CountdownRingProps }> = [
  { name: 'approval', props: { secondsLeft: 23, windowS: 55 } },
  { name: 'urgent', props: { secondsLeft: 8, windowS: 45, onPaper: true } },
  { name: 'no-window', props: { secondsLeft: 41, windowS: null } },
  { name: 'unlimited', props: { secondsLeft: null, windowS: null, size: 'mini' } },
  { name: 'full', props: { secondsLeft: 55, windowS: 55 } },
  { name: 'expired', props: { secondsLeft: 0, windowS: 55 } },
  { name: 'backoff', props: { secondsLeft: 130, windowS: 300, label: '后重启' } },
  { name: 'mini', props: { secondsLeft: 6, windowS: 50, size: 'mini' } },
];
