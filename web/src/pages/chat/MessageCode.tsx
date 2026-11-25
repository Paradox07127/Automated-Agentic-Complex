import { useEffect, useState } from 'react';
import { getBridge } from '../../bridge';
import { IconBtn } from '../../ui';
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
      <span className={styles.messageCodeCopy}>
        <IconBtn icon={copied ? 'check' : 'copy'} size="sm" label={copied ? '已复制' : '复制代码'} onClick={() => void copy()} />
      </span>
    </div>
  );
}
