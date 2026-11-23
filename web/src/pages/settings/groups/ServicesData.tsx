import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../../../bridge';
import type { RuntimeSnapshot } from '../../../bridge/runtimeSnapshot';
import type { ServiceActionResult, ServiceId, ServiceRecord, ServicesSaveResult } from '../../../bridge/services';
import { Region, type RegionSource } from '../../../ui';
import { readServices } from '../api';
import { useSettings } from '../ctx';
import { ServicesGroup, type ServiceRejected } from './Services';

const NAME: Record<ServiceId, string> = { tts: '语音服务', motion: '动作服务', llm: '模型服务' };

type SaveError = Exclude<Extract<ServicesSaveResult, { ok: false }>['error'], 'invalid_record' | 'declined'>;
const SAVE_REASON: Record<SaveError, string> = {
  config_unreadable: '读不到配置文件',
  write_failed: '配置文件写不进去',
  token_not_cleared: '旧的语音令牌删不掉，地址没有改',
  unknown_service: '外壳不认识这个服务',
};

const ACT_VERB = { start: '启动', stop: '停止', restart: '重启' } as const;
type Act = keyof typeof ACT_VERB;
/** ensure_failed and stop_failed say nothing beyond the verb; the script's line, when there is one, says why. */
const ACT_REASON: Record<Extract<ServiceActionResult, { ok: false }>['error'], string> = {
  not_supervised: '它的接法不由这里启停',
  unknown_service: '外壳不认识这个服务',
  ensure_failed: '',
  stop_failed: '',
};

const TOKEN_CLEARED = '语音服务地址换了，旧令牌已删除，请在声音组重新保存令牌';
const NO_REPLY = '外壳没有响应';

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

/** 服务: config.json's `services` through the shell's `services.*`, with each one's state from app.runtime. */
export function ServicesData() {
  const { model, ro, goPage } = useSettings();
  const [records, setRecords] = useState<RegionSource<Record<ServiceId, ServiceRecord>>>({ status: 'pending', data: undefined });
  const [rejected, setRejected] = useState<ServiceRejected | null>(null);
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
  useEffect(() => void read(), [read]);

  const save = async (id: ServiceId, record: ServiceRecord) => {
    setBusy(true);
    setRejected(null);
    let r: ServicesSaveResult | null = null;
    try {
      r = await getBridge().services.save(id, record);
    } catch {
      model.notify({ message: `没有保存${NAME[id]}：${NO_REPLY}`, severity: 'danger', persistent: true });
    }
    if (r?.ok) {
      await read();
      rereadRuntimes();
      model.notify(r.ttsTokenCleared ? { message: TOKEN_CLEARED, severity: 'warning', persistent: true } : { message: `已保存${NAME[id]}`, severity: 'success' });
    } else if (r?.error === 'invalid_record') {
      setRejected({ id, field: r.field, message: r.message });
      model.notify({ message: `没有保存${NAME[id]}：${r.message}`, severity: 'danger', persistent: true });
    } else if (r && r.error !== 'declined') {
      model.notify({ message: `没有保存${NAME[id]}：${SAVE_REASON[r.error]}`, severity: 'danger', persistent: true });
    }
    setBusy(false);
  };

  const run = (act: Act) => async (id: ServiceId) => {
    setBusy(true);
    const what = `${ACT_VERB[act]}${NAME[id]}`;
    try {
      const r = await getBridge().services[act](id);
      const reason = r.ok ? '' : ACT_REASON[r.error];
      const head = r.ok ? `已${what}` : `没能${what}${reason ? `：${reason}` : ''}`;
      model.notify({ message: [head, r.line].filter(Boolean).join(' │ '), ...(r.ok ? { severity: 'success' as const } : { severity: 'danger' as const, persistent: true }) });
      rereadRuntimes();
    } catch {
      model.notify({ message: `没能${what}：${NO_REPLY}`, severity: 'danger', persistent: true });
    }
    setBusy(false);
  };

  return (
    <Region q={{ ...records, refetch: read }} what="服务" reserve={{ rows: 6 }}>
      {(data) => (
        <ServicesGroup
          records={data}
          runtimes={{ tts: runtimes?.tts ?? null, motion: runtimes?.motion ?? null, llm: runtimes?.llm ?? null }}
          rejected={rejected}
          onSave={(id, record) => void save(id, record)}
          onStart={(id) => void run('start')(id)}
          onStop={(id) => void run('stop')(id)}
          onRestart={(id) => void run('restart')(id)}
          onLogs={() => goPage({ page: 'trace', tab: 'logs', src: 'services' })}
          disabled={ro || busy}
        />
      )}
    </Region>
  );
}
