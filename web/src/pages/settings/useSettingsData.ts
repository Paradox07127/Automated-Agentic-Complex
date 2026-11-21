import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from '../../bridge/agentd';
import { getBridge } from '../../bridge';
import { useRuntimePublic } from '../../data/runtime';
import { fromRun } from '../../domain/adapt';
import { isoWithOffset } from '../../domain/units';
import { clock, readBlacklist, readDiag, readGateEvents, readModels, readRuns, readScopes, readShotRuns } from './api';
import { demoDiag } from './demoInit';
import { demo as slot } from './demoSlot';
import { blockedLines, dayStart, diagView, gateEvents, shotEvents, ymd } from './diag';
import { loadNative, type SchemaRow } from './native';
import type { WireDiagSlice, WireModelSettings } from './wire';

const once = { retry: false, refetchOnWindowFocus: false } as const;

/**
 * Every read the settings page makes: the native config through the bridge, the rest from agentd. `/diag/state` is
 * kept current by the diag stream's `state` events (the feed carries no observation events). `demo` reaches only the
 * fake bridge's mocks.
 */
export function useSettingsData(demo: string | null) {
  const bridge = getBridge();
  const qc = useQueryClient();
  const fake = !window.agenticComplex;

  const native = useQuery({ queryKey: ['settings', 'native', demo], queryFn: () => loadNative(bridge, demo), ...once });
  const schema = useQuery({
    queryKey: ['settings', 'schema'],
    queryFn: async () => Object.fromEntries(((await bridge.settings.schema()) as SchemaRow[]).map((r) => [r.id, r])),
    ...once,
  });
  const connection = useQuery({ queryKey: ['settings', 'connection', demo], queryFn: () => bridge.agentd.connection(), ...once });
  const runtime = useRuntimePublic({ demo });
  const models = useQuery({ queryKey: ['settings', 'models'], queryFn: () => (fake && demo ? get<WireModelSettings>(`/model/settings?demo=${demo}`) : readModels()), ...once });
  const diag = useQuery({ queryKey: ['settings', 'diag'], queryFn: readDiag, ...once });
  const blacklist = useQuery({ queryKey: ['settings', 'blacklist'], queryFn: readBlacklist, ...once });
  const scopes = useQuery({ queryKey: ['settings', 'scopes'], queryFn: async () => (await readScopes()).scopes, ...once });
  const runs = useQuery({ queryKey: ['settings', 'runs'], queryFn: async () => (await readRuns()).runs.map(fromRun), ...once });
  // The preview's day events come from this page's mock: the diag mock answers these two paths without them.
  const shots = useQuery({
    queryKey: ['settings', 'shots', demo],
    queryFn: async () => shotEvents(fake ? slot.shotRuns!(demo) : (await readShotRuns(ymd(clock()))).runs),
    ...once,
  });
  const gate = useQuery({
    queryKey: ['settings', 'gate', demo],
    queryFn: async () => {
      const events = fake ? slot.gateEvents!(demo) : (await readGateEvents(isoWithOffset(dayStart(clock())))).events;
      return { events: gateEvents(events), blocked: blockedLines(events) };
    },
    ...once,
  });

  useEffect(
    () =>
      bridge.diag.subscribe(
        (e) => {
          if (e.event !== 'state') return;
          try {
            qc.setQueryData(['settings', 'diag'], JSON.parse(e.data) as WireDiagSlice);
          } catch {
            void diag.refetch();
          }
        },
        () => void diag.refetch(),
      ),
    [bridge, qc],
  );

  // A menu changed config.json (e.g. 自由活动): read the native values again.
  useEffect(() => bridge.settings.onChange(() => void qc.invalidateQueries({ queryKey: ['settings', 'native'] })), [bridge, qc]);

  const view = useMemo(() => diagView(fake ? demoDiag(demo, diag.data ?? null) : (diag.data ?? null)), [diag.data, fake, demo]);
  return { native, schema, connection, runtime, models, diag, view, blacklist, scopes, runs, shots, gate };
}

export type SettingsData = ReturnType<typeof useSettingsData>;
