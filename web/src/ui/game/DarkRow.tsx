import { useRef, type CSSProperties, type ReactNode } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../fx/useGameClip';
import { GameSeg } from './GameSeg';
import { Diamond, MicroLabel } from './Marks';
import { Stepper } from './Stepper';
import styles from './DarkRow.module.css';

/** 左格状态：可播 ▶、缺资源 ⊘、由行为自动触发、已改（可恢复默认）↺、空心菱形（未选的选项）、出错 ⚠（橙色左边，状态行和失败行）、完成 ✓（黄）、新的待处理（红点橙菱形，橙色左边）。 */
export type DarkRowMark = 'play' | 'missing' | 'auto' | 'changed' | 'hollow' | 'warn' | 'ok' | 'new';

/** 左格自己的按钮（设定行的 ↺ 恢复默认）：细黄框里的切角键，悬停填黄，按下沉进右下的影子。 */
export interface DarkRowLeadAction {
  /** 读屏名称 */
  label: string;
  /** 悬停提示 */
  title?: string;
  disabled?: boolean;
  onPress: () => void;
}

/** ▶ 深色行（游戏档案页语音行）：左格放状态，主体是名字和副行，右侧槽放控件；悬停变亮，选中左缘 4 px 黄、左格变黄带呼吸框。紧凑款左格 34（925）。 */
export interface DarkRowProps {
  /** 名字 */
  title: ReactNode;
  /** 名字下的一行 */
  sub?: ReactNode;
  /** 左格，默认 play */
  mark?: DarkRowMark;
  /** 左格里放这个代替 mark 的图形（序号、CHG 菱形）；mark 仍定左格的底色 */
  lead?: ReactNode;
  /** 左格单独可点（不在 onPress 的按钮里） */
  leadAction?: DarkRowLeadAction;
  /** busy：应用中，一道黄光扫过、左格下一小段进度；fail：没改成，左缘红 */
  state?: 'busy' | 'fail';
  /** 键盘正落在这一行：细黄框，右缘外一个小三角 */
  focused?: boolean;
  /** 紧凑款：左格 34、矮一号 */
  compact?: boolean;
  /** 副行（种类，如「批准」）放在名字上面，读屏也先读它 */
  subFirst?: boolean;
  /** 左格宽（px）；不给是 52，紧凑款 34 */
  leadWidth?: number;
  /** 选中（正在预览、正在穿） */
  selected?: boolean;
  /** 右侧槽：开关、步进器等控件，不在按下区域里 */
  end?: ReactNode;
  /** 给了就是按钮（左格加主体），选中写 aria-pressed；不给是静态行 */
  onPress?: () => void;
}

/** What a screen reader hears after the name for each mark. */
const SAY: Record<DarkRowMark, string> = { play: '', missing: '缺资源', auto: '自动触发', changed: '已改', hollow: '', warn: '出错', ok: '', new: '待处理' };

function Glyph({ mark }: { mark: DarkRowMark }) {
  if (mark === 'hollow') return <Diamond tone="hollow" size={10} />;
  if (mark === 'new') return <Diamond size={8} />;
  if (mark === 'auto')
    return (
      <span className={styles.auto}>
        <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
          <path d="M5 12a7 7 0 0 1 12-4.9M19 12a7 7 0 0 1-12 4.9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M17.5 3v4.5H13M6.5 21v-4.5H11" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <MicroLabel>AUTO</MicroLabel>
      </span>
    );
  const path = {
    play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
    missing: (
      <g fill="none" stroke="currentColor" strokeWidth="2.2">
        <circle cx="12" cy="12" r="7.5" />
        <path d="M6.8 17.2 17.2 6.8" />
      </g>
    ),
    changed: (
      <g fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M7.5 8.5A7 7 0 1 1 5 13.5" />
        <path d="M4 4.5v5h5" />
      </g>
    ),
    warn: <path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 16.5v2" fill="none" stroke="currentColor" strokeWidth="2.2" />,
    ok: <path d="M4.5 12.5 10 18 19.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.6" />,
  }[mark];
  return (
    <svg className={styles.glyph} viewBox="0 0 24 24" width="18" height="18" focusable="false">
      {path}
    </svg>
  );
}

/** The selected lead's inner frame, breathing with attributecell_selected_loop. */
function Breath() {
  const ref = useRef<HTMLElement>(null);
  useGameClip(gameClips.charMarkLoop, ref, { autoplay: true });
  return <i ref={ref} className={styles.frame} data-g="root" />;
}

