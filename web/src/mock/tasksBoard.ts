// Task board mock: the `full` demo's state history.
import { at } from './fixtures/clock';
import { S_3C77, S_41B0, T1, T10, T2, T3, T4, T5, T6, T8, T9 } from './fixtures/ids';

const uuid = (s: string) => s.slice(s.indexOf(':') + 1);

type St = 'wait' | 'err' | 'tool' | 'think' | 'idle' | 'done';
type Mark = { t: number; kind: 'gate-fail' | 'block'; label: string };
interface History {
  segs: Array<[number, St]>;
  marks: Mark[];
  tools?: Array<[string, number, number]>;
}

/** No endpoint serves these yet: the `full` demo's per-card state history, gate failure and block times and tool time. */
export const CARD_HISTORY: Record<string, History> = {
  [T5]: {
    segs: [[at(13, 51), 'think'], [at(13, 54), 'tool'], [at(14, 8), 'idle'], [at(14, 16), 'tool'], [at(14, 31, 20), 'wait']],
    marks: [],
    tools: [['Bash', 512000, 14], ['Read', 21000, 9], ['Edit', 6000, 3]],
  },
  [T2]: {
    segs: [[at(14, 20), 'think'], [at(14, 22), 'tool'], [at(14, 27), 'think'], [at(14, 29), 'tool'], [at(14, 31, 28), 'wait']],
    marks: [{ t: at(14, 24), kind: 'gate-fail', label: 'HostLinkTests 1 个失败' }, { t: at(14, 25, 30), kind: 'block', label: '读取 ~/Library/Keychains 被权限拦截' }],
    tools: [['Bash', 148000, 6], ['Read', 9000, 7], ['Edit', 3000, 2]],
  },
  [T8]: { segs: [[at(14, 5), 'think'], [at(14, 7), 'tool'], [at(14, 15), 'think'], [at(14, 17), 'tool']], marks: [], tools: [['Bash', 214000, 11], ['Edit', 12000, 8], ['Read', 8000, 12]] },
  [T9]: { segs: [[at(13, 32), 'tool'], [at(13, 58), 'think'], [at(14, 5), 'tool'], [at(14, 24), 'think']], marks: [], tools: [['Bash', 1380000, 9], ['Read', 44000, 31]] },
  [T10]: {
    segs: [[at(14, 12), 'tool'], [at(14, 20), 'think'], [at(14, 23), 'idle']],
    marks: [],
    tools: [['Read', 31000, 6], ['Edit', 9000, 14]],
  },
  [`ses:${uuid(S_41B0)}`]: {
    segs: [[at(10, 5), 'think'], [at(10, 9), 'tool'], [at(10, 52), 'think'], [at(10, 58), 'tool'], [at(11, 32), 'err']],
    marks: [{ t: at(10, 31), kind: 'block', label: '修改 Snapshots/ 下的参考图被拦截' }, { t: at(11, 32), kind: 'gate-fail', label: '快照比对 2 张不一致' }],
    tools: [['Bash', 1720000, 18], ['Edit', 22000, 9], ['Read', 15000, 16]],
  },
  [`ses:${uuid(S_3C77)}`]: {
    segs: [[at(12, 10), 'think'], [at(12, 12), 'tool'], [at(12, 40), 'think'], [at(12, 44), 'tool'], [at(12, 53), 'done']],
    marks: [],
    tools: [['Bash', 640000, 12], ['Edit', 18000, 11], ['Read', 12000, 14]],
  },
  [T1]: { segs: [[at(14, 14), 'tool'], [at(14, 20), 'wait'], [at(14, 22), 'tool'], [at(14, 26, 20), 'wait']], marks: [] },
  [T3]: { segs: [[at(14, 26), 'think'], [at(14, 27), 'tool']], marks: [] },
  [T4]: { segs: [[at(10, 40), 'tool'], [at(10, 57), 'done']], marks: [] },
  [T6]: { segs: [[at(10, 12), 'tool'], [at(10, 14, 50), 'err']], marks: [{ t: at(10, 15), kind: 'block', label: '~/Downloads 不在可读取的文件夹里' }] },
};
