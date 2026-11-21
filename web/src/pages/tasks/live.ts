// Page clock and delivery receipts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentdCallError } from '../../bridge/agentd';
import type { Delivery } from '../../domain';
import { appNow } from '../../bridge/clock';
import { sendReceipt } from './actions';

/** Wall clock, re-read every 30 s; the fake bridge freezes it at the fixtures' NOW. */
export function useClock(): number {
  const real = typeof window !== 'undefined' && !!window.agenticComplex;
  const [now, setNow] = useState(appNow);
  useEffect(() => {
    if (!real) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [real]);
  return now;
}

export type ReceiptKind = 'presented' | 'viewed';

/**
 * Sends each receipt once per delivery, one at a time per delivery: every receipt raises its revision, so the next one
 * uses the reply. `onDelivery` gets each reply; `onConflict` runs when agentd says the row changed elsewhere.
 */
export function useReceipts(deliveries: readonly Delivery[], onDelivery: (d: Delivery) => void, onConflict: () => void) {
  const latest = useRef(new Map<string, Delivery>());
  const chain = useRef(new Map<string, Promise<void>>());
  const sent = useRef(new Set<string>());
  const retried = useRef(new Set<string>());
  const handlers = useRef({ onDelivery, onConflict });
  handlers.current = { onDelivery, onConflict };
  for (const d of deliveries) {
    const known = latest.current.get(d.id);
    if (!known || d.revision >= known.revision) latest.current.set(d.id, d);
  }
  return useCallback((id: string, kind: ReceiptKind) => {
    const key = `${id}:${kind}`;
    if (sent.current.has(key)) return;
    sent.current.add(key);
    const prev = chain.current.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const d = latest.current.get(id);
      if (!d || d.redacted || (kind === 'presented' ? d.presented_at != null : d.presented_at != null && d.viewed_at != null)) return;
      try {
        // Opening a detail is also presentation. Serialize both against the
        // returned revisions so no entry point can leave presented_at empty.
        let reply = d;
        for (const action of kind === 'viewed' ? ['presented', 'viewed'] as const : ['presented'] as const) {
          if ((action === 'presented' ? reply.presented_at : reply.viewed_at) != null) continue;
          reply = await sendReceipt(reply, action);
          latest.current.set(id, reply);
          handlers.current.onDelivery(reply);
        }
      } catch (e) {
        // A receipt is bookkeeping: a stale row reloads and tries once more; other failures wait for the next page load.
        if (!(e instanceof AgentdCallError && e.status === 409) || retried.current.has(key)) return;
        retried.current.add(key);
        sent.current.delete(key);
        handlers.current.onConflict();
      }
    });
    chain.current.set(id, next);
  }, []);
}
