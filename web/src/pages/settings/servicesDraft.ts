// The 服务 cards' edits as drafts of the page: each service's fields as typed, saved whole by the bottom bar's 应用.
import { getBridge } from '../../bridge';
import type { ServiceId, ServiceRecord, ServicesSaveResult } from '../../bridge/services';

/** The command field as argv: whitespace splits, a quoted span stays whole and loses its quotes. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** One argument as splitCommand reads it back: bare, in the quotes it does not hold, or, holding both, as adjacent quoted spans. */
function quoteArg(a: string): string {
  if (a !== '' && !/[\s"']/.test(a)) return a;
  if (!a.includes('"')) return `"${a}"`;
  if (!a.includes("'")) return `'${a}'`;
  return a
    .split(/(["'])/)
    .filter(Boolean)
    .map((p) => (p === '"' ? `'"'` : p === "'" ? `"'"` : `'${p}'`))
    .join('');
}

/** argv back into the field, quoting what splitCommand would otherwise split or strip. */
export function joinCommand(argv: string[]): string {
  return argv.map(quoteArg).join(' ');
}

export const SERVICE_NAME: Record<ServiceId, string> = { tts: '语音服务', motion: '动作服务', llm: '自建模型接口（兼容 API）' };

/** The card's row id, which is also its draft key. */
export const serviceRow = (id: ServiceId) => `svc_${id}`;
const ROW_SERVICE: Readonly<Record<string, ServiceId>> = { svc_tts: 'tts', svc_motion: 'motion', svc_llm: 'llm' };
export const serviceOf = (row: string): ServiceId | null => ROW_SERVICE[row] ?? null;

/** A record as the card's fields hold it: the command as typed. */
export type ServiceDraft = Omit<ServiceRecord, 'command'> & { command: string };

export const draftOf = (r: ServiceRecord): ServiceDraft => ({ ...r, command: joinCommand(r.command) });

/** What a draft saves: the fields without the blanks around them, the command as argv, in one key order. */
export function recordOf(d: ServiceDraft): ServiceRecord {
  return { mode: d.mode, url: d.url.trim(), ssh_host: d.ssh_host.trim(), start_script: d.start_script.trim(), command: splitCommand(d.command), cwd: d.cwd.trim() };
}

export const sameRecord = (a: ServiceRecord, b: ServiceRecord) => JSON.stringify(recordOf(draftOf(a))) === JSON.stringify(recordOf(draftOf(b)));

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The field that keeps a record from being saved, and why; null when it can be. */
export function problem(d: ServiceRecord): ['url' | 'ssh_host' | 'command', string] | null {
  if (d.mode === 'off') return null;
  let u: URL | null = null;
  try {
    u = new URL(d.url);
  } catch {
    // stays null
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return ['url', '地址要以 http:// 或 https:// 开头'];
  // The shell and agentd refuse these too.
  if (u.username || u.password || u.search || u.hash) return ['url', '地址不能带用户名、密码、查询串或片段'];
  if (d.mode === 'url') return null;
  if (!LOOPBACK.has(u.hostname) || !u.port) return ['url', '要填回环地址和端口'];
  if (d.mode === 'ssh' && !d.ssh_host) return ['ssh_host', 'SSH 主机没填'];
  if (d.mode === 'local' && d.command.length === 0) return ['command', '命令没填'];
  return null;
}

type SaveError = Exclude<Extract<ServicesSaveResult, { ok: false }>['error'], 'invalid_record' | 'declined'>;
const SAVE_REASON: Record<SaveError, string> = {
  config_unreadable: '读不到配置文件',
  write_failed: '配置文件写不进去',
  token_not_cleared: '旧的语音令牌删不掉，地址没有改',
  unknown_service: '外壳不认识这个服务',
};

export const TOKEN_CLEARED = '语音服务地址换了，旧令牌已删除，请在「服务 › 语音服务」里重新保存令牌';

/** A field the check or the shell refused, with its reason. */
export interface ServiceRejected { field: string; message: string }

export type ServiceApplied =
  | { ok: true; record: ServiceRecord; tokenCleared: boolean }
  /** `message` null: the user declined the shell's confirm. */
  | { ok: false; message: string | null; rejected?: ServiceRejected };

/** Saves one card's draft through `services.save`, which restarts the service and the backend. */
export async function applyService(id: ServiceId, draft: ServiceDraft): Promise<ServiceApplied> {
  const record = recordOf(draft);
  const fail = (why: string, rejected?: ServiceRejected): ServiceApplied => ({ ok: false, message: `没有保存${SERVICE_NAME[id]}：${why}`, rejected });
  const bad = problem(record);
  if (bad) return fail(bad[1], { field: bad[0], message: bad[1] });
  let r: ServicesSaveResult;
  try {
    r = await getBridge().services.save(id, record);
  } catch {
    return fail('外壳没有响应');
  }
  if (r.ok) return { ok: true, record, tokenCleared: r.ttsTokenCleared === true };
  if (r.error === 'declined') return { ok: false, message: null };
  if (r.error === 'invalid_record') return fail(r.message, { field: r.field, message: r.message });
  return fail(SAVE_REASON[r.error]);
}
