import { useState } from 'react';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { getBridge } from '../bridge';
import { Btn, ErrBar } from '../ui';
import styles from './ErrorPage.module.css';

/** `message\nstack` of whatever a page threw. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ''}`;
  return String(error);
}

/** A page's render error, inside the content area: one Chinese line, 重试 and 复制错误; the original text stays folded. */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const text = errorText(error);
  const copy = async () => {
    try {
      await getBridge().clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Nothing was copied; the fold below still shows the text.
    }
  };
  return (
    <section className={styles.root}>
      <ErrBar
        message="这一页出错了，已记到日志"
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
        extra={
          <Btn size="sm" variant="ghost" icon="copy" onClick={() => void copy()}>
            {copied ? '已复制' : '复制错误'}
          </Btn>
        }
      />
      <details className={styles.fold}>
        <summary>详情</summary>
        <pre className={styles.raw} data-selectable="">
          {text}
        </pre>
      </details>
    </section>
  );
}
