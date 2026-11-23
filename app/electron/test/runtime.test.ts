// The `app.runtime` snapshot (src/common/runtime.ts) with the cases and values of RuntimeSnapshotTests and
// RuntimeCoordinatorTests; this shell's ChildState has no gpuHold or external.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChildState } from '../src/common/agentd.ts';
import {
  agentdTts, initialRuntime, reduced, type Runtime, RuntimeCoordinator, type RuntimeEvent, runtimeJson, runtimePhase, type SlotState,
} from '../src/common/runtime.ts';

const t0 = 1_000_000, t1 = 2_000_000;

/** JSON with object keys sorted. */
function wire(s: Runtime): string {
  return JSON.stringify(runtimeJson(s), (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

function snapshot(o: { agentd?: ChildState; avatar?: ChildState; tts?: SlotState; ready?: boolean; shown?: string | null;
  degraded?: Runtime['degraded']; configError?: string | null } = {}): Runtime {
  const s = initialRuntime(t0);
  s.processes.agentd = { state: o.agentd ?? { kind: 'running' }, pid: null, stage: null, since: t0 };
  s.processes.avatar = { state: o.avatar ?? { kind: 'running' }, pid: null, stage: null, since: t0 };
  s.agentdReady = o.ready ?? true;
  s.character.shown = o.shown === undefined ? 'aster' : o.shown;
  s.degraded = o.degraded ?? [];
  s.configError = o.configError ?? null;
  return o.tts ? reduced(s, { kind: 'service', id: 'tts', view: { mode: 'ssh', state: o.tts, pid: null, detail: null } }, t0) : s;
}

test('the golden JSON', () => {
  const s = initialRuntime(t0);
  s.revision = 12;
  s.processes.agentd = { state: { kind: 'running' }, pid: 123, stage: 'ready', since: t0 };
  s.processes.avatar = { state: { kind: 'running' }, pid: 456, stage: null, since: t0 };
  s.services.tts = { mode: 'ssh', state: { kind: 'backoff', seconds: 4 }, pid: null, detail: 'ssh 255' };
  s.services.llm = { mode: 'url', state: null, pid: null, detail: null };
  s.character = { current: 'aster', shown: 'aster', agentd: 'aster', pending: null, switching: false,
    failure: { target: 'birch', stage: 'commit', reason: 'timeout' } };
  s.visibility = { hidden: true, reason: 'fullscreen', fullscreenHidden: true, clickThroughAll: false };
  s.tts = { provider: 'remote-ws', phase: 'unreachable', reason: 'http_502', retryAfterS: 2.5, muted: false };
  s.voiceInput = 'on';
  s.degraded = [{ source: 'agentd', code: 'observations', detail: null }];
  s.agentdReady = true;
  const golden = '{"character":{"agentd":"aster","current":"aster","failure":{"reason":"timeout","stage":"commit","target":"birch"},"pending":null,"shown":"aster","switching":false},"config_error":null,"degraded":[{"code":"observations","detail":null,"source":"agentd"}],"phase":"degraded","processes":{"agentd":{"backoff":null,"pid":123,"reason":null,"stage":"ready","state":"running"},"avatar":{"backoff":null,"pid":456,"reason":null,"stage":null,"state":"running"}},"revision":12,"services":{"llm":{"detail":null,"mode":"url","pid":null,"state":null},"motion":{"detail":null,"mode":"off","pid":null,"state":null},"tts":{"detail":"ssh 255","mode":"ssh","pid":null,"state":{"kind":"backoff","seconds":4}}},"tts":{"muted":false,"provider":"remote-ws","reason":"http_502","retry_after_s":2.5,"state":"unreachable"},"visibility":{"click_through_all":false,"fullscreen_hidden":true,"hidden":true,"reason":"fullscreen"},"voice_input":"on"}';
  assert.equal(wire(s), golden);
});

test('the initial JSON has every process and the nulls', () => {
  const golden = '{"character":{"agentd":null,"current":null,"failure":null,"pending":null,"shown":null,"switching":false},"config_error":null,"degraded":[],"phase":"starting","processes":{"agentd":{"backoff":null,"pid":null,"reason":null,"stage":null,"state":"stopped"},"avatar":{"backoff":null,"pid":null,"reason":null,"stage":null,"state":"stopped"}},"revision":0,"services":{"llm":{"detail":null,"mode":"off","pid":null,"state":null},"motion":{"detail":null,"mode":"off","pid":null,"state":null},"tts":{"detail":null,"mode":"off","pid":null,"state":null}},"tts":{"muted":false,"provider":"none","reason":null,"retry_after_s":null,"state":"unknown"},"visibility":{"click_through_all":false,"fullscreen_hidden":false,"hidden":false,"reason":null},"voice_input":"off"}';
  assert.equal(wire(initialRuntime(t0)), golden);
});

test('the child states\' wire names', () => {
  const rows: [ChildState, string][] = [
    [{ kind: 'stopped' }, 'stopped'], [{ kind: 'starting' }, 'starting'], [{ kind: 'running' }, 'running'],
    [{ kind: 'portInUse' }, 'port_in_use'],
  ];
  for (const [state, name] of rows) {
    assert.equal(runtimeJson(reduced(initialRuntime(t0), { kind: 'child', name: 'agentd', state, pid: null }, t1)).processes.agentd.state, name);
  }
  const failed = runtimeJson(reduced(initialRuntime(t0), { kind: 'child', name: 'avatar', state: { kind: 'failed', reason: 'exit 3' }, pid: null }, t1));
  assert.equal(failed.processes.avatar.state, 'failed');
  assert.equal(failed.processes.avatar.reason, 'exit 3');
  const backoff = runtimeJson(reduced(initialRuntime(t0), { kind: 'child', name: 'agentd', state: { kind: 'backoff', seconds: 8 }, pid: null }, t1));
  assert.deepEqual(backoff.processes.agentd, { state: 'backoff', pid: null, backoff: 8, reason: null, stage: null });
});

test('the phase table', () => {
  const observations = [{ source: 'agentd', code: 'observations', detail: null }];
  const rows: [Runtime, string][] = [
    [snapshot({ configError: 'bad json' }), 'config_failed'],
    [snapshot({ agentd: { kind: 'stopped' }, avatar: { kind: 'stopped' }, ready: false }), 'starting'],
    [snapshot({ agentd: { kind: 'starting' }, avatar: { kind: 'stopped' }, ready: false }), 'starting'],
    [snapshot({ agentd: { kind: 'running' }, avatar: { kind: 'stopped' }, ready: false }), 'starting'],
    [snapshot({ agentd: { kind: 'backoff', seconds: 2 }, avatar: { kind: 'running' }, ready: false }), 'avatar_only'],
    [snapshot({ agentd: { kind: 'running' }, avatar: { kind: 'running' }, ready: false }), 'avatar_only'],
    [snapshot({ agentd: { kind: 'running' }, avatar: { kind: 'portInUse' } }), 'agentd_only'],
    [snapshot({ shown: null }), 'starting'],
    [snapshot(), 'interactive'],
    [snapshot({ degraded: observations }), 'degraded'],
    [snapshot({ tts: { kind: 'failed', reason: 'ssh 255' } }), 'degraded'],
    [snapshot({ tts: { kind: 'backoff', seconds: 4 } }), 'interactive'],
    [snapshot({ tts: { kind: 'external' } }), 'interactive'],
  ];
  rows.forEach(([s, phase], i) => {
    assert.equal(runtimePhase(s), phase, `row ${i}`);
    assert.equal(runtimeJson(s).phase, phase, `row ${i}`);
  });
});

test('the revision bumps only on a change', () => {
  let s = initialRuntime(t0);
  const visibility = { hidden: true, reason: 'user', fullscreenHidden: false, clickThroughAll: false };
  const character = { current: null, shown: null, agentd: null, pending: null, switching: false, failure: null };
  const tts = { provider: 'none', phase: 'unknown' as const, reason: null, retryAfterS: null, muted: false };
  const service = { mode: 'ssh' as const, state: { kind: 'running' } as SlotState, pid: 3, detail: null };
  const events: [RuntimeEvent, number][] = [
    [{ kind: 'child', name: 'agentd', state: { kind: 'starting' }, pid: 7 }, 1],
    [{ kind: 'child', name: 'agentd', state: { kind: 'starting' }, pid: 7 }, 1],
    [{ kind: 'visibility', view: visibility }, 2],
    [{ kind: 'visibility', view: { ...visibility } }, 2],
    [{ kind: 'voiceInput', value: 'off' }, 2],
    [{ kind: 'voiceInput', value: 'denied' }, 3],
    [{ kind: 'agentdHealth', stage: 'warming', degraded: [] }, 4],
    [{ kind: 'agentdHealth', stage: 'warming', degraded: [] }, 4],
    [{ kind: 'configError', error: null }, 4],
    [{ kind: 'configError', error: 'bad json' }, 5],
    [{ kind: 'tts', view: tts }, 5],
    [{ kind: 'character', view: character }, 5],
    [{ kind: 'avatarStage', stage: null }, 5],
    [{ kind: 'avatarStage', stage: 'load' }, 6],
    [{ kind: 'character', view: { ...character, failure: { target: 'si', stage: 'avatar', reason: 'timeout' } } }, 7],
    [{ kind: 'character', view: { ...character, failure: { target: 'si', stage: 'avatar', reason: 'timeout' } } }, 7],
    [{ kind: 'service', id: 'motion', view: service }, 8],
    [{ kind: 'service', id: 'motion', view: { ...service } }, 8],
  ];
  events.forEach(([e, revision], i) => {
    s = reduced(s, e, t1);
    assert.equal(s.revision, revision, `event ${i}`);
  });
});

test('a child change sets since and ends the agentd run', () => {
  let s = initialRuntime(t0);
  s = reduced(s, { kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 7 }, t1);
  assert.deepEqual(s.processes.agentd, { state: { kind: 'running' }, pid: 7, stage: null, since: t1 });
  s = reduced(s, { kind: 'agentdHealth', stage: 'ready', degraded: ['observations'] }, t1);
  s = reduced(s, { kind: 'agentdReady' }, t1);
  assert.equal(s.agentdReady, true);
  assert.equal(s.processes.agentd.stage, 'ready');

  const later = 3_000_000;
  assert.deepEqual(reduced(s, { kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 7 }, later), s);
  const next = reduced(s, { kind: 'child', name: 'agentd', state: { kind: 'backoff', seconds: 2 }, pid: null }, later);
  assert.deepEqual(next.processes.agentd, { state: { kind: 'backoff', seconds: 2 }, pid: null, stage: null, since: later });
  assert.equal(next.agentdReady, false);
  assert.deepEqual(next.degraded, []);
  // The same state with another pid only takes the pid.
  const pid = reduced(s, { kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 8 }, later);
  assert.deepEqual(pid.processes.agentd, { state: { kind: 'running' }, pid: 8, stage: 'ready', since: t1 });
  assert.equal(pid.agentdReady, true);
  assert.equal(pid.revision, s.revision + 1);
});

test('agentd health replaces only agentd\'s reasons', () => {
  let s = initialRuntime(t0);
  s.degraded = [{ source: 'voice', code: 'unreachable', detail: null }, { source: 'agentd', code: 'old', detail: null }];
  s = reduced(s, { kind: 'agentdHealth', stage: null, degraded: ['observations', 'context'] }, t1);
  assert.deepEqual(s.degraded, [
    { source: 'voice', code: 'unreachable', detail: null },
    { source: 'agentd', code: 'observations', detail: null },
    { source: 'agentd', code: 'context', detail: null },
  ]);
});

test('the avatar stage does not touch its state', () => {
  let s = reduced(initialRuntime(t0), { kind: 'child', name: 'avatar', state: { kind: 'starting' }, pid: 9 }, t1);
  s = reduced(s, { kind: 'avatarStage', stage: 'mesh' }, t1);
  assert.deepEqual(s.processes.avatar, { state: { kind: 'starting' }, pid: 9, stage: 'mesh', since: t1 });
});

test('the visibility replaces the whole view and leaves the phase', () => {
  let s = snapshot();
  s = reduced(s, { kind: 'visibility', view: { hidden: true, reason: 'fullscreen', fullscreenHidden: true, clickThroughAll: true } }, t1);
  assert.equal(runtimePhase(s), 'interactive');
  s = reduced(s, { kind: 'visibility', view: { hidden: false, reason: 'fullscreen_exit', fullscreenHidden: false, clickThroughAll: false } }, t1);
  assert.ok(wire(s).includes('"visibility":{"click_through_all":false,"fullscreen_hidden":false,"hidden":false,"reason":"fullscreen_exit"}'));
});

test('agentd\'s voice_state keeps the local mute', () => {
  const local = { provider: 'none', phase: 'unknown' as const, reason: null, retryAfterS: null, muted: true };
  assert.deepEqual(agentdTts(local, JSON.stringify({ provider: 'remote-ws', state: 'unreachable', reason: 'http_502', retry_after_s: 2.5 })),
    { provider: 'remote-ws', phase: 'unreachable', reason: 'http_502', retryAfterS: 2.5, muted: true });
  assert.equal(agentdTts(local, JSON.stringify({ provider: 'remote-ws', state: 'later' }))?.phase, 'unknown');
  assert.deepEqual(agentdTts(local, JSON.stringify({ provider: 'none', state: 'off', reason: null, retry_after_s: null })),
    { provider: 'none', phase: 'off', reason: null, retryAfterS: null, muted: true });
  // AgentdVoiceState does not decode: no event.
  assert.equal(agentdTts(local, JSON.stringify({ state: 'ready' })), null);
  assert.equal(agentdTts(local, JSON.stringify({ provider: 'none', state: 'off', reason: 3 })), null);
  assert.equal(agentdTts(local, 'not json'), null);
});

test('observe hands the current snapshot at once', () => {
  const c = new RuntimeCoordinator(() => t0);
  c.send({ kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 7 });
  const seen: Runtime[] = [];
  c.observe((s) => seen.push(s));
  assert.deepEqual(seen, [c.snapshot]);
  assert.deepEqual(seen[0]!.processes.agentd.state, { kind: 'running' });
  assert.equal(seen[0]!.processes.agentd.pid, 7);
});

test('an equal event does not notify', () => {
  const c = new RuntimeCoordinator(() => t0);
  const revisions: number[] = [];
  c.observe((s) => revisions.push(s.revision));
  c.send({ kind: 'child', name: 'avatar', state: { kind: 'running' }, pid: 3 });
  c.send({ kind: 'child', name: 'avatar', state: { kind: 'running' }, pid: 3 });
  c.send({ kind: 'configError', error: null });
  assert.deepEqual(revisions, [0, 1]);
  assert.equal(c.snapshot.revision, 1);
});

test('nested sends are queued and delivered in order', () => {
  const c = new RuntimeCoordinator(() => t0);
  const first: string[] = [], second: string[] = [];
  c.observe((s) => {
    first.push(s.processes.agentd.state.kind);
    if (s.processes.agentd.state.kind === 'starting') c.send({ kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 1 });
  });
  c.observe((s) => second.push(s.processes.agentd.state.kind));
  c.send({ kind: 'child', name: 'agentd', state: { kind: 'starting' }, pid: null });
  // Every observer sees "starting" before anyone sees "running".
  assert.deepEqual(first, ['stopped', 'starting', 'running']);
  assert.deepEqual(second, ['stopped', 'starting', 'running']);
  assert.equal(c.snapshot.revision, 2);
});

test('a cancelled observation stops notifying', () => {
  const c = new RuntimeCoordinator(() => t0);
  let calls = 0;
  const cancel = c.observe(() => { calls += 1; });
  c.send({ kind: 'agentdReady' });
  cancel();
  c.send({ kind: 'configError', error: 'bad json' });
  assert.equal(calls, 2);
  assert.equal(c.snapshot.configError, 'bad json');
});

test('events use the injected clock', () => {
  let now = t0;
  const c = new RuntimeCoordinator(() => now);
  now = 5_000_000;
  c.send({ kind: 'child', name: 'avatar', state: { kind: 'failed', reason: 'exit 3' }, pid: null });
  assert.equal(c.snapshot.processes.avatar.since, now);
  assert.equal(c.snapshot.processes.agentd.since, t0);
});
