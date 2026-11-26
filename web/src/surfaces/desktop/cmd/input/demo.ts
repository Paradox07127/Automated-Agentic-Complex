// Browser-preview presets of 快速输入 (`#/bubble?mode=input&demo=input-err-agentd|input-err-kernel`); native never reads them.
import type { QuickInputProps } from './QuickInput';

const TEXT = '帮我查这个报错';

export function inputPreset(demo: string | null): QuickInputProps['initial'] {
  if (demo === 'input-err-agentd') return { text: TEXT, error: { ok: false, reason: 'agentd' } };
  if (demo === 'input-err-kernel') return { text: TEXT, error: { ok: false, reason: 'kernel', detail: 'Codex 未登录，在终端执行 codex login' } };
  if (demo === 'input-err-login') return { text: TEXT, error: { ok: false, reason: 'kernel', status: 503, code: 'product_login_required' } };
  return undefined;
}
