// `settings.*` over config.json. A save runs the effects agentd and the login item take, and on Windows
// restarts the renderer; not the hot keys'. Hot keys the system refused read as none.
import { existsSync, readdirSync, readFileSync, renameSync, truncateSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BridgeFailure } from '../../common/bridge.ts';
import { storedSwitches, withSwitches } from '../../common/looks.ts';
import { GUIDE_SETTINGS } from '../../common/onboarding.ts';
import { agentdError } from '../../common/routes.ts';
import {
  allowsRightOption, behaviorSwitches, idsOfKeys, isHotkeyRow, parseChanges, planSave, Rejection, REVOKE_KINDS, rowById, schema, type SettingValue,
  settingValues, snapshot, validateHotkey, webHotkey, withSettings,
} from '../../common/settings.ts';
import { agentdLive, webLogsDir } from '../../common/config.ts';
import { DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR, loadConfig } from '../config.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';
import { clearPasted } from './adopt.ts';
import { listed } from './holding.ts';
import { askForPluginGrants } from './permissions.ts';

/** config.json's top-level object; throws when the file exists but is not a JSON object. */
export function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const o: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${basename(path)} is not an object`);
  return o as Record<string, unknown>;
}

/** The values that read as settings. */
function loadSettings(path: string): Record<string, SettingValue> {
  return settingValues(readObject(path));
}

const sortedKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])]));
};

/** Writes config.json with sorted keys through a temporary file. */
export function writeObject(path: string, object: Record<string, unknown>): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(sortedKeys(object), null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** Merges `values` into the file. */
export function saveSettings(path: string, values: Record<string, SettingValue>): void {
  const object = withSettings(existsSync(path) ? readObject(path) : {}, values);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(sortedKeys(object), null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

/** Empties the logs and the web log (their writers hold them open); returns how many files. */
function wipeLocalFiles(supportDir: string): number {
  clearPasted(supportDir);
  let count = 0;
  const logs = join(supportDir, 'logs'), web = webLogsDir(supportDir, DEFAULT_SUPPORT_DIR, DEFAULT_WEB_LOGS_DIR);
  const logFiles = [
    ...(existsSync(logs) ? readdirSync(logs).map((name) => join(logs, name)) : []),
    ...(web === logs ? [] : ['ui.log', 'ui.log.1'].map((name) => join(web, name)).filter((p) => existsSync(p))),
  ];
  for (const file of logFiles) {
    try {
      if (!lstatSync(file).isFile()) continue;
      truncateSync(file, 0);
      count += 1;
    } catch { /* gone meanwhile */ }
  }
  return count;
}

export function settingsOps(ctx: OpsContext): Ops {
  const path = ctx.config.path, platform = ctx.platform ?? 'mac';
  const refused = () => ctx.unregisteredHotkeys?.() ?? {};
  const unreadable = () => new BridgeFailure('config_unreadable', basename(path));
  const load = () => {
    try {
      return loadSettings(path);
    } catch {
      throw unreadable();
    }
  };
  const status = async (method: string, route: string, body: unknown): Promise<number> => {
    try {
      return (await ctx.agentd!.request(method, route, body)).status;
    } catch {
      return 0;
    }
  };
  /** Runs a save's effects; returns the config keys whose effect failed. */
  const apply = async (effects: ReturnType<typeof planSave>['effects']): Promise<string[]> => {
    const failed: string[] = [];
    for (const effect of effects) {
      if (effect.kind === 'revoke') {
        const s = await status('POST', '/context/privacy/sync', { revoke: [effect.revoke] });
        if (s !== 200) {
          ctx.log(`${effect.revoke} privacy_sync status=${s}`);
          failed.push(effect.key);
        }
      } else if (effect.kind === 'loginItem') {
        if (ctx.loginItem.enabled() === null) continue;
        ctx.loginItem.set(effect.on);
        if (ctx.loginItem.enabled() !== effect.on) failed.push('launch_at_login');
      } else if (effect.kind === 'restartAvatar' || effect.kind === 'fps' || effect.kind === 'hotkeys' || effect.kind === 'renderLive'
        || effect.kind === 'touch' || effect.kind === 'actionSwitch' || effect.kind === 'appearance' || effect.kind === 'weather') {
        continue;
      } else if (effect.kind === 'agentdLive') {
        let s = 0;
        try {
          s = await status('PUT', '/settings/live', agentdLive(readObject(path)));
        } catch (e) {
          ctx.log(`settings live: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (s !== 200) {
          ctx.log(`settings live put status=${s}`);
          failed.push(...effect.keys);
        }
      } else if (effect.kind === 'stateAffectsBehavior') {
        const s = await status('PUT', '/character/state/switch', { affects_behavior: effect.on });
        if (s !== 200) {
          ctx.log(`state switch put status=${s}`);
          failed.push('state_affects_behavior');
        }
      } else {
        let raw: Record<string, unknown> = {};
        try {
          raw = readObject(path);
        } catch { /* agentd's defaults */ }
        const s = await status('PUT', '/behavior/switches', behaviorSwitches(raw, ctx.dockOpen?.() ?? false));
        if (s !== 200) {
          ctx.log(`behavior switches put status=${s}`);
          failed.push(...effect.keys);
        }
      }
    }
    return failed;
  };
  /** The current character's table is stored and sent, the other configured characters' only stored
   *  (the link sends a stored table when her list comes, rule 28); a character without one gets one only to turn it off. */
  const setSwitch = (id: string, on: boolean) => {
    let characters: string[];
    try {
      characters = loadConfig(path, platform).characters.map((c) => c.id);
    } catch (e) {
      ctx.log(`${id} save: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const current = ctx.avatar?.currentCharacter ?? null;
    for (const character of characters) {
      const stored = storedSwitches(readObject(path), character);
      if (stored === null && on) continue;
      const table = { ...stored, [id]: on };
      if (character === current && ctx.looks) {
        const failed = (why: string) => ctx.log(`${id} save ${character} failed: ${why}`);
        ctx.looks.saveSwitches(character, table).then((r) => { if (r.error !== undefined) failed(r.error); },
          (e: unknown) => failed(e instanceof Error ? e.message : String(e)));
      } else {
        writeObject(path, withSwitches(readObject(path), character, table));
      }
    }
  };
  let saving: Promise<unknown> = Promise.resolve();
  const write = async (changes: Record<string, SettingValue>): Promise<Record<string, unknown>> => {
    let saved: Record<string, SettingValue>;
    try {
      saved = loadSettings(path);
    } catch {
      // Saving over an unreadable file would drop every other key.
      return { restart: 'none', notApplied: [], error: 'config.json 读不了，没有保存' };
    }
    const plan = planSave(saved, ctx.loginItem.enabled(), changes, platform, refused());
    if (plan.error !== undefined) return { restart: 'none', notApplied: [], error: plan.error };
    if (Object.keys(plan.write).length === 0) return { restart: 'none', notApplied: [] };
    try {
      saveSettings(path, plan.write);
    } catch (e) {
      return { restart: 'none', notApplied: [], error: `没能写入 config.json：${e instanceof Error ? e.message : String(e)}` };
    }
    // The save does not wait for the system's prompt.
    const turnedOn = Object.keys(plan.write).filter((k) => k.startsWith('plugins.') && plan.write[k] === true);
    if (turnedOn.length > 0) void askForPluginGrants(ctx, turnedOn.map((k) => k.slice('plugins.'.length)));
    for (const effect of plan.effects) {
      if (effect.kind === 'restartAvatar') ctx.supervisor?.restartAvatar?.();
      else if (effect.kind === 'fps') ctx.saved?.fps();
      else if (effect.kind === 'hotkeys') for (const [key, name] of effect.saved) ctx.saved?.hotkey(key, name);
      else if (effect.kind === 'renderLive') ctx.saved?.renderLive?.(effect.keys);
      else if (effect.kind === 'touch') ctx.saved?.touch?.();
      else if (effect.kind === 'actionSwitch') setSwitch(effect.id, effect.on);
      else if (effect.kind === 'appearance') ctx.saved?.appearance?.();
      else if (effect.kind === 'weather') ctx.saved?.weather?.();
    }
    const failed = plan.effects.length === 0 || !ctx.agentd ? [] : await apply(plan.effects);
    ctx.settingsChanged?.(Object.keys(plan.write));
    return { restart: plan.restart, notApplied: idsOfKeys(failed) };
  };
  return {
    'settings.schema': () => schema(platform, ctx.glassSupported ?? true),
    'settings.read': () => snapshot(load(), ctx.loginItem.enabled(), ctx.avatar ? listed(ctx.avatar).includes('camera_bust') : false, platform,
      refused(), ctx.glassSupported ?? true),
    'settings.save': ([changes]) => {
      if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
        throw new BridgeFailure('invalid_args', 'changes must be an object');
      }
      const guide = ctx.surface === 'onboarding';
      const other = guide ? Object.keys(changes).find((id) => !GUIDE_SETTINGS.has(id)) : undefined;
      if (other !== undefined) throw new BridgeFailure('op_not_allowed', `settings.save ${other}`);
      let parsed: Record<string, SettingValue>;
      try {
        parsed = parseChanges(changes as Record<string, unknown>, ctx.log, platform);
      } catch (e) {
        return { restart: 'none', notApplied: [], error: e instanceof Rejection ? e.message : String(e) };
      }
      // The guide has no 重启后台 button: a row it saves that the backend takes only at start restarts it at once.
      const task = saving.then(() => write(parsed)).then((r) => {
        if (guide && r.restart === 'backend') ctx.supervisor?.restart();
        return r;
      });
      // The page gets this save's failure from `task`; the next save waits for it but not on it.
      saving = task.catch(() => {});
      return task;
    },
    'settings.confirmDestructive': ([id]) => {
      const row = typeof id === 'string' ? rowById(id) : undefined;
      if (!row) return false;
      ctx.log(`settings consent id=${id} key=${row.item.key}`);
      return true;
    },
    /** protocol.ts `DeletionPreview`: what agentd would delete now if the data kind behind `id` were revoked. */
    'settings.previewDestructive': async ([id]) => {
      const kind = typeof id === 'string' ? REVOKE_KINDS[id] : undefined;
      if (kind === undefined) throw new BridgeFailure('unknown_setting', String(id));
      if (!ctx.agentd) throw new BridgeFailure('offline', 'agentd is unreachable');
      let reply: { status: number; body: Buffer };
      try {
        reply = await ctx.agentd.request('POST', '/context/privacy/sync', { revoke: [kind], dry_run: true });
      } catch {
        throw new BridgeFailure('offline', 'agentd is unreachable');
      }
      let body: unknown = null;
      try {
        body = JSON.parse(reply.body.toString('utf8'));
      } catch { /* checked below */ }
      if (reply.status < 200 || reply.status >= 300) {
        const e = agentdError(reply.status, body);
        throw new BridgeFailure(e.code, e.detail ?? `POST /context/privacy/sync status ${reply.status}`);
      }
      const counts = (body as { counts?: unknown } | null)?.counts;
      if (typeof counts !== 'object' || counts === null || !Object.values(counts).every(Number.isInteger)) {
        throw new BridgeFailure('failed', 'no counts in the dry run');
      }
      return { total: Object.values(counts as Record<string, number>).reduce((a, b) => a + b, 0), counts };
    },
    'settings.validateHotkey': ([id, combo]) => {
      if (typeof id !== 'string' || !isHotkeyRow(id)) throw new BridgeFailure('unknown_setting', String(id));
      const check = validateHotkey(id, combo, load, ctx.loginItem.enabled(), platform, refused());
      if ('error' in check) throw new BridgeFailure('invalid_hotkey', String(combo));
      return check;
    },
    /** The page's key caps of the next hot key pressed, or null; not saved. */
    'settings.recordHotkey': async ([id]) => {
      if (typeof id !== 'string' || !isHotkeyRow(id)) throw new BridgeFailure('unknown_setting', String(id));
      if (!ctx.recordHotkey) throw new BridgeFailure('not_implemented', 'settings.recordHotkey');
      const name = await ctx.recordHotkey(allowsRightOption(rowById(id)!));
      return name === null ? null : webHotkey(name);
    },
    /** agentd's `POST /reset`, then, only when it succeeded, the local files; the settings page's confirm card is the only ask. */
    'settings.wipeLocalData': async () => {
      if (!ctx.agentd) throw new BridgeFailure('failed', 'agentd is unreachable');
      let reply: { status: number; body: Buffer };
      try {
        reply = await ctx.agentd.request('POST', '/reset', { confirm: 'delete all local data' });
      } catch (e) {
        throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
      }
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>;
      } catch { /* checked below */ }
      if (reply.status < 200 || reply.status >= 300) {
        const e = agentdError(reply.status, body);
        throw new BridgeFailure(e.code, e.detail ?? `POST /reset status ${reply.status}`);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BridgeFailure('failed', 'POST /reset: not an object');
      if (ctx.config.supportDir === null) throw new BridgeFailure('failed', '没有数据目录（配置出错）');
      let files: number;
      try {
        files = wipeLocalFiles(ctx.config.supportDir);
      } catch (e) {
        throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
      }
      const rows = Object.values((body.deleted ?? {}) as Record<string, unknown>).filter(Number.isInteger).reduce((a: number, b) => a + (b as number), 0);
      ctx.log(`settings wipe local data: agentd rows=${rows} logs=${Array.isArray(body.logs) ? body.logs.length : 0} local files=${files}`);
      return null;
    },
    'settings.onChange': watch('settings.onChange', ctx.settingsChanges),
  };
}
