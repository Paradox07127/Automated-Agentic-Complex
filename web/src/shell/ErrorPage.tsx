import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { getBridge } from '../bridge';
import { Btn, ErrBar, Fold } from '../ui';
import styles from './ErrorPage.module.css';

/** `message\nstack` of whatever a page threw. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ''}`;
  return String(error);
}

/** Logs a page's exception for the shell, which writes it to ui.log and as a `page_exception` record to error.jsonl:
 *  `page_exception: [<route>: ]<Type: message>`, then the component stack's first frame, then the error's stack. */
export function reportPageException(error: unknown, componentStack: string | null | undefined, route?: string): void {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const frame = (componentStack ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  console.error(`page_exception: ${route ? `${route}: ` : ''}${head.split('\n')[0]}\n${frame}\n${stack}`);
}

/** Around the whole main window: what no page's own error boundary caught folds to one Chinese line with 重试. */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportPageException(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className={styles.root}>
        <ErrBar message="主窗口发生错误，已写入日志" onRetry={() => this.setState({ failed: false })} />
      </section>
    );
  }
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
        message="当前页面发生错误，已写入日志"
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
      <Fold label="详情">
        <pre className={styles.raw} data-selectable="">
          {text}
        </pre>
      </Fold>
    </section>
  );
}
