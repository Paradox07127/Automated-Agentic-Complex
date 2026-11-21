import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatMs, stateVisual, type VisualStateKey } from '../../domain';
import { Icon, Missing, StatusTag, type IconName } from '../../ui';
import styles from './TraceLine.module.css';

/** 轨迹行：图标、标题、一行描述、状态、行尾时长；有展开区时可点开，↵/空格切换，→ 展开，← 收起。 */
export interface TraceLineProps {
  /** 前置图标 */
  icon?: IconName;
  /** 标题，例如「执行命令」 */
  title: string;
  /** 一行描述，超出截断，悬停看全文 */
  desc?: string;
  /** 状态 */
  state: VisualStateKey;
  /** 时长（毫秒）；null 写「—」；不给不占位 */
  durationMs?: number | null;
  /** 展开区；没有就是一行普通行 */
  children?: ReactNode;
  /** 默认展开 */
  defaultOpen?: boolean;
}

const CJK = /([　-〿㐀-鿿＀-￯]+)/;

/** Chinese runs stay in the sans face; runs with letters or path characters (commands, paths, ids) are set in mono. */
function descParts(desc: string): Array<{ text: string; mono: boolean }> {
  return desc
    .split(CJK)
    .filter((t) => t !== '')
    .map((text) => ({ text, mono: !CJK.test(text) && /[A-Za-z~/._-]/.test(text) }));
}

export function TraceLine({ icon, title, desc, state, durationMs, children, defaultOpen = false }: TraceLineProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const expandable = children != null;
  const tone = stateVisual(state).tone;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const next = e.key === 'Enter' || e.key === ' ' ? !open : e.key === 'ArrowRight' ? true : e.key === 'ArrowLeft' ? false : null;
    if (next == null) return;
    e.preventDefault();
    setOpen(next);
  };

  const row = (
    <>
      <span className={styles.chev} data-open={open || undefined} aria-hidden="true">
        {expandable && <Icon name="chev" size={14} />}
      </span>
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
      )}
      <span className={styles.title}>{title}</span>
      {desc && (
        <span className={styles.desc} title={desc}>
          {descParts(desc).map((p, i) =>
            p.mono ? (
              <span key={i} data-mono="">
                {p.text}
              </span>
            ) : (
              p.text
            ),
          )}
        </span>
      )}
      <span className={styles.state}>
        <StatusTag state={state} iconOnly />
      </span>
      {durationMs !== undefined && (
        <span className={`${styles.dur} num`}>
          {/* Inside the role="button" row the Missing ⓘ would be a nested control that also toggles the row. */}
          {durationMs == null ? expandable ? '—' : <Missing why="unsupported" /> : formatMs(durationMs)}
        </span>
      )}
    </>
  );

  return (
    <div data-stub="TraceLine" className={styles.root} data-tone={tone} data-open={(expandable && open) || undefined}>
      {expandable ? (
        <div role="button" tabIndex={0} className={styles.row} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)} onKeyDown={onKeyDown}>
          {row}
        </div>
      ) : (
        <div className={styles.row}>{row}</div>
      )}
      {expandable && open && (
        <div id={id} className={styles.detail}>
          {children}
        </div>
      )}
    </div>
  );
}
