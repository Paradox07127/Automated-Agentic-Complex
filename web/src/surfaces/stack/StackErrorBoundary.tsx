import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { getBridge } from '../../bridge';
import { ErrBar } from '../../ui';
import styles from './StackErrorBoundary.module.css';

/** The crashed stack folds to one line; its rect is the only click region so 重试 can be pressed. */
function Crashed({ onRetry }: { onRetry: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    getBridge().window.setInteractiveRegions([{ x: r.left, y: r.top, width: r.width, height: r.height }]);
  }, []);
  return (
    <div className={styles.root}>
      <div ref={ref} className={styles.line} data-region>
        <ErrBar message="浮窗出错，已记到日志" onRetry={onRetry} />
      </div>
    </div>
  );
}

/** Catches a render error of the stack surface and logs it through console.error, which the shell records. */
export class StackErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    console.error(`stack failed: ${text}`, info.componentStack ?? '');
  }

  render() {
    if (this.state.failed) return <Crashed onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}
