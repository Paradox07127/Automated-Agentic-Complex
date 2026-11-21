// The composer's 资料 calls: literal paths through the shared helper, so check:routes sees each one.
import { getBridge } from '../../bridge';
import { get, post } from '../../bridge/agentd';
import type { WireScope } from '../settings/wire';
import { clock } from './useChatData';

/** A scope the composer sends with each line, and the name its chip shows. */
export interface ChatScope {
  id: string;
  name: string;
}

const wide = (ch: string) => ((ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1);
const width = (chars: string[]) => chars.reduce((n, c) => n + wide(c), 0);

/** `name` cut in the middle to the width of about `max` Latin letters (a CJK character counts 2); its last 7 characters stay. */
export function shortName(name: string, max = 24): string {
  const chars = [...name];
  if (width(chars) <= max) return name;
  const tail = chars.slice(-7);
  let room = max - 1 - width(tail);
  let head = '';
  for (const c of chars) {
    room -= wide(c);
    if (room < 0) break;
    head += c;
  }
  return `${head}…${tail.join('')}`;
}

type ListedScope = WireScope & { files?: Array<{ path: string }> };

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function scopeName(s: ListedScope): string {
  const files = s.files ?? [];
  if (files.length > 1) return `${files.length} 个文件`;
  return base(files[0]?.path ?? s.roots[0]?.path ?? '');
}

/** The bridge swaps each picked handle for its path; agentd picks the output folder itself. Null when the picker was cancelled. */
export async function pickScope(kind: 'file' | 'folder'): Promise<ChatScope | null> {
  const files = getBridge().files;
  const h = kind === 'file' ? await files.pickFile({ purpose: 'scope_file' }) : await files.pickFolder({ purpose: 'scope_root' });
  if (!h) return null;
  const made = await post<WireScope>('/agent/scopes', kind === 'file' ? { files: [h] } : { roots: [h] });
  return { id: made.scope_id, name: h.displayName };
}

/** The newest scope neither revoked nor expired, or null. */
export async function recentScope(): Promise<ChatScope | null> {
  const now = clock() / 1000;
  const { scopes } = await get<{ scopes: ListedScope[] }>('/agent/scopes');
  const live = scopes.filter((s) => !s.revoked && s.expires_at > now).sort((a, b) => b.created_at - a.created_at)[0];
  return live ? { id: live.scope_id, name: scopeName(live) } : null;
}
