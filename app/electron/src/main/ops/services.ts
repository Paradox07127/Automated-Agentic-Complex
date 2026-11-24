// `services.*`: config.json's `services` records, and starting and stopping the processes the shell runs for them. A save
// writes the record whole and restarts the service and agentd, whose arguments carry it.
import { existsSync, renameSync } from 'node:fs';
import { ttsTokenFile } from '../../common/agentd.ts';
import { BridgeFailure } from '../../common/bridge.ts';
import { isServiceId, SERVICE_DEFAULTS, SERVICE_IDS, type ServiceId, serviceRecord, ServiceRecordError, type ServiceRecord } from '../../common/config.ts';
import type { Ops, OpsContext } from './context.ts';
import { readObject, writeObject } from './settings.ts';

const origin = (url: string) => URL.parse(url)?.origin ?? url;
// Under ssh the url is always this machine's: the host behind it is ssh_host.
const endpoint = (r: ServiceRecord) => JSON.stringify([origin(r.url), r.mode === 'ssh' ? r.ssh_host : null, r.mode === 'local']);

export function servicesOps(ctx: OpsContext): Ops {
  const path = ctx.config.path;
  /** config.json's `services`, each id it leaves out at its default. */
  const stored = (raw: Record<string, unknown>): Record<ServiceId, ServiceRecord> => {
    const all = typeof raw.services === 'object' && raw.services !== null && !Array.isArray(raw.services) ? raw.services as Record<string, unknown> : {};
    return Object.fromEntries(SERVICE_IDS.map((id) => [id, Object.hasOwn(all, id) ? serviceRecord(id, all[id]) : SERVICE_DEFAULTS[id]])) as
      Record<ServiceId, ServiceRecord>;
  };
  const supervised = (id: unknown, act: (id: ServiceId) => Promise<unknown>) => {
    if (!isServiceId(id)) return { ok: false, error: 'unknown_service', line: null };
    if (!ctx.services) return { ok: false, error: 'not_supervised', line: null };
    return act(id);
  };
  let saving: Promise<unknown> = Promise.resolve();
  const save = async (id: ServiceId, record: ServiceRecord): Promise<Record<string, unknown>> => {
    let raw!: Record<string, unknown>, old!: ServiceRecord;
    // Saving over an unreadable file would drop every other key.
    const read = (): boolean => {
      try {
        raw = readObject(path);
        old = stored(raw)[id];
        return true;
      } catch {
        return false;
      }
    };
    if (!read()) return { ok: false, error: 'config_unreadable' };
    const ask = record.mode === 'ssh' && record.start_script !== ''
      && (old.mode !== 'ssh' || old.start_script !== record.start_script || old.ssh_host !== record.ssh_host)
      ? `保存后，按需启动脚本 ${record.start_script} 会经 SSH 在 ${record.ssh_host} 上执行。确定保存？`
      : record.mode === 'local' && (old.mode !== 'local' || JSON.stringify(old.command) !== JSON.stringify(record.command) || old.cwd !== record.cwd)
        ? `保存后，命令 ${record.command.join(' ')} 会在这台电脑上${record.cwd === '' ? '' : `的 ${record.cwd} 里`}执行。确定保存？`
        : null;
    if (ask !== null) {
      if (!(await ctx.confirm(ask))) return { ok: false, error: 'declined' };
      // config.json may have changed while the dialog was open.
      if (!read()) return { ok: false, error: 'config_unreadable' };
    }
    const services = typeof raw.services === 'object' && raw.services !== null && !Array.isArray(raw.services) ? raw.services : {};
    try {
      writeObject(path, { ...raw, services: { ...services, [id]: record } });
    } catch (e) {
      return { ok: false, error: 'write_failed', message: e instanceof Error ? e.message : String(e) };
    }
    // The token installed for the old TTS service is not sent to another one; the old record goes back when it stays.
    const ttsTokenCleared = id === 'tts' && old.mode !== 'off' && (record.mode === 'off' || endpoint(old) !== endpoint(record));
    if (ttsTokenCleared && ctx.config.supportDir !== null) {
      try {
        const token = ttsTokenFile(ctx.config.supportDir);
        if (existsSync(token + '.ref')) renameSync(token + '.ref', token + '.revoked');
      } catch (e) {
        try {
          writeObject(path, raw);
        } catch { /* reported as not cleared */ }
        return { ok: false, error: 'token_not_cleared', message: e instanceof Error ? e.message : String(e) };
      }
    }
    ctx.log(`services save ${id} mode=${record.mode}`);
    ctx.services?.saved(id);
    return { ok: true, ...(ttsTokenCleared && { ttsTokenCleared }) };
  };
  return {
    'services.read': () => {
      try {
        return stored(readObject(path));
      } catch (e) {
        if (e instanceof ServiceRecordError) throw new BridgeFailure('invalid_record', e.message);
        throw new BridgeFailure('config_unreadable', 'config.json');
      }
    },
    'services.save': ([id, value]) => {
      if (!isServiceId(id)) return { ok: false, error: 'unknown_service' };
      let record: ServiceRecord;
      try {
        record = serviceRecord(id, value);
      } catch (e) {
        if (!(e instanceof ServiceRecordError)) throw e;
        return { ok: false, error: 'invalid_record', field: e.field, message: e.message };
      }
      // Saved whole: an absent field is written at its default.
      const task = saving.then(() => save(id, record));
      saving = task.catch(() => {});
      return task;
    },
    'services.start': ([id]) => supervised(id, (s) => ctx.services!.start(s)),
    'services.stop': ([id]) => supervised(id, (s) => ctx.services!.stop(s)),
    'services.restart': ([id]) => supervised(id, (s) => ctx.services!.restart(s)),
  };
}
