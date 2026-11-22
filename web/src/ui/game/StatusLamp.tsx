import type { VisualStateKey } from '../../domain/states';
import { stateVisual } from '../../domain/status';
import styles from './StatusLamp.module.css';

/** 游戏方灯（工厂 state_* 灯）配状态词：14 px 色块加深框，形状随状态——成功实心绿、在跑蓝灯带圆环、待处理黄灯闪带菱形、注意黄灯带 ▲、失败红灯带 ×、空闲空心灰、已停空心灰带横杠。状态词和形状取 domain/status.ts。用在页面的行里；桌面上她头顶的小圆标是 StatusMark。 */
export interface StatusLampProps {
  /** 状态（domain/status.ts 的键） */
  state: VisualStateKey;
  /** 改写状态词（「运行中」「没有响应」）；不给用 status.ts 的词 */
  label?: string;
  /** 放在深色名牌块上：状态词一律用深色主题的颜色 */
  onDark?: boolean;
}

export function StatusLamp({ state, label, onDark }: StatusLampProps) {
  const v = stateVisual(state);
  return (
    <span className={styles.lamp} data-stub="StatusLamp" data-tone={v.tone} data-shape={v.shape} data-on-dark={onDark || undefined}>
      <i className={styles.light} aria-hidden="true" />
      <span className={styles.word}>{label ?? v.label}</span>
    </span>
  );
}

export const StatusLampDemos: Array<{ name: string; props: StatusLampProps }> = [
  { name: 'ok', props: { state: 'ok', label: '运行中' } },
  { name: 'running', props: { state: 'running' } },
  { name: 'waiting', props: { state: 'awaiting_approval' } },
  { name: 'warning', props: { state: 'warning', label: '响应慢' } },
  { name: 'failed', props: { state: 'broken' } },
  { name: 'idle', props: { state: 'idle', label: '未运行' } },
  { name: 'stopped', props: { state: 'stopped' } },
  { name: 'on-dark', props: { state: 'error', label: '没有响应', onDark: true } },
];
