import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MoreLines } from '../../ui/MoreLines';
import styles from './CmdBlock.module.css';

/** 审批卡里的命令：收起时两行，放不下时「全部 N 行」在卡内展开成最多 12 行的滚动代码块。后台截断过的命令只收到前一段：整段直接给出并写明原长，不给「展开全部」。 */
export interface CmdBlockProps {
  cmd: string;
  /** 后台截断过，cmd 只是前一段 */
  truncated?: boolean;
  /** 截断前的字符数 */
  origLen?: number;
  /** 白纸卡：深底浅字 */
  paper?: boolean;
}

export function CmdBlock({ cmd, truncated, origLen, paper }: CmdBlockProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(false);
  // Wrapped lines the whole command takes; 0 while it fits in two.
  const [lines, setLines] = useState(0);
  const preId = useId();
  const full = open || !!truncated;

  // Measured only while clamped; a resize can push a command past two lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || full) return;
    const measure = () => {
      if (el.scrollHeight <= el.clientHeight) return setLines(0);
      const cs = getComputedStyle(el);
      const wrapped = Math.round((el.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
      // More than the two lines shown; an unlaid-out box (no line height) counts the command's own lines.
      setLines(Math.max(3, Number.isFinite(wrapped) ? wrapped : cmd.split('\n').length));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cmd, full]);

  return (
    <div data-stub="CmdBlock" className={styles.root} data-paper={paper || undefined}>
      <pre ref={ref} id={preId} className={styles.code} data-full={full || undefined} tabIndex={full ? 0 : undefined}>
        <code>{cmd}</code>
      </pre>
      {truncated ? (
        <p className={styles.trunc}>
          ▲ 命令已截断：原长 <span className="num">{origLen ?? '—'}</span> 字符，后台只传来上面这一段
        </p>
      ) : (
        lines > 0 && <MoreLines total={lines} open={open} controls={preId} onToggle={() => setOpen((o) => !o)} />
      )}
    </div>
  );
}
