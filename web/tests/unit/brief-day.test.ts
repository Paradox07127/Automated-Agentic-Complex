// 每日简报：读数带先取开着的星标项，再按补位顺序补够 6 个；假数据按开关关掉对应的项。
import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEFAULT_PINS, readouts, type BriefDay } from '../../src/pages/overview/briefDay';

const read = async (sw?: string) => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const r = await bridge.agentd.request<BriefDay>('GET', `/brief/day?date=2026-11-20${sw == null ? '' : `&sw=${sw}`}`);
  if (!r.body) throw new Error('no body');
  return r.body;
};

describe('brief day readouts', () => {
  it('keeps the pinned items when every switch is on', async () => {
    expect(readouts(await read(), DEFAULT_PINS)).toEqual(DEFAULT_PINS);
  });

  it('fills the band from her own items when only voice is on', async () => {
    const day = await read('voice');
    expect(day.items.done.enabled).toBe(false);
    expect(day.items.fg.enabled).toBe(false);
    expect(readouts(day, DEFAULT_PINS)).toEqual(['turn', 'say', 'cost', 'line', 'motion', 'touch']);
  });
});
