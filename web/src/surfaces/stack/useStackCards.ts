import { useEffect, useState } from 'react';
import { getBridge, type StackPayload } from '../../bridge';

export interface StackCards {
  data: StackPayload | undefined;
  error: string | null;
  pending: boolean;
  retry: () => void;
}

/**
 * Card set pushed by `bridge.stack.onCards`; `state=loading|error` in the URL freezes those views for screenshots.
 * A retry keeps what was shown until the next push, so an error never drops back to the skeleton.
 */
export function useStackCards(viewState: string | null): StackCards {
  const bridge = getBridge();
  const [attempt, setAttempt] = useState(0);
  const [got, setGot] = useState<{ data?: StackPayload; error?: string }>({});
  useEffect(() => {
    if (viewState === 'loading') return;
    if (viewState === 'error') return setGot({ error: '后台服务没有响应' });
    return bridge.stack.onCards(
      (data) => setGot({ data }),
      (e) => setGot({ error: e.detail ?? e.code }),
    );
  }, [bridge, viewState, attempt]);
  return { data: got.data, error: got.error ?? null, pending: !got.data && !got.error, retry: () => setAttempt((n) => n + 1) };
}
