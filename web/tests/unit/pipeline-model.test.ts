// 记忆管线的状态推导：工位状态、传送带、出事的工位、顶栏一句话。
import { describe, expect, it } from 'vitest';
import { belts, interpState, lineWord, memState, obsState, PHASE, storeState, troubled, type States } from '../../src/pages/pipeline/model';

const idle = { phase: 'idle' as const, why: null };
const all = (over: Partial<States>): States => ({ obs: idle, interp: idle, mem: idle, store: idle, ...over });

describe('station states', () => {
  it('观察: paused before full, full before waiting', () => {
    expect(obsState({ off: true, pending: [1] }, { used: 200, limit: 200 })).toEqual({ phase: 'pause', why: '观察已关' });
    expect(obsState({ meeting: true }, null).phase).toBe('pause');
    expect(obsState({ pending: [1] }, { used: 200, limit: 200 })).toEqual({ phase: 'block', why: '截图额度已满' });
    expect(obsState({ pending: [1, 2] }, { used: 3, limit: 200 })).toEqual({ phase: 'run', why: '等 2 个请求' });
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
    expect(lineWord(s)).toEqual({ phase: 'fail', text: '1 处出错了' });
    expect(lineWord(all({}))).toEqual({ phase: 'ok', text: '全线正常' });
    expect(lineWord(all({ obs: { phase: 'loading', why: null } }))).toBeNull();
  });

  it('堵住 and 已暂停 are the shared blocked and paused states', () => {
    expect(PHASE.block).toEqual({ key: 'blocked', label: '堵住' });
    expect(PHASE.pause).toEqual({ key: 'paused', label: '已暂停' });
    expect(lineWord(all({ obs: { phase: 'block', why: null } }))?.text).toBe('1 处堵住');
    expect(lineWord(all({ mem: { phase: 'pause', why: null } }))?.text).toBe('1 处已暂停');
  });
});
