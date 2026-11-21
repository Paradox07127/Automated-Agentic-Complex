import { useEffect, useState } from 'react';
import { getBridge } from '../../../bridge';
import { nextPresence } from '../tags/presence';

/** agentd's `/desktop/presence` JSON as native forwards it, `offline` while native cannot reach agentd; null before the first push. */
export function usePresence(): unknown {
  const [presence, setPresence] = useState<unknown>(null);
  useEffect(() => getBridge().desktop.onPresence((raw) => setPresence((last: unknown) => nextPresence(last, raw))), []);
  return presence;
}
