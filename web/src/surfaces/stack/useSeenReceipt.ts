import { useEffect, useRef, useState } from 'react';
import { call, seg } from '../../bridge/agentd';

const visible = () => document.visibilityState === 'visible';

/**
 * Posts `/commitments/<id>/seen` once for each id while its reminder card is `shown` on a visible page; an id that leaves
 * `ids` and comes back (snoozed, then due again) posts again. A failed post is dropped.
 */
export function useSeenReceipt(ids: readonly string[], shown: boolean) {
  const [onScreen, setOnScreen] = useState(visible);
  useEffect(() => {
    const update = () => setOnScreen(visible());
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const sent = useRef(new Set<string>());
  const key = ids.join('\n');
  useEffect(() => {
    const now = key ? key.split('\n') : [];
    for (const id of sent.current) if (!now.includes(id)) sent.current.delete(id);
    if (!shown || !onScreen) return;
    for (const id of now) {
      if (sent.current.has(id)) continue;
      sent.current.add(id);
      void call('POST', `/commitments/${seg(id)}/seen`, {}).catch(() => {});
    }
  }, [key, shown, onScreen]);
}
