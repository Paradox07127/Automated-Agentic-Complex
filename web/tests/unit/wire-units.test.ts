import { describe, expect, it } from 'vitest';
import { isAgentdTask, splitCanonical, toCanonical } from '../../src/domain/ids';
import { isoToMs, isoToMsOrNull, isoWithOffset, msToEpochSec, secToMs, secToMsOrNull } from '../../src/domain/units';

describe('wire time units', () => {
  it('epoch seconds become ms, null stays null', () => {
    expect(secToMs(1_761_719_530.25)).toBe(1_761_719_530_250);
    expect(secToMsOrNull(null)).toBeNull();
    expect(secToMsOrNull(undefined)).toBeNull();
    expect(secToMsOrNull(12.5)).toBe(12_500);
  });

  it('reads ISO with an offset as the same instant', () => {
    expect(isoToMs('2026-10-29T14:32:10.000+08:00')).toBe(Date.UTC(2026, 9, 29, 6, 32, 10));
    expect(isoToMsOrNull(null)).toBeNull();
    expect(() => isoToMs('yesterday')).toThrow(RangeError);
  });

  it('ms back to request units: floor to epoch seconds, ISO with the local offset', () => {
    expect(msToEpochSec(1_761_719_530_999)).toBe(1_761_719_530);
    const ms = new Date(2026, 9, 29, 14, 32, 10, 123).getTime();
    const iso = isoWithOffset(ms);
    expect(iso).toMatch(/^2026-10-29T14:32:10\.123[+-]\d\d:\d\d$/);
    expect(isoToMs(iso)).toBe(ms);
  });
});

describe('task ids', () => {
  it('a ledger id becomes task:<id>; split gives back the kind and raw id', () => {
    expect(toCanonical('8f2a1c0d9e3b4a57')).toBe('task:8f2a1c0d9e3b4a57');
    expect(splitCanonical('job:0123456789abcdef0123456789abcdef')).toEqual({ kind: 'job', raw: '0123456789abcdef0123456789abcdef' });
    expect(splitCanonical('task:8f2a1c0d9e3b4a57')).toEqual({ kind: 'task', raw: '8f2a1c0d9e3b4a57' });
    expect(splitCanonical('ext:claude:a1b2')).toEqual({ kind: 'ext', raw: 'claude:a1b2' });
  });

  it('only job: and task: ids go to agentd', () => {
    expect(isAgentdTask('job:0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isAgentdTask('task:8f2a1c0d9e3b4a57')).toBe(true);
    expect(isAgentdTask('ext:claude:a1b2')).toBe(false);
    expect(isAgentdTask('run-8d03')).toBe(false);
  });
});
