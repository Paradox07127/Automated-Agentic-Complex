import { stateVisual, type RunPhase, type RunState } from '../domain';
import { ShapeGlyph } from './StateMark';
import common from './chart.module.css';
import styles from './RunRing.module.css';

const GLYPH: Record<RunPhase, string> = { prepare: '准', tool: '工', verify: '验', awaiting: '待' };
const PHASE_TEXT: Record<RunPhase, string> = { prepare: '准备', tool: '在跑', verify: '验证', awaiting: '待处理' };

/** 运行状态框：思考/执行工具画墨色实线框，等你黄块 ◆，出错黄块 ✕，结束空心；框心写阶段字；最小 22 px。 */
export interface RunRingProps {
  /** 运行状态 */
  state: RunState;
  /** 阶段，决定环心字形：准 / 工 / 验 / 等 */
  phase?: RunPhase;
  /** 类别，只写进 data-category；颜色只表示状态 */
  category?: 'mission' | 'neutral';
  /** 22 / 20 px，默认 md */
  size?: 'md' | 'desk';
}

export function RunRing({ state, phase, category = 'mission', size = 'md' }: RunRingProps) {
  const v = stateVisual(state);
  const glyph = phase && (v.tone === 'running' || v.tone === 'waiting') ? GLYPH[phase] : '';
  const label = phase && v.tone === 'running' ? `${v.label} │ ${PHASE_TEXT[phase]}` : v.label;
  const big = v.shape === 'ring' || v.shape === 'diamond';
  return (
    <span role="img" data-stub="RunRing" data-tone={v.tone} data-shape={v.shape} data-category={category} data-size={size} className={`${styles.root} ${common.tip}`} aria-label={label} data-tip={label}>
      {v.shape === 'ring' && <span className={styles.ring} aria-hidden="true" />}
      {v.shape === 'diamond' && <span className={styles.diamond} aria-hidden="true" />}
      {!big && (
        <span className={styles.small} aria-hidden="true">
          <ShapeGlyph shape={v.shape} token={v.token} size={12} />
        </span>
      )}
      {glyph && (
        <b className={styles.glyph} aria-hidden="true">
          {glyph}
        </b>
      )}
    </span>
  );
}

export const RunRingDemos: Array<{ name: string; props: RunRingProps }> = [
  { name: 'tool', props: { state: 'running_tool', phase: 'tool' } },
  { name: 'thinking', props: { state: 'thinking', phase: 'prepare', category: 'neutral' } },
  { name: 'verify', props: { state: 'verifying', phase: 'verify', size: 'desk' } },
  { name: 'waiting', props: { state: 'awaiting_approval', phase: 'awaiting', category: 'neutral' } },
  { name: 'error', props: { state: 'error' } },
  { name: 'succeeded', props: { state: 'succeeded' } },
  { name: 'interrupted', props: { state: 'interrupted' } },
  { name: 'queued', props: { state: 'queued' } },
];
