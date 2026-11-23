// The fake bridge's `services.*`: config.json's `services` at the shell's defaults, every one off. It takes any record (the
// shell checks it), runs nothing, and reads a supervised service as running.
import type { RuntimeSnapshot } from '../protocol';
import type { ServiceId, ServiceRecord, ServicesOps } from '../services';

const DEFAULTS: Record<ServiceId, ServiceRecord> = {
  tts: { mode: 'off', url: 'http://127.0.0.1:9888', ssh_host: '', start_script: '', command: [], cwd: '' },
  motion: { mode: 'off', url: 'http://127.0.0.1:48830', ssh_host: '', start_script: '', command: [], cwd: '' },
  llm: { mode: 'off', url: 'http://127.0.0.1:11434/v1', ssh_host: '', start_script: '', command: [], cwd: '' },
};

const copy = (r: Record<ServiceId, ServiceRecord>) =>
  Object.fromEntries(Object.entries(r).map(([id, x]) => [id, { ...x, command: [...x.command] }])) as Record<ServiceId, ServiceRecord>;

export function fakeServices(): { ops: ServicesOps; runtime: () => RuntimeSnapshot['services'] } {
  const records = copy(DEFAULTS);
  const supervised = (id: ServiceId) => records[id].mode === 'ssh' || records[id].mode === 'local';
  const act = async (id: ServiceId) => (supervised(id) ? { ok: true as const, line: null } : { ok: false as const, error: 'not_supervised' as const, line: null });
  return {
    ops: {
      read: async () => copy(records),
      save: async (id, record) => {
        const cleared = id === 'tts' && records.tts.mode !== 'off' && (record.mode === 'off' || records.tts.url !== record.url);
        records[id] = { ...record, command: [...record.command] };
        return { ok: true, ...(cleared && { ttsTokenCleared: true as const }) };
      },
      start: act,
      stop: act,
      restart: act,
    },
    runtime: () => Object.fromEntries((Object.keys(records) as ServiceId[]).map((id) =>
      [id, { mode: records[id].mode, state: supervised(id) ? { kind: 'running' as const } : null, pid: null, detail: null }])) as RuntimeSnapshot['services'],
  };
}
