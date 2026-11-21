import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import { stateVisual, type VisualShape, type VisualStateKey } from '../domain';
import { useChartLabel } from './ChartLabel';
import { ShapeGlyph } from './StateMark';
import common from './chart.module.css';
import palette from './palette.module.css';
import styles from './CompositionBar.module.css';

/** Segment colour: a state tone, a category, or a chart series. */
export type SegmentTone = 'waiting' | 'running' | 'done' | 'failed' | 'ok' | 'warning' | 'idle' | 'mission' | 'neutral' | 's1' | 's2' | 'disabled';

export interface CompositionSegment {
  key: string;
  label: string;
  count: number;
  tone: SegmentTone;
  /** How many of `count` are unconfirmed (drawn with the hatch). */
  hatched?: number;
  /** 明度档：同色系列按序变浅（1 墨，2 次墨，3 chip），例如新鲜度 */
  shade?: 1 | 2 | 3;
}

/** 构成条：100% 堆叠、段序固定、两端括号，系列用墨、次墨、chip、斜线纹四档，条下的图例写标签和计数，也是筛选单选组；点段或图例筛选，被选段加 trace 三角、图例反相；失败计数是黄块；全为 0 时只写一行字。 */
export interface CompositionBarProps {
  /** 段，按固定顺序 */
  segments: CompositionSegment[];
  /** 图名，也是图例单选组的读屏名称 */
  label: string;
  /** 已选段 key（筛选中） */
  value?: string | null;
  /** 条高，默认 10 */
  height?: 8 | 10 | 12;
  /** 在这段之后画竖刻度（可信分界） */
  dividerAfter?: string;
  /** 条下的口径说明 */
  note?: string;
  /** 点段；再点一次清除（null） */
  onPick?: (key: string | null) => void;
  /** 要强调的段 key：用强调色 */
  emph?: string;
}

const STATE_OF: Partial<Record<SegmentTone, VisualStateKey>> = { waiting: 'waiting', running: 'running', done: 'done', ok: 'ok', failed: 'failed', warning: 'warning', idle: 'idle' };
const TOKEN: Record<SegmentTone, string> = {
  waiting: '--ef-state-waiting',
  running: '--ef-state-running',
  done: '--ef-state-ok',
  ok: '--ef-state-ok',
  failed: '--ef-state-failed',
  warning: '--ef-state-warning',
  idle: '--ef-chart-cell-empty',
  // Categories are told apart by legend text and position, not hue: ink, secondary ink, then the hatch level.
  mission: '--v3-ink-1',
  neutral: '--v3-ink-2',
  s1: '--v3-ink-1',
  s2: '--v3-ink-2',
  disabled: '--v3-hatch',
};

/** Colour token and shape of a segment tone; state tones take their `stateVisual` shape. */
export function segmentVisual(tone: SegmentTone): { token: string; shape: VisualShape | null } {
  const state = STATE_OF[tone];
  return { token: TOKEN[tone], shape: state ? stateVisual(state).shape : null };
}

