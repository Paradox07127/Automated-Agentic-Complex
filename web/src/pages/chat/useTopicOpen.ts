import { useRef } from 'react';
import type { Conversation } from '../../domain';

/**
 * Opening a topic: `opened` shows it, and unless it is archived or agentd is busy it becomes its character's active one.
 * Activations run one after another and only the last topic opened is still wanted, so a stale cached row cannot leave the
 * server on another topic than the one shown.
 */
export function useTopicOpen(busy: boolean, activate: (c: Conversation) => Promise<void>, opened: (c: Conversation) => void) {
  const wanted = useRef<string | null>(null);
  const run = useRef<{ queue: Promise<unknown>; pending: number }>({ queue: Promise.resolve(), pending: 0 });
  return (c: Conversation) => {
    opened(c);
    wanted.current = c.id;
    // While she works agentd refuses it; the row opens read-only with 继续此对话 waiting for her.
    if (c.archived || busy) return;
    const r = run.current;
    if (c.active && r.pending === 0) return;
    r.pending++;
    r.queue = r.queue.then(() => (wanted.current === c.id ? activate(c) : undefined)).finally(() => void r.pending--);
  };
}
