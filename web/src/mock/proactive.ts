// Proactive settings, mutes and stats (api/settings.py `_proactive_*`): mutes PUT replaces the whole list; settings PUT takes any non-empty subset of {companion_mode, quiet_enabled: boolean, quiet_ranges: up to 8 [start, end] hours 0-23, start != end}.
import type { ProactiveStats } from '../pages/settings/api';
import type { MockRoute } from './types';

const MUTABLE = ['back', 'break', 'comment', 'repeat', 'session', 'stuck', 'task', 'thought'];
let muted: string[] = [];
let settings = { companion_mode: false, quiet_enabled: false, quiet_ranges: [[22, 8]] };
const hour = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23;
const ranges = (v: unknown) =>
  Array.isArray(v) && v.length <= 8 && v.every((r) => Array.isArray(r) && r.length === 2 && hour(r[0]) && hour(r[1]) && r[0] !== r[1]);

const STATS: ProactiveStats = {
  comment: { shown: 5, replied: 2, accepted: 0, feedback: 1 },
  stuck: { shown: 3, replied: 1, accepted: 1, feedback: 1 },
  'signal.check_failed': { shown: 2, replied: 0, accepted: 1, feedback: 0 },
};

export const routes: MockRoute[] = [
  { method: 'GET', path: '/proactive/mutes', handler: () => ({ status: 200, body: { muted } }) },
  {
    method: 'PUT',
    path: '/proactive/mutes',
    handler: ({ body }) => {
      const next = (body as { muted?: unknown } | null)?.muted;
      if (!Array.isArray(next) || !next.every((k) => MUTABLE.includes(k as string))) return { status: 400, body: { error: 'invalid_payload' } };
      muted = [...new Set(next as string[])].sort();
      return { status: 200, body: { muted } };
    },
  },
  { method: 'GET', path: '/proactive/settings', handler: () => ({ status: 200, body: settings }) },
  {
    method: 'PUT',
    path: '/proactive/settings',
    handler: ({ body }) => {
      const b = body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const keys = Object.keys(b);
      if (
        keys.length === 0 ||
        !keys.every((k) => k in settings) ||
        ['companion_mode', 'quiet_enabled'].some((k) => k in b && typeof b[k] !== 'boolean') ||
        ('quiet_ranges' in b && !ranges(b.quiet_ranges))
      )
        return { status: 400, body: { error: 'invalid_payload' } };
      settings = { ...settings, ...(b as Partial<typeof settings>) };
      return { status: 200, body: settings };
    },
  },
  {
    method: 'GET',
    path: '/proactive/stats',
    handler: ({ query }) => {
      const days = Number(query.get('days') ?? '7');
      if (!Number.isInteger(days) || days < 1) return { status: 400, body: { error: 'invalid_days' } };
      return { status: 200, body: STATS };
    },
  },
];
