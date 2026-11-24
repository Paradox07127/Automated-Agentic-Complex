// The window and node rules every capture path shares: the activity recorder (activity.ts) and the screen context capture (screen-context.ts).
import { type AttentionWindow, type BlacklistRules, hides } from './attention.ts';

/** `incognito` null is a browser window whose incognito state and URL host couldn't be read. */
export interface CaptureWindow { window: AttentionWindow; incognito: boolean | null; secureInput: boolean }

export type BlockReason = 'blacklisted' | 'incognito' | 'browser_unknown' | 'secure_input';

/** The reason agentd would give for dropping this window's content, or null. A title rule that can't be checked
 *  because the title is unreadable blocks the window. */
export function captureBlockReason(w: CaptureWindow, rules: BlacklistRules, ownPids: readonly number[]): BlockReason | null {
  if (hides(rules, w.window, ownPids)) return 'blacklisted';
  if (rules.titles.length > 0 && w.window.title === null) return 'blacklisted';
  if (w.incognito === true && rules.incognito) return 'incognito';
  // Unknown means the URL host is unknown too, so the domain blacklist can't be checked either.
  if (w.incognito === null) return 'browser_unknown';
  if (w.secureInput) return 'secure_input';
  return null;
}

const SECURE_WORDS = ['secure', 'password', 'passcode', '密码', '口令'];

/** A password-like node by its role, subrole, title or description. */
export function isSecureNode(role: string, subrole: string | null, title: string | null, description: string | null = null): boolean {
  const identity = [role, subrole ?? '', title ?? '', description ?? ''].join(' ').toLowerCase();
  return SECURE_WORDS.some((w) => identity.includes(w));
}
