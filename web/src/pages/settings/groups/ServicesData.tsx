import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../../../bridge';
import type { RuntimeSnapshot } from '../../../bridge/runtimeSnapshot';
import type { ServiceActionResult, ServiceId, ServiceRecord } from '../../../bridge/services';
import { Region, type RegionSource } from '../../../ui';
import { readServices } from '../api';
import { useSettings } from '../ctx';
import { SERVICE_NAME } from '../servicesDraft';
import { NetworkSection } from './Network';
import { ServicesGroup } from './Services';

const ACT_VERB = { start: '启动', stop: '停止', restart: '重启' } as const;
type Act = keyof typeof ACT_VERB;
/** ensure_failed and stop_failed say nothing beyond the verb; the script's line, when there is one, says why. */
const ACT_REASON: Record<Extract<ServiceActionResult, { ok: false }>['error'], string> = {
  not_supervised: '该连接方式不由应用负责启停',
  unknown_service: '应用未识别该服务',
  ensure_failed: '',
  stop_failed: '',
};

const NO_REPLY = '客户端无响应';

/** app.runtime's `services`, kept current, and a read again after an op; null until read. */
function useServiceRuntimes(): [RuntimeSnapshot['services'] | null, () => void] {
  const [services, setServices] = useState<RuntimeSnapshot['services'] | null>(null);
  useEffect(() => {
    const bridge = getBridge();
    let live = true;
    bridge.app.runtime().then(
      (r) => live && setServices((prev) => prev ?? r.services),
      () => {},
    );
    const off = bridge.app.onRuntime((r) => setServices(r.services));
    return () => {
      live = false;
      off();
    };
  }, []);
  const reread = useCallback(() => void getBridge().app.runtime().then((r) => setServices(r.services), () => {}), []);
  return [services, reread];
}

/** 服务: config.json's `services` through the shell's `services.*`, with each one's state from app.runtime; read again after each 应用.
 *  Then 网络, a settings row that does not wait for the services' read. */
export function ServicesData() {
  const { model, ro, goPage } = useSettings();
  const [records, setRecords] = useState<RegionSource<Record<ServiceId, ServiceRecord>>>({ status: 'pending', data: undefined });
  const [busy, setBusy] = useState(false);
  const [runtimes, rereadRuntimes] = useServiceRuntimes();

  const read = useCallback(
    () =>
      readServices().then(
        (data) => setRecords({ status: 'success', data, dataUpdatedAt: Date.now() }),
        (error: unknown) => setRecords((q) => ({ ...q, status: 'error', error })),
      ),
    [],
  );
  // The bottom bar's 应用 writes what it saved into the model: the record and its state are read again.
  const applied = [model.vals.svc_tts, model.vals.svc_motion, model.vals.svc_llm].join('\n');
  useEffect(() => {
    void read();
    rereadRuntimes();
  }, [read, rereadRuntimes, applied]);

  const run = (act: Act) => async (id: ServiceId) => {
    setBusy(true);
    const what = `${ACT_VERB[act]}${SERVICE_NAME[id]}`;
    try {
      const r = await getBridge().services[act](id);
      const reason = r.ok ? '' : ACT_REASON[r.error];
      const head = r.ok ? `已${what}` : `未能${what}${reason ? `：${reason}` : ''}`;
      model.notify({ message: [head, r.line].filter(Boolean).join(' │ '), ...(r.ok ? { severity: 'success' as const } : { severity: 'danger' as const, persistent: true }) });
      rereadRuntimes();
    } catch {
      model.notify({ message: `未能${what}：${NO_REPLY}`, severity: 'danger', persistent: true });
    }
    setBusy(false);
  };

  return (
    <>
      <Region q={{ ...records, refetch: read }} what="服务" reserve={{ rows: 6 }}>
        {(data) => (
          <ServicesGroup
            records={data}
            runtimes={{ tts: runtimes?.tts ?? null, motion: runtimes?.motion ?? null, llm: runtimes?.llm ?? null }}
            onStart={(id) => void run('start')(id)}
            onStop={(id) => void run('stop')(id)}
            onRestart={(id) => void run('restart')(id)}
            onLogs={() => goPage({ page: 'diag', tab: 'logs', src: 'services' })}
            disabled={ro || busy}
          />
        )}
      </Region>
      <NetworkSection />
    </>
  );
}
