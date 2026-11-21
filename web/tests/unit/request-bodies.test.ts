import { describe, expect, it } from 'vitest';
import {
  approvalDecision,
  characterStateReset,
  conversationCancel,
  conversationDelete,
  conversationPatch,
  deliveryDecision,
  deliveryReceipt,
  factWrite,
  goalState,
  interactionAnswer,
  interactionDismiss,
  meeting,
  paused,
  quiet,
  runCancel,
  runtimeSettings,
} from '../../src/domain/bodies';
import { ACTIVE_RUNS, APPROVALS, CHARACTER_STATE, CONVERSATIONS, DELIVERIES, FACTS, GOALS, NOW, QUESTIONS, WIRE_RUNTIME } from '../../src/mock/fixtures';
import { A1, C1, Q1, T1 } from '../../src/mock/fixtures/ids';

const one = <T>(list: readonly T[], pred: (x: T) => boolean): T => {
  const x = list.find(pred);
  if (!x) throw new Error('fixture missing');
  return x;
};

describe('decision bodies carry the concurrency fields', () => {
  it('approval: generation and decision; mode only on a dispatch card', () => {
    const tool = one(APPROVALS, (a) => a.id === A1);
    expect(approvalDecision(tool, 'deny')).toEqual({ generation: tool.generation, decision: 'deny' });
    expect(approvalDecision(tool, 'allow', 'workspace_write')).toEqual({ generation: tool.generation, decision: 'allow' });
    const dispatch = { ...tool, approval_kind: 'dispatch' as const };
    expect(approvalDecision(dispatch, 'allow', 'workspace_write')).toEqual({ generation: tool.generation, decision: 'allow', mode: 'workspace_write' });
  });

  it('interaction: answers cover every question with 1–8 labels; dismiss sends only the version', () => {
    const q = one(QUESTIONS, (x) => x.id === Q1);
    const answers = Object.fromEntries(q.questions.map((x) => [x.id, [x.options[0]?.label ?? '好']]));
    expect(interactionAnswer(q, answers)).toEqual({ expected_version: q.revision, answers });
    expect(() => interactionAnswer(q, {})).toThrow(RangeError);
    const first = q.questions[0]?.id ?? '';
    expect(() => interactionAnswer(q, { ...answers, [first]: Array.from({ length: 9 }, () => 'x') })).toThrow(RangeError);
    expect(interactionDismiss(q)).toEqual({ expected_version: q.revision });
  });

  it('delivery: decision names the delivery; a receipt does not', () => {
    const d = one(DELIVERIES, (x) => x.state === 'viewed');
    expect(deliveryDecision(d)).toEqual({ expected_revision: d.revision, generation: d.generation, delivery_id: d.id });
    expect(deliveryReceipt(d)).toEqual({ expected_revision: d.revision, generation: d.generation });
    expect(JSON.stringify(deliveryDecision(d))).not.toContain('version"');
  });

  it('goal, conversation and fact writes send their version', () => {
    const g = GOALS[0];
    const c = one(CONVERSATIONS, (x) => x.id === C1);
    const f = FACTS[0];
    if (!g || !f) throw new Error('fixture missing');
    expect(goalState(g, 'paused')).toEqual({ expected_version: g.revision, state: 'paused' });
    expect(conversationPatch(c, { pinned: false })).toEqual({ expected_version: c.revision, pinned: false });
    expect(conversationDelete(c)).toEqual({ expected_version: c.revision });
    expect(factWrite(f)).toEqual({ expected_version: f.version });
    expect(factWrite(f, '新的说法')).toEqual({ expected_version: f.version, text: '新的说法' });
  });

  it('run cancels send the generation; the conversation cancel also names the run', () => {
    const r = ACTIVE_RUNS[T1];
    if (!r) throw new Error('fixture missing');
    expect(runCancel(r)).toEqual({ generation: r.generation });
    expect(conversationCancel(r)).toEqual({ run_id: r.run_id, generation: r.generation });
  });

  it('character state reset names the character it read', () => {
    expect(characterStateReset(CHARACTER_STATE)).toEqual({ character_id: CHARACTER_STATE.character_id });
    expect(() => characterStateReset({ ...CHARACTER_STATE, character_id: null })).toThrow(RangeError);
  });
});

describe('observation bodies', () => {
  it('quiet sends epoch seconds or null', () => {
    expect(quiet(NOW + 30 * 60_000)).toEqual({ until: Math.floor((NOW + 30 * 60_000) / 1000) });
    expect(quiet(null)).toEqual({ until: null });
  });

  it('paused takes whole minutes 0–1440, meeting a boolean', () => {
    expect(paused(30)).toEqual({ minutes: 30 });
    expect(() => paused(1441)).toThrow(RangeError);
    expect(() => paused(2.5)).toThrow(RangeError);
    expect(meeting(true)).toEqual({ on: true });
  });
});

describe('runtime settings body', () => {
  it('sends only changed settings without replaying an existing executable or stale configuration', () => {
    const current = { ...WIRE_RUNTIME, executable: '/opt/bin/codex' };
    expect(runtimeSettings(current, { backend: 'pi' })).toEqual({ backend: 'pi' });
    expect(runtimeSettings(current, { scope_id: 'scope-new', max_budget_usd: 2, history_retention: '7d' }))
      .toEqual({ scope_id: 'scope-new', max_budget_usd: 2, history_retention: '7d' });
    expect(runtimeSettings(current, { executable: current.executable })).toEqual({});
    expect(runtimeSettings(current, { executable: null })).toEqual({ executable: null });
  });
});
