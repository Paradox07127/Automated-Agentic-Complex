import { useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Btn, Modal } from '../../ui';
import { useSettings } from './ctx';
import { labelOf } from './registry';
import { serviceOf } from './servicesDraft';

/**
 * Leaving 设置 with drafts not applied or saved rows waiting for a backend restart asks first: 重启后台 (or 应用) applies the
 * drafts and restarts, 不重启 (or 放弃改动) drops the drafts and puts the waiting rows back to the values the backend runs with;
 * 留在设置, Escape and the backdrop stay with everything kept.
 */
export function LeaveGuard() {
  const { model, agentdOff, native } = useSettings();
  const [ask, setAsk] = useState<((stay: boolean) => void) | null>(null);
  const busy = useRef(false);
  const drafts = Object.keys(model.draft);
  // A stopped backend reads the waiting rows when it starts.
  const pending = agentdOff ? [] : Object.keys(model.pending);
  // The blocker keeps the function it was first given.
  const waiting = useRef(false);
  waiting.current = drafts.length + pending.length > 0;

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
  // One answer at a time, none while the bar's 应用 runs: a dismissal while applying or discarding is ignored.
  const run = async (act: () => Promise<boolean>) => {
    if (busy.current || model.applying) return;
    busy.current = true;
    try {
      answer(!(await act()));
    } finally {
      busy.current = false;
    }
  };
  const stay = () => !busy.current && answer(true);
  // A drafted config.json row (the plug-in a picked kernel needs) waits for a restart once applied.
  const restart = pending.length > 0 || (!agentdOff && drafts.some((id) => native?.rows[id]?.restart === 'backend'));
  // agentd's own drafts need it running; service cards and waiting rows go through the shell.
  const canApply = !agentdOff || drafts.every((id) => serviceOf(id));
  const go = () => run(async () => (await model.applyAll()) && (!restart || (await model.restartBackend())));
  const drop = () =>
    run(async () => {
      model.revertAll();
      return !restart || (await model.discardPending());
    });
  const dropLabel = restart ? '不重启' : '放弃改动';
  return (
    <Modal
      open
      title={`有 ${drafts.length + pending.length} 项设置还没生效`}
      note={
        <>
          {pending.length > 0 && <p>重启后台服务后生效：{pending.map(labelOf).join('、')}</p>}
          {drafts.length > 0 && <p>还没应用：{drafts.map(labelOf).join('、')}</p>}
          <p>{!canApply ? '后台服务没有运行，这些改动现在应用不了。放弃会撤销这些改动。' : restart ? '重启期间对话和观察暂停几秒。不重启会撤销这些改动。' : '不应用会撤销这些改动。'}</p>
        </>
      }
      danger={!canApply}
      confirmLabel={!canApply ? dropLabel : restart ? '重启后台' : '应用'}
      cancelLabel="留在设置"
      onConfirm={() => void (canApply ? go() : drop())}
      onCancel={stay}
    >
      {canApply && <Btn onClick={() => void drop()}>{dropLabel}</Btn>}
    </Modal>
  );
}
