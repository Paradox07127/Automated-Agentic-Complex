import { useId, useState, type ReactNode } from 'react';
import { Icon, Menu, type MenuItem } from '../../ui';
import { CodeBlock } from './CodeBlock';
import styles from './RawFold.module.css';

/** 原始报告三段式：① 摘要 ≤3 行 → ② 图或表 → ③ 原文折叠，默认收起，用 CodeBlock。 */
export interface RawFoldProps {
  /** 摘要：结论、计数、最慢或失败的地方；超过 3 行只显示前 3 行 */
  summary: string[];
  /** 图或表 */
  children?: ReactNode;
  /** 原文 */
  raw?: string;
  /** 原文折叠行的名称，默认「原文」 */
  rawLabel?: string;
  /** 原文默认展开，默认 false */
  defaultOpen?: boolean;
  /** 原文的其他操作（在 Finder 中显示等），收进 ⋯ */
  actions?: MenuItem[];
  /** 复制原文；不给就写系统剪贴板 */
  onCopy?: (raw: string) => void;
}

export function RawFold({ summary, children, raw, rawLabel = '原文', defaultOpen = false, actions, onCopy }: RawFoldProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const count = raw == null ? 0 : raw.replace(/\n$/, '').split('\n').length;
  return (
    <section data-stub="RawFold" data-selectable="" className={styles.root} aria-label={rawLabel}>
      <ul className={styles.summary} data-summary="">
        {summary.slice(0, 3).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {children != null && <div className={styles.slot}>{children}</div>}
      {raw != null && (
        <div className={styles.raw}>
          <div className={styles.head}>
            <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
              <span className={styles.chev} data-open={open || undefined} aria-hidden="true">
                <Icon name="chev" size={14} />
              </span>
              {rawLabel}
              <span className={styles.count}>
                <span className="num">{count}</span> 行
              </span>
            </button>
            {actions && actions.length > 0 && <Menu label="更多操作" icon="more" items={actions} align="right" />}
          </div>
          {open && (
            <div id={id}>
              <CodeBlock code={raw} label={rawLabel} onCopy={onCopy} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
