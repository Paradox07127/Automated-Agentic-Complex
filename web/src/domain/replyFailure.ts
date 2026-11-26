// Why her reply failed and the one next step it offers, for the chat page and the desktop bubble.
import type { NavTarget } from '../shell/nav';
import { codeText } from './errorText';

/** The one next step a failed reply offers for its code. */
export const NEXT: Readonly<Record<string, { label: string; to: NavTarget }>> = {
  auth_expired: { label: '前往登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  native_login_required: { label: '前往登录', to: { page: 'settings', group: 'kernel', item: 'kcur' } },
  quota_exhausted: { label: '查看用量', to: { page: 'diag', tab: 'flow', item: 'usage' } },
};

/** Why a reply failed: the sentence for its run's or its line's code, else agentd's public_message. */
export function failedOf(r: { failure?: { code: string | null; public_message: string | null } | undefined; error: string | null }): { reason: string; code: string | null } {
  const code = [r.failure?.code, r.error].find((c) => codeText(c)) ?? null;
  return { reason: codeText(code) ?? r.failure?.public_message ?? '未返回回复', code };
}
