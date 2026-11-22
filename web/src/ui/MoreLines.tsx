import styles from './MoreLines.module.css';

/** 「全部 N 行」：代码、命令、差异、原文先显示前几行，下面一整条键展开全部，再点收起。只在放不下时给。 */
export interface MoreLinesProps {
  /** 全部的行数 */
  total: number;
  /** 已展开全部 */
  open: boolean;
  onToggle: () => void;
  /** 它展开的那块的 id */
  controls?: string;
}

export function MoreLines({ total, open, onToggle, controls }: MoreLinesProps) {
  return (
    <button type="button" className={styles.more} data-stub="MoreLines" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {open ? '收起' : `全部 ${total} 行`}
    </button>
  );
}

export const MoreLinesDemos: Array<{ name: string; props: MoreLinesProps }> = [
  { name: 'closed', props: { total: 45, open: false, onToggle: () => {} } },
  { name: 'open', props: { total: 45, open: true, onToggle: () => {} } },
];