export function DarkRow({ title, sub, mark = 'play', lead, leadAction, state, focused, compact, subFirst, leadWidth, selected = false, end, onPress }: DarkRowProps) {
  const face = (
    <>
      {selected && <Breath />}
      {lead ?? <Glyph mark={mark} />}
    </>
  );
  const inner = (
    <>
      {!leadAction && (
        <span className={styles.lead} aria-hidden="true">
          {face}
        </span>
      )}
      <span className={styles.body}>
        {subFirst && sub != null && <span className={styles.sub}>{sub}</span>}
        <span className={styles.title}>{title}</span>
        {!subFirst && sub != null && <span className={styles.sub}>{sub}</span>}
        {SAY[mark] && <span className={styles.vh}>{`，${SAY[mark]}`}</span>}
      </span>
    </>
  );
  return (
    <div
      className={styles.row}
      data-stub="DarkRow"
      data-mark={mark}
      data-selected={selected || undefined}
      data-state={state}
      data-focused={focused || undefined}
      data-compact={compact || undefined}
      style={leadWidth != null ? ({ '--dr-lead-w': `${leadWidth}px` } as CSSProperties) : undefined}
    >
      {leadAction && (
        <button type="button" className={styles.lead} aria-label={leadAction.label} title={leadAction.title} disabled={leadAction.disabled} onClick={leadAction.onPress}>
          <svg className={styles.key} viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
            <path className={styles.ring} d="M6.5.5h25v25l-6 6h-25v-25z" />
            <path className={styles.plate} d="M7.5 3H29v21.5L24.5 29H3V7.5z" />
            <g className={styles.arrow} transform="translate(7.6 7.6) scale(.7)">
              <path d="M7.5 8.5A7 7 0 1 1 5 13.5" />
              <path d="M4 4.5v5h5" />
            </g>
          </svg>
        </button>
      )}
      {onPress ? (
        <button type="button" className={styles.hit} aria-pressed={selected} onClick={onPress}>
          {inner}
        </button>
      ) : (
        <div className={styles.hit}>{inner}</div>
      )}
      {end != null && <div className={styles.end}>{end}</div>}
    </div>
  );
}

const ON_OFF = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
];
const SHOWN = [
  { value: 'on', label: '显示' },
  { value: 'off', label: '隐藏' },
];
const LENGTH = [
  { value: 'short', label: '短' },
  { value: 'mid', label: '中' },
  { value: 'long', label: '长' },
];

export const DarkRowDemos: Array<{ name: string; props: DarkRowProps }> = [
  {
    name: 'play',
    props: {
      title: '开口说话',
      sub: '说话时',
      onPress: () => undefined,
      end: <GameSeg label="开口说话" variant="onoff" value="on" options={ON_OFF} />,
    },
  },
  { name: 'selected', props: { title: '点头附和', sub: '批准之后', selected: true, onPress: () => undefined } },
  { name: 'missing', props: { title: '思考', sub: '缺 think_02', mark: 'missing', onPress: () => undefined } },
  { name: 'auto', props: { title: '站立待机', sub: '空闲', mark: 'auto' } },
  { name: 'changed', props: { title: '裙摆', mark: 'changed', end: <Stepper label="裙摆" value="short" defaultValue="long" options={LENGTH} /> } },
  { name: 'hollow', props: { title: '夏装', sub: '导入的外观', mark: 'hollow', onPress: () => undefined } },
  { name: 'warn', props: { title: '角色未运行', sub: '退避 8 秒后重试', mark: 'warn' } },
  { name: 'ok', props: { title: '已导入「挥手」', mark: 'ok' } },
  { name: 'reset-lead', props: { title: '亮度', sub: '默认：1.0', mark: 'changed', leadAction: { label: '恢复「亮度」的默认', title: '恢复这一行的默认', onPress: () => undefined } } },
  { name: 'custom-lead', props: { title: '外套', lead: '01', state: 'busy', focused: true, end: <GameSeg label="外套" value="on" options={SHOWN} /> } },
  { name: 'compact', props: { title: '开口说话', sub: '说话时', compact: true, onPress: () => undefined } },
  { name: 'new', props: { title: '要不要把构建脚本里的测试重跑一遍？', sub: '批准', mark: 'new', compact: true, onPress: () => undefined, end: '还有 2 项' } },
  { name: 'sub-first', props: { title: '要不要把构建脚本里的测试重跑一遍？', sub: '批准', mark: 'new', compact: true, subFirst: true, leadWidth: 28, onPress: () => undefined } },
];