export function CompositionBar({ segments, label, value = null, height = 10, dividerAfter, note, onPick, emph }: CompositionBarProps) {
  const [local, setLocal] = useState<string | null>(value);
  const sel = onPick ? value : local;
  const total = segments.reduce((n, s) => n + Math.max(0, s.count), 0);
  const shown = segments.filter((s) => s.count > 0);
  const pick = (key: string | null) => {
    const next = key === sel ? null : key;
    if (onPick) onPick(next);
    else setLocal(next);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = shown.findIndex((s) => s.key === sel);
    const j = i < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    const k = shown[j]?.key;
    if (k != null) (onPick ?? setLocal)(k);
  };
  const summary = segments.map((s) => `${s.label} ${s.count}`).join('，');
  const lbl = useChartLabel(label, summary);
  if (total === 0) {
    return (
      <div data-stub="CompositionBar" data-height={height} data-empty="" className={styles.root}>
        <p className={common.emptyLine}>{note ?? `${label}：没有数据`}</p>
      </div>
    );
  }
  return (
    <div data-stub="CompositionBar" data-height={height} data-divider={dividerAfter} className={`${palette.palette} ${styles.root}`}>
      {lbl.text}
      <div className={styles.bar} style={{ height }} {...lbl.img}>
        <span className={styles.bk}>[</span>
        <span className={styles.segs}>
          {shown.map((s) => {
            const hatch = Math.min(s.count, s.hatched ?? 0);
            return (
              <span
                key={s.key}
                className={`${styles.seg} ${common.tip}`}
                data-tone={s.tone}
                data-on={s.key === sel || undefined}
                data-hatched={s.hatched || undefined}
                data-shade={s.shade}
                data-count={s.count}
                data-tip={`${s.label} ${s.count}${hatch ? `\n其中待确认 ${hatch}` : ''}\n点击筛选，再点一次清除`}
                data-divider={s.key === dividerAfter || undefined}
                style={{ flexGrow: s.count, ['--c' as string]: s.key === emph ? 'var(--v3-emph)' : `var(${segmentVisual(s.tone).token})` }}
                onClick={() => pick(s.key)}
              >
                {hatch > 0 && <i className={styles.hatch} style={{ width: `${(hatch / s.count) * 100}%` }} />}
                {s.key === dividerAfter && <i className={styles.divider} />}
              </span>
            );
          })}
        </span>
        <span className={styles.bk}>]</span>
      </div>
      <div role="radiogroup" aria-label={`${label}：${summary}`} className={styles.legend} onKeyDown={onKey}>
        {segments.map((s) => {
          const v = segmentVisual(s.tone);
          const on = s.key === sel;
          const hatch = Math.min(s.count, s.hatched ?? 0);
          const body = (
            <>
              {v.shape ? <ShapeGlyph shape={v.shape} token={v.token} size={8} /> : <i className={styles.sw} data-shade={s.shade} style={{ ['--c' as string]: `var(${v.token})` }} />}
              {s.label} <span className={styles.num}>{s.count}</span>
              {s.hatched ? <span className={styles.hatchNote}>（待确认 {s.hatched}）</span> : null}
            </>
          );
          if (s.count === 0) {
            return (
              <span key={s.key} className={styles.lg} data-zero="">
                {body}
              </span>
            );
          }
          return (
            <button
              key={s.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${s.label} ${s.count}${hatch ? `，待确认 ${hatch}` : ''}`}
              tabIndex={on || (sel == null && s === shown[0]) ? 0 : -1}
              className={styles.lg}
              data-on={on || undefined}
              data-tone={s.tone}
              data-shade={s.shade}
              onClick={() => pick(s.key)}
            >
              {body}
            </button>
          );
        })}
        {note && <span className={styles.note}>{note}</span>}
      </div>
    </div>
  );
}

export const CompositionBarDemos: Array<{ name: string; props: CompositionBarProps }> = [
  { name: 'tasks', props: { label: '任务状态', segments: [{ key: 'waiting', label: '待处理', count: 3, tone: 'waiting' }, { key: 'running', label: '进行中', count: 3, tone: 'running' }, { key: 'done', label: '已完成', count: 1, tone: 'done' }, { key: 'failed', label: '失败', count: 1, tone: 'failed' }] } },
  { name: 'memory', props: { label: '记忆来源', value: 'inferred_hypothesis', dividerAfter: 'confirmed_by_user', note: '竖线左边是用户陈述或确认的', segments: [{ key: 'asserted_by_user', label: '用户陈述', count: 3, tone: 'mission' }, { key: 'confirmed_by_user', label: '用户确认', count: 1, tone: 'ok' }, { key: 'observed_context', label: '观察所得', count: 2, tone: 'neutral', hatched: 1 }, { key: 'inferred_hypothesis', label: '推断', count: 2, tone: 'warning', hatched: 2 }] } },
  { name: 'shades', props: { label: '按新鲜度筛选', height: 8, segments: [{ key: 'today', label: '今天', count: 4, tone: 's1', shade: 1 }, { key: 'd7', label: '7 天内', count: 6, tone: 's1', shade: 2 }, { key: 'd30', label: '30 天内', count: 3, tone: 's1', shade: 3 }, { key: 'old', label: '超 30 天', count: 5, tone: 'disabled' }] } },
  { name: 'empty', props: { label: '任务状态', note: '还没有任务 │ 新建一个任务后这里按状态分段', segments: [{ key: 'waiting', label: '待处理', count: 0, tone: 'waiting' }, { key: 'running', label: '进行中', count: 0, tone: 'running' }, { key: 'done', label: '已完成', count: 0, tone: 'done' }] } },
  { name: 'emph', props: { label: '按新鲜度筛选', height: 8, emph: 'today', segments: [{ key: 'today', label: '今天', count: 4, tone: 's1' }, { key: 'd7', label: '7 天内', count: 6, tone: 's2' }, { key: 'old', label: '超 30 天', count: 5, tone: 'disabled' }] } },
  { name: 'single', props: { label: '任务状态', height: 12, segments: [{ key: 'done', label: '已完成', count: 9, tone: 'done' }, { key: 'failed', label: '失败', count: 0, tone: 'failed' }] } },
  { name: 'tiny-segment', props: { label: '任务状态', height: 8, segments: [{ key: 'running', label: '进行中', count: 48, tone: 'running' }, { key: 'idle', label: '空闲', count: 30, tone: 'idle' }, { key: 'failed', label: '失败', count: 1, tone: 'failed' }] } },
];
