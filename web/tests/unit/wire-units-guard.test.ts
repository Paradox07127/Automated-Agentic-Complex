import { describe, expect, it } from 'vitest';
import * as F from '../../src/mock/fixtures';

/** Every numeric `*_at` / `at` / `since` / `until` field reachable from a value, with its path. */
function times(value: unknown, path: string, out: Array<[string, number]> = []): Array<[string, number]> {
  if (Array.isArray(value)) value.forEach((v, i) => times(v, `${path}[${i}]`, out));
  else if (value != null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'number' && (k === 'at' || k.endsWith('_at') || k === 'since' || k === 'until')) out.push([`${path}.${k}`, v]);
      else times(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const WIRE = Object.entries(F).filter(([name]) => name.startsWith('WIRE_'));
const DOMAIN = { TASKS: F.TASKS, APPROVALS: F.APPROVALS, QUESTIONS: F.QUESTIONS, DELIVERIES: F.DELIVERIES, SESSIONS: F.SESSIONS, GOALS: F.GOALS, RUNS: F.RUNS, ACTIVE_RUNS: F.ACTIVE_RUNS, STEP_EVENTS: F.STEP_EVENTS, TOOL_ITEMS: F.TOOL_ITEMS, CONVERSATIONS: F.CONVERSATIONS, FACTS: F.FACTS, EPISODES: F.EPISODES, CHARACTER_STATE: F.CHARACTER_STATE, STATE_LOG: F.STATE_LOG };

describe('time units at the wire boundary', () => {
  it('wire fixtures carry epoch seconds (a value read as ms would be 1970)', () => {
    const found = WIRE.flatMap(([name, v]) => times(v, name));
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter(([, t]) => t !== 0 && !(t > 1e9 && t < 2e10))).toEqual([]);
  });

  it('domain fixtures derived from them carry epoch ms', () => {
    const found = Object.entries(DOMAIN).flatMap(([name, v]) => times(v, name));
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter(([, t]) => !(t > 1e12))).toEqual([]);
  });
});
