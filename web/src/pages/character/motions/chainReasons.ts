// motion_tool `chain` problem reasons (C9) and `avatar.motionChain.apply` refusals, in Chinese.
import type { ChainProblem } from '../../../bridge';
import { shortName } from './graph';

/** Reason code → its text; `x` is the clip after the colon, `y` the second clip of `<a>><b>`. */
const REASONS: Record<string, (x: string, y: string) => string> = {
  bad_proposal: () => '提案不对：格式、角色不符，或者没有改动',
  stale: () => '角色包在你编辑之后变过了，请放弃改动、重新编辑',
  bad_edit: () => '这处改动的格式不对',
  unknown_clip: (x) => `角色包里没有片段 ${x}`,
  unknown_chain: (x) => `角色包里没有以 ${x} 起头的链`,
  bad_index: () => '位置不对：链的第一段不能换，也不能插在它前面',
  bad_hold: () => '保持秒数只能给循环段，且不能小于 0',
  bad_blend: () => '混合秒数要在 0–2 s 之间',
  source_return: (x) => `${x} 之后接什么由片段自带的回位决定，这里改不了`,
  cycle: (x) => `以 ${x} 起头的链会绕回自己`,
  no_return: (x) => `以 ${x} 起头的链最后回不到起头的站姿`,
  stance_breaks: (x, y) => `${x} 接 ${y} 时站姿接不上`,
  chain_key_lost: (x) => `手动动作用的 ${x} 不再是一条链的起头`,
  pool_pose_unmeasured: (x) => `池子里的 ${x} 姿势没有量过`,
  pool_start_family_unbridged: (x) => `池子里的 ${x} 起始姿势和站姿之间没有过渡`,
  pool_chain_end_off_base: (x) => `池子里的 ${x} 所在的链最后没有回到基础站姿`,
};

/** A problem's reason in Chinese; an unknown code stays as it is. */
export function reasonText(reason: string): string {
  const at = reason.indexOf(':');
  const code = at < 0 ? reason : reason.slice(0, at);
  const [x = '', y = ''] = at < 0 ? [] : reason.slice(at + 1).split('>');
  return REASONS[code]?.(shortName(x), shortName(y)) ?? reason;
}

/** `avatar.motionChain.*` rejection codes other than the ones that carry problems. */
const FAILURES: Record<string, string> = {
  stale: REASONS.stale!('', ''),
  chain_refused: '角色包没有接受这份改动，原因标在对应的段旁边',
  bad_proposal: REASONS.bad_proposal!('', ''),
  busy: '角色正在切换，或者另一个导入还没完成，稍后再试',
  validate_failed: '重建出的角色包没有通过渲染器校验，角色包没有改',
  invalid_args: '提案的格式不对',
  not_implemented: '这个版本还不支持改动作链的结构',
};

/** The text of a failed check or apply and the problems its detail carries (`stale`, `bad_proposal`, `chain_refused`). */
export function chainFailure(e: unknown): { text: string; problems: ChainProblem[] } {
  const { code = '', detail } = (e ?? {}) as { code?: string; detail?: string };
  let problems: ChainProblem[] = [];
  if (['stale', 'bad_proposal', 'chain_refused'].includes(code)) {
    try {
      const parsed: unknown = JSON.parse(detail ?? '');
      // The failure text already says `stale` and `bad_proposal`.
      if (Array.isArray(parsed)) problems = (parsed as ChainProblem[]).filter((p) => p.reason !== code);
    } catch {
      // Not JSON: an unreadable proposal's detail is plain text.
    }
  }
  return { text: FAILURES[code] ?? `没有完成：${detail || code || '桌面角色没有回应'}`, problems };
}
