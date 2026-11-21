import { useEffect, useState } from 'react';
import { getBridge } from '../../../bridge';

export interface Ritual {
  /** Highest priority kind a tap would say now (rituals.py `KINDS`). */
  kind: string;
  /** Epoch ms the pending set last changed. */
  since: number;
}

/**
 * The ritual a tap on her may claim (server.py `ritual_check`); null when none. `presence` (`/desktop/presence`
 * `ritual`) stands until the first `/feed` `pending`, which then rules.
 */
export function useRitual(seed: Ritual | null, presence: Ritual | null): Ritual | null {
  const [ritual, setRitual] = useState<Ritual | null | undefined>(seed ?? undefined);
  useEffect(
    () =>
      getBridge().feed.subscribe(
        (e) => {
          if (e.event !== 'pending') return;
          const d = JSON.parse(e.data) as { kinds?: unknown; since?: unknown };
          const kind = Array.isArray(d.kinds) && typeof d.kinds[0] === 'string' ? d.kinds[0] : null;
          const since = typeof d.since === 'string' ? Date.parse(d.since) : NaN;
          setRitual(kind ? { kind, since: Number.isNaN(since) ? Date.now() : since } : null);
        },
        () => {},
      ),
    [],
  );
  return ritual === undefined ? presence : ritual;
}
