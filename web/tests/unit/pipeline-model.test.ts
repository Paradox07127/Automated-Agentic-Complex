// 记忆管线的状态推导：工位状态、传送带、出事的工位、顶栏一句话。
import { describe, expect, it } from 'vitest';
import { digestOf } from '../../src/pages/pipeline/data';
import { belts, interpState, lineWord, median, memState, obsState, PHASE, storeState, troubled, type States } from '../../src/pages/pipeline/model';

const idle = { phase: 'idle' as const, why: null };
const all = (over: Partial<States>): States => ({ obs: idle, interp: idle, mem: idle, store: idle, ...over });

describe('station states', () => {
  it('观察: paused before full, full before waiting', () => {
    expect(obsState({ off: true, pending: [1] }, { used: 200, limit: 200 })).toEqual({ phase: 'pause', why: '观察已关闭' });
    expect(obsState({ meeting: true }, null).phase).toBe('pause');
    expect(obsState({ pending: [1] }, { used: 200, limit: 200 })).toEqual({ phase: 'block', why: '截图额度已用尽' });
    expect(obsState({ pending: [1, 2] }, { used: 3, limit: 200 })).toEqual({ phase: 'run', why: '排队 2 个请求' });
    expect(obsState({ pending: [] }, { used: 3, limit: 200 }).phase).toBe('idle');
  });

  it('理解: the newest run decides; a failure says only what the reply says', () => {
    expect(interpState([{ at: 0, outcome: 'failed', error: '模型超时' }])).toEqual({ phase: 'fail', why: '模型超时' });
    expect(interpState([{ at: 0, outcome: 'failed', error: null }]).why).toBe('理解失败');
    expect(interpState([{ at: 0, outcome: 'completed', error: null }]).phase).toBe('idle');
  });

  it('整理: paused memory, then the newest background batch', () => {
    expect(memState(true, [{ at: 0, end: null, state: 'running' }]).phase).toBe('pause');
    expect(memState(false, [{ at: 0, end: null, state: 'running' }]).phase).toBe('run');
    expect(memState(false, [{ at: 0, end: 1, state: 'rejected' }])).toEqual({ phase: 'fail', why: '校验未通过' });
    expect(memState(false, []).phase).toBe('idle');
    expect(storeState(3)).toEqual({ phase: 'wait', why: '3 条' });
  });
});

describe('the line', () => {
  it('a belt takes the look of the station downstream; offline stops them all', () => {
    expect(belts(all({ mem: { phase: 'fail', why: null } }), false)).toEqual([null, 'fail', null]);
    expect(belts(all({ obs: { phase: 'block', why: null } }), false)).toEqual(['block', null, null]);
    expect(belts(all({ store: { phase: 'wait', why: null } }), false)).toEqual([null, null, null]);
    expect(belts(all({}), true)).toEqual(['pause', 'pause', 'pause']);
  });

  it('points at a failed station before a blocked one, and counts them for the top bar', () => {
    const s = all({ obs: { phase: 'block', why: null }, mem: { phase: 'fail', why: null } });
    expect(troubled(s)).toBe('mem');
    expect(lineWord(s)).toEqual({ phase: 'fail', text: '1 处异常' });
    expect(lineWord(all({}))).toEqual({ phase: 'ok', text: '全线正常' });
    expect(lineWord(all({ obs: { phase: 'loading', why: null } }))).toBeNull();
  });

  it('堵住 and 已暂停 are the shared blocked and paused states', () => {
    expect(PHASE.block).toEqual({ key: 'blocked', label: '已阻塞' });
    expect(PHASE.pause).toEqual({ key: 'paused', label: '已暂停' });
    expect(lineWord(all({ obs: { phase: 'block', why: null } }))?.text).toBe('1 处已阻塞');
    expect(lineWord(all({ mem: { phase: 'pause', why: null } }))?.text).toBe('1 处已暂停');
  });
});

describe('what a run wrote', () => {
  it('reads each change from its receipt; an unchanged or rejected proposal wrote nothing', () => {
    const run = { run_id: 'r', backend: 'codex', model: 'm', started_at: 0, finished_at: 1, state: 'committed', prompt_version: 'memory_extract-v2', redacted_reason: null, events: [] };
    const proposals = [
      { proposal: { operation: 'add', text: '已经记得的' }, receipt: { outcome: 'unchanged', fact_id: 'f1' } },
      { proposal: { operation: 'add', text: '新的' }, receipt: { outcome: 'stored', fact_id: 'f2' } },
      { proposal: { operation: 'add', text: '待定的' }, receipt: { outcome: 'candidate', fact_id: 'f3' } },
      { proposal: { operation: 'correct', text: '改后', target_quote: '改前' }, receipt: { outcome: 'corrected', fact_id: 'f4' } },
      { proposal: { operation: 'forget', target_quote: '忘掉的' }, receipt: { outcome: 'forgotten', fact_id: 'f5' } },
      { proposal: { operation: 'add', text: '被拒的' }, receipt: { outcome: 'rejected', error: { code: 'x' } } },
    ];
    expect(digestOf({ ...run, detail: { proposals } }).changes).toEqual([
      { op: 'add', text: '新的', cand: false },
      { op: 'add', text: '待定的', cand: true },
      { op: 'upd', text: '改后', was: '改前', cand: false },
      { op: 'del', text: '忘掉的', cand: false },
    ]);
  });

  it('the median of an even count is the mean of the two middle values', () => {
    expect(median([1, 9])).toBe(5);
    expect(median([9, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});
