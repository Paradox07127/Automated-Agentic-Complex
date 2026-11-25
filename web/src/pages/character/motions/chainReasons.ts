// motion_tool `chain` problem reasons (C9) and `avatar.motionChain.apply` refusals, in Chinese.
import type { ChainProblem } from '../../../bridge';
import { shortName } from './graph';

/** Reason code → its text; `x` is the clip after the colon, `y` the second clip of `<a>><b>`. */
const REASONS: Record<string, (x: string, y: string) => string> = {
  bad_proposal: () => '提案无效：格式错误、角色不符或未包含任何修改',
  stale: () => '角色包在编辑后已发生变更，请放弃本次修改后重新编辑',
  bad_edit: () => '该处修改的格式无效',
  unknown_clip: (x) => `角色包中不存在动作片段 ${x}`,
  unknown_chain: (x) => `角色包中不存在以 ${x} 起始的动作链`,
  bad_index: () => '位置无效：动作链首段不可替换或前置插入',
  bad_hold: () => '保持时长仅适用于循环段，且不可小于 0',
  bad_blend: () => '混合时长须位于 0–2 s 之间',
  source_return: (x) => `${x} 的后续衔接由片段自带回位动作决定，不可在此修改`,
  cycle: (x) => `以 ${x} 起始的动作链会形成自身闭环`,
  no_return: (x) => `以 ${x} 起始的动作链末端无法回到起始站姿`,
  stance_breaks: (x, y) => `${x} 与 ${y} 的姿态无法连续衔接`,
  chain_key_lost: (x) => `手动动作使用的 ${x} 不再是动作链起始项`,
  pool_pose_unmeasured: (x) => `动作池中的 ${x} 尚未测量姿态数据`,
  pool_start_family_unbridged: (x) => `动作池中的 ${x} 起始姿态与基础站姿间缺少过渡`,
  pool_chain_end_off_base: (x) => `动作池中 ${x} 所在的动作链末端未回到基础站姿`,
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
  chain_refused: '角色包未接受该项修改，具体原因已标注于对应段旁',
  bad_proposal: REASONS.bad_proposal!('', ''),
  busy: '角色切换中或另一项导入尚未完成，请稍后再试',
  validate_failed: '重建后的角色包未通过渲染器校验，原角色包未作修改',
  invalid_args: '提案参数格式无效',
  not_implemented: '当前版本暂不支持修改动作链结构',
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
  return { text: FAILURES[code] ?? `操作未完成：${detail || code || '角色渲染进程无响应'}`, problems };
}
