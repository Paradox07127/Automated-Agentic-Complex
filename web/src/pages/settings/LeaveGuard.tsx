import { useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Modal } from '../../ui';
import { useSettings } from './ctx';
import { labelOf } from './registry';

/**
 * Leaving 设置 with drafts not applied or saved rows waiting for a backend restart asks first: 重启后台 (or 应用) applies the
 * drafts and restarts, 不重启 drops the drafts and puts the waiting rows back to the values the backend runs with.
 */
export function LeaveGuard() {
  const { model, agentdOff } = useSettings();
  const [ask, setAsk] = useState<((stay: boolean) => void) | null>(null);
  const drafts = Object.keys(model.draft);
  const pending = Object.keys(model.pending);
  // The blocker keeps the function it was first given.
  const waiting = useRef(false);
  waiting.current = !agentdOff && drafts.length + pending.length > 0;

  useBlocker({
    shouldBlockFn: ({ next }) => {
      if (!waiting.current || next.pathname.startsWith('/settings')) return false;
      return new Promise<boolean>((resolve) => setAsk(() => resolve));
    },
    enableBeforeUnload: false,
  });

  if (!ask) return null;
  const answer = (stay: boolean) => {
    setAsk(null);
    ask(stay);
  };
  const restart = pending.length > 0;
  const go = async () => {
    const ok = (await model.applyAll()) && (!restart || (await model.restartBackend()));
    answer(!ok);
  };
  const drop = async () => {
    model.revertAll();
    answer(!(await model.discardPending()));
  };
  return (
    <Modal
      open
      title={`有 ${drafts.length + pending.length} 项设置还没生效`}
      note={
        <>
          {pending.length > 0 && <p>重启后台服务后生效：{pending.map(labelOf).join('、')}</p>}
          {drafts.length > 0 && <p>还没应用：{drafts.map(labelOf).join('、')}</p>}
          <p>{restart ? '重启期间对话和观察暂停几秒。不重启会撤销这些改动。' : '不应用会撤销这些改动。'}</p>
        </>
      }
      confirmLabel={restart ? '重启后台' : '应用'}
      cancelLabel={restart ? '不重启' : '放弃改动'}
      onConfirm={() => void go()}
      onCancel={() => void drop()}
    />
  );
}
