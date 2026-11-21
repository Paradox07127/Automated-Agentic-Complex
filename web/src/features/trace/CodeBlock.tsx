import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import styles from './CodeBlock.module.css';

/** 代码块：行号、换行开关、复制；超过 preview 行先显示前 preview 行，加「全部 N 行」。 */
export interface CodeBlockProps {
  /** 原文 */
  code: string;
  /** 收起时显示的行数，默认 20 */
  preview?: number;
  /** 默认自动换行，默认 true */
  wrap?: boolean;
  /** 读屏名称，例如文件名 */
  label?: string;
  /** 复制；不给就写系统剪贴板 */
  onCopy?: (code: string) => void;
}

export function CodeBlock({ code, preview = 20, wrap: wrapInit = true, label = '原文', onCopy }: CodeBlockProps) {
  const [all, setAll] = useState(false);
  const [wrap, setWrap] = useState(wrapInit);
  const [copied, setCopied] = useState(false);
  const lines = code.replace(/\n$/, '').split('\n');
  const cut = !all && lines.length > preview;
  const shown = cut ? lines.slice(0, preview) : lines;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (onCopy) {
      onCopy(code);
      setCopied(true);
      return;
    }
    try {
      await getBridge().clipboard.writeText(code);
      setCopied(true);
    } catch {
      // The main surface may refuse clipboard (op_not_allowed); then nothing was copied.
    }
  };

  return (
    <div data-stub="CodeBlock" data-selectable="" className={styles.root} data-wrap={wrap || undefined} role="group" aria-label={label}>
      <div className={styles.tools}>
        <button type="button" className={styles.tool} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          自动换行
        </button>
        <button type="button" className={styles.tool} onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className={styles.pre}>
        {shown.map((l, i) => (
          <span key={i} className={styles.line} data-line="">
            <span className={styles.ln} data-ln="" aria-hidden="true">
              {i + 1}
            </span>
            <code className={styles.code}>{l || ' '}</code>
          </span>
        ))}
      </pre>
      {lines.length > preview && (
        <button type="button" className={styles.more} aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? '收起' : `全部 ${lines.length} 行`}
        </button>
      )}
    </div>
  );
}
