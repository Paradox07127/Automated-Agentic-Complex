import { useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, seg } from '../../bridge/agentd';
import { factWrite, fromFact, type Fact, type FactCounts, type FactKind, type WireFact } from '../../domain';
import { errorText, isConflict } from './errors';

export const FACTS_KEY = ['memory', 'facts'] as const;

/** `GET /memory` with the facts read at `now`; `recording` is the inverse of agentd's `paused`. */
export interface MemoryView {
  recording: boolean;
  facts: Fact[];
  counts: FactCounts;
}

export async function readMemory(now: number): Promise<MemoryView> {
  const w = await get<{ paused: boolean; facts: WireFact[]; counts: FactCounts }>('/memory');
  return { recording: !w.paused, facts: w.facts.map((f) => fromFact(f, now)), counts: w.counts };
}

export type WriteResult = { ok: true } | { ok: false; conflict: boolean; message: string };

export interface FactsModel {
  facts: Fact[];
  confirm: (f: Fact) => Promise<WriteResult>;
  reject: (f: Fact) => Promise<WriteResult>;
  forget: (f: Fact) => Promise<WriteResult>;
  correct: (f: Fact, text: string) => Promise<WriteResult>;
  /** `reinforced`: agentd already had this text and strengthened it instead of adding a row. */
  add: (text: string, kind: FactKind) => Promise<WriteResult & { reinforced?: boolean }>;
}

/** Writes to `/memory/facts…` with the row's version; the cached row takes the reply, then `GET /memory` is read again. */
export function useFacts(facts: Fact[]): FactsModel {
  const qc = useQueryClient();
  const reread = () => void qc.invalidateQueries({ queryKey: FACTS_KEY });
  const setRow = (id: string, next: (f: Fact) => Fact | null) =>
    qc.setQueryData<MemoryView>(FACTS_KEY, (d) => {
      if (!d) return d;
      const rows = d.facts.flatMap((f) => (f.id === id ? (next(f) ?? []) : [f]));
      const counts: FactCounts = { asserted_by_user: 0, confirmed_by_user: 0, observed_context: 0, inferred_hypothesis: 0 };
      for (const row of rows) counts[row.source] += 1;
      return { ...d, facts: rows, counts };
    });

  async function run(write: () => Promise<void>): Promise<WriteResult> {
    try {
      await write();
      reread();
      return { ok: true };
    } catch (e) {
      if (isConflict(e)) reread();
      return { ok: false, conflict: isConflict(e), message: errorText(e) };
    }
  }

  return {
    facts,
    confirm: (f) =>
      run(async () => {
        const r = await post<{ version: number }>(`/memory/facts/${seg(f.id)}/confirm`, factWrite(f));
        setRow(f.id, ({ state: _candidate, ...x }) => ({ ...x, version: r.version, source: 'confirmed_by_user', how: '推断后由你确认' }));
      }),
    reject: (f) =>
      run(async () => {
        await post(`/memory/facts/${seg(f.id)}/reject`, factWrite(f));
        setRow(f.id, () => null);
      }),
    forget: (f) =>
      run(async () => {
        await del(`/memory/facts/${seg(f.id)}?expected_version=${f.version}`);
        setRow(f.id, () => null);
      }),
    correct: (f, text) =>
      run(async () => {
        const r = await patch<{ version: number }>(`/memory/facts/${seg(f.id)}`, factWrite(f, text));
        setRow(f.id, (x) => ({ ...x, text, version: r.version }));
      }),
    add: async (text, kind) => {
      let reinforced = false;
      const r = await run(async () => {
        reinforced = (await post<{ fact_id: string; reinforced?: boolean }>('/memory/facts', { text, kind })).reinforced === true;
      });
      return r.ok ? { ...r, reinforced } : r;
    },
  };
}
