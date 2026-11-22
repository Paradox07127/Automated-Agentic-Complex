import { useRef, type ReactNode } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { useGameClip } from '../fx/useGameClip';
import { GameSeg } from './GameSeg';
import { Barcode, Diamond, MicroLabel } from './Marks';
import { Stepper } from './Stepper';
import styles from './DarkRow.module.css';

/** 左格状态：可播 ▶、缺资源 ⊘、由行为自动触发、已改（可恢复默认）↺、空心菱形（未选的选项）、出错 ⚠（橙色左边，状态行和失败行）。 */
export type DarkRowMark = 'play' | 'missing' | 'auto' | 'changed' | 'hollow' | 'warn';

/** ▶ 深色行（游戏档案页语音行）：左格放状态，主体是名字和副行，右侧槽放控件，右端竖条码和微型英文；悬停变亮，选中左缘 4 px 黄、左格变黄带呼吸框。 */
export interface DarkRowProps {
  /** 名字 */
  title: ReactNode;
  /** 名字下的一行 */
  sub?: ReactNode;
  /** 左格，默认 play */
  mark?: DarkRowMark;
  /** 选中（正在预览、正在穿） */
  selected?: boolean;
  /** 右侧槽：开关、步进器等控件，不在按下区域里 */
  end?: ReactNode;
  /** 条码下的微型英文，默认 AGENTIC */
  micro?: string;
  /** 给了就是按钮（左格加主体），选中写 aria-pressed；不给是静态行 */
  onPress?: () => void;
}

/** What a screen reader hears after the name for each mark. */
const SAY: Record<DarkRowMark, string> = { play: '', missing: '缺资源', auto: '自动触发', changed: '已改', hollow: '', warn: '出错' };

function Glyph({ mark }: { mark: DarkRowMark }) {
  if (mark === 'hollow') return <Diamond tone="hollow" size={10} />;
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

export function DarkRow({ title, sub, mark = 'play', selected = false, end, micro = 'AGENTIC', onPress }: DarkRowProps) {
  const inner = (
    <>
      <span className={styles.lead} aria-hidden="true">
        {selected && <Breath />}
        <Glyph mark={mark} />
      </span>
      <span className={styles.body}>
        <span className={styles.title}>{title}</span>
        {sub != null && <span className={styles.sub}>{sub}</span>}
        {SAY[mark] && <span className={styles.vh}>{`，${SAY[mark]}`}</span>}
      </span>
    </>
  );
  return (
    <div className={styles.row} data-stub="DarkRow" data-mark={mark} data-selected={selected || undefined}>
      {onPress ? (
        <button type="button" className={styles.hit} aria-pressed={selected} onClick={onPress}>
          {inner}
        </button>
      ) : (
        <div className={styles.hit}>{inner}</div>
      )}
      {end != null && <div className={styles.end}>{end}</div>}
      <span className={styles.deco} aria-hidden="true">
        <Barcode width={64} height={10} label={micro} />
      </span>
    </div>
  );
}

const ON_OFF = [
  { value: 'on', label: '开' },
  { value: 'off', label: '关' },
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
  { name: 'selected', props: { title: '点头附和', sub: '批准之后', selected: true, micro: 'PREVIEW', onPress: () => undefined } },
  { name: 'missing', props: { title: '思考', sub: '缺 think_02', mark: 'missing', onPress: () => undefined } },
  { name: 'auto', props: { title: '站立待机', sub: '空闲', mark: 'auto' } },
  { name: 'changed', props: { title: '裙摆', mark: 'changed', end: <Stepper label="裙摆" value="short" defaultValue="long" options={LENGTH} /> } },
  { name: 'hollow', props: { title: '夏装', sub: '导入的外观', mark: 'hollow', onPress: () => undefined } },
  { name: 'warn', props: { title: '角色未运行', sub: '退避 8 秒后重试', mark: 'warn' } },
];
