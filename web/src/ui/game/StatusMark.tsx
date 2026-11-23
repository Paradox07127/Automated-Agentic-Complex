import type { VisualStateKey } from '../../domain/states';
import { stateVisual } from '../../domain/status';
import { StateGlyph } from './StateGlyph';
import styles from './StatusMark.module.css';

/** 状态小圆标（游戏头顶 IconHolder + StateNode 胶囊按 0.5 缩）：26 圆、白 .75 描边，里面是状态的形状——在忙蓝转圈、待处理橙菱形、出错红 ×、完成绿 ✓；可带胶囊字（「待批准 1」「出错了」）。桌面上她头旁和菜单栏弹窗用；页面行里用 StatusLamp。 */
export interface StatusMarkProps {
  /** 状态（domain/status.ts 的键） */
  state: VisualStateKey;
  /** 胶囊里的字；不给不画胶囊 */
  cap?: string;
  /** 胶囊字后的数 */
  count?: number;
  /** 悬停提示（「在跑 swift test │ 4 分钟」） */
  tip?: string;
  /** 读屏名称；不给用状态词和数 */
  label?: string;
  /** 画插头代替状态的形状：没连上（后台、桌面层） */
  plug?: boolean;
  /** 水平镜像：胶囊在圆标左边。标在她头左侧时用，胶囊朝外伸、不压到她 */
  mirror?: boolean;
  onClick?: () => void;
}

export function StatusMark({ state, cap, count, tip, label, plug, mirror, onClick }: StatusMarkProps) {
  const v = stateVisual(state);
  const name = label ?? (count != null ? `${cap ?? v.label} ${count} 项` : (cap ?? v.label));
  return (
    <button type="button" className={styles.mark} data-stub="StatusMark" data-tone={v.tone} data-mirror={mirror || undefined} aria-label={name} title={tip} onClick={onClick}>
      <span className={styles.disc}>
        {plug ? (
          <svg className={styles.plug} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-shape="plug">
            <path d="M5 2.5v3M9 2.5v3M3.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM7 11.5v1.5a1.5 1.5 0 0 0 1.5 1.5H13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : v.shape === 'check' ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-shape="check">
            <path d="M3.8 8.4l2.7 2.7 5.6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : v.shape === 'square' ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-shape="square">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        ) : (
          <StateGlyph shape={v.shape} size={14} />
        )}
      </span>
      {cap && (
        <span className={styles.cap} aria-hidden="true">
          {cap}
          {count != null && <b>{count}</b>}
        </span>
      )}
    </button>
  );
}

export const StatusMarkDemos: Array<{ name: string; props: StatusMarkProps }> = [
  { name: 'busy', props: { state: 'running', label: '在忙', tip: '在跑 swift test │ 4 分钟' } },
  { name: 'wait', props: { state: 'awaiting_approval', cap: '待批准', count: 1 } },
  { name: 'error', props: { state: 'error', cap: '出错了' } },
  { name: 'done', props: { state: 'done', label: '做完了' } },
  { name: 'offline', props: { state: 'unreachable', cap: '连不上后台', plug: true } },
  { name: 'offline-mirror', props: { state: 'unreachable', cap: '连不上后台', plug: true, mirror: true } },
];
