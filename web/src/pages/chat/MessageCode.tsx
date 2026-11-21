import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import { Icon } from '../../ui';
import styles from './Messages.module.css';

/** A fenced code block of a reply, with a copy button over its top right. */
export function MessageCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await getBridge().clipboard.writeText(code);
      setCopied(true);
    } catch {
      // The main surface may refuse clipboard (op_not_allowed); then nothing was copied.
    }
  };
  return (
    <div className={styles.messageCodeBox}>
      <pre className={styles.messageCode}><code>{code}</code></pre>
      <button type="button" className={styles.messageCodeCopy} aria-label="复制代码" title={copied ? '已复制' : '复制代码'} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  );
}
