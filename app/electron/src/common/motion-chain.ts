// `avatar.motionChain.*`: motion_tool `chain` (C9) on a structure proposal, and
// `avatar.playChain`'s argument and failures (C3 v27 rule 52).
import { BridgeFailure } from './bridge.ts';

const encoder = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bytesIn = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && encoder.encode(v).length >= min && encoder.encode(v).length <= max;
const key = (v: unknown) => bytesIn(v, 1, 128);
const sameKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(',') === [...keys].sort().join(',');

export const CHAIN_SCHEMA = 'endfield-motion-chain-proposal/v1';

/** Exactly `{schema, character, package_sha256, edits}`, and each edit with exactly its op's
 *  keys and types (`index` ≥ 1, `hold` ≥ 0, `seconds` 0–2); null otherwise. Whether its clips and chains exist is the tool's. */
export function chainProposal(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || !sameKeys(value, ['schema', 'character', 'package_sha256', 'edits']) || value.schema !== CHAIN_SCHEMA
    || !bytesIn(value.character, 1, 64) || typeof value.package_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.package_sha256)
    || !Array.isArray(value.edits) || value.edits.length === 0) return null;
  for (const e of value.edits) {
    if (!isObject(e) || !editHolds(e)) return null;
  }
  return value;
}

function editHolds(e: Record<string, unknown>): boolean {
  const keyOrNull = (v: unknown) => v === null || key(v);
  switch (e.op) {
    case 'set': {
      const fields = Object.keys(e).filter((k) => k !== 'op' && k !== 'clip');
      return 'clip' in e && fields.length > 0 && fields.every((k) => ['next', 'exit', 'hold'].includes(k)) && key(e.clip)
        && (e.next === undefined || keyOrNull(e.next)) && (e.exit === undefined || keyOrNull(e.exit))
        && (e.hold === undefined || e.hold === null || (typeof e.hold === 'number' && e.hold >= 0));
    }
    case 'replace': case 'insert':
      return sameKeys(e, ['op', 'chain', 'index', 'clip']) && key(e.chain) && Number.isInteger(e.index) && (e.index as number) >= 1
        && key(e.clip);
    case 'blend':
      return sameKeys(e, ['op', 'clip', 'seconds']) && key(e.clip) && typeof e.seconds === 'number' && e.seconds >= 0 && e.seconds <= 2;
    default:
      return false;
  }
}

/** motion_tool's arguments for `chain`: `check` only checks the proposal, else it rebuilds the installed pack with it. */
export function chainArgs(library: string, character: string, proposal: string, check: boolean, host: string): string[] {
  return ['chain', '--library', library, '--character', character, '--proposal', proposal, ...(check ? ['--check'] : []),
    '--validate-with', host];
}

/** The failure reasons `chain` prints; any other failure is `internal`. */
export const CHAIN_REASONS = ['stale', 'bad_proposal', 'chain_refused', 'validate_failed', 'busy', 'internal'];

/** The tool's stderr, whose last line is the failure JSON except after a usage error or a crash. */
export function chainFailure(stderr: string): BridgeFailure {
  const last = stderr.split(/\r?\n/).filter((l) => l !== '').at(-1) ?? '';
  try {
    const line: unknown = JSON.parse(last);
    if (isObject(line) && typeof line.reason === 'string' && CHAIN_REASONS.includes(line.reason)
      && (line.detail === undefined || line.detail === null || typeof line.detail === 'string')) {
      return new BridgeFailure(line.reason, typeof line.detail === 'string' ? line.detail : '');
    }
  } catch { /* plain text */ }
  return new BridgeFailure('internal', stderr.slice(-2000).trim());
}

/** The tool's reply: a check's `{ok, problems, graph_changes}`, an apply's `{ok: true, character, version}`. */
export function chainReply(line: string, check: boolean): Record<string, unknown> {
  let reply: unknown = null;
  try { reply = JSON.parse(line); } catch { /* checked below */ }
  const holds = isObject(reply) && typeof reply.ok === 'boolean' && (check
    ? Array.isArray(reply.problems) && isObject(reply.graph_changes)
    : reply.ok === true && typeof reply.character === 'string' && typeof reply.version === 'string');
  if (!holds) throw new BridgeFailure('internal', `motion_tool printed no result: ${line}`);
  return reply as Record<string, unknown>;
}

/** `avatar.playChain`'s argument (rule 52 (d)): a chain key of 1–128 bytes and speed 0.5, 1 or 2, 1 when absent. */
export function playChainArg(value: unknown): { start: string; speed: number } {
  const speed = isObject(value) ? (value.speed === undefined ? 1 : value.speed) : null;
  if (!isObject(value) || !key(value.start) || typeof speed !== 'number' || ![0.5, 1, 2].includes(speed)) {
    throw new BridgeFailure('invalid_args', '{start, speed? 0.5, 1 or 2}');
  }
  return { start: value.start, speed };
}

/** The failure texts for `play_chain`. */
const PLAYED_REJECTED: Record<string, string> = {
  missing: '该动作缺少资源文件', unknown_action: '角色无此动作', not_playable: '该动作不支持单独播放', busy: '角色正在执行其他动作',
};

/** `action_played` `rejected` takes its reason as the code. */
export const chainRejected = (reason: string) => new BridgeFailure(reason, PLAYED_REJECTED[reason] ?? '正在切换角色');

/** `play_chain`'s `ack` error: `timeout` and other refusals are `failed`, `unsupported` is `not_implemented`. */
export function chainRefused(reason: string): BridgeFailure {
  if (reason === 'unsupported') return new BridgeFailure('not_implemented', '当前版本角色不支持动作设置');
  if (reason === 'timeout') return new BridgeFailure('failed', '角色渲染进程无响应');
  if (reason === 'disconnected') return new BridgeFailure('failed', '角色连接已断开');
  return new BridgeFailure('failed', reason === 'invalid' ? '角色不含该动作编排链' : '正在切换角色，设置未保存');
}
