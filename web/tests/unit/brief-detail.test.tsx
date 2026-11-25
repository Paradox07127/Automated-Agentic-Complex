// 每日简报 › 明细：开着的项一行一个，关着的合成一行说明；星标最多 6 个；「比平时多」按 (今天 − 均值) / 均值 降序。
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { DEFAULT_PINS, ITEM_ORDER, ITEMS, type BriefDay, type BriefItemId } from '../../src/pages/overview/briefDay';
import { DetailTab } from '../../src/pages/overview/DetailTab';

const read = async (sw?: string) => {
  const bridge = createFakeBridge({ surface: 'main', still: true });
  const r = await bridge.agentd.request<BriefDay>('GET', `/brief/day?date=2026-11-20${sw == null ? '' : `&sw=${sw}`}`);
  if (!r.body) throw new Error('no body');
  return r.body;
};

const show = (day: BriefDay, pins: BriefItemId[] = DEFAULT_PINS) => {
  const onPins = vi.fn();
  render(<DetailTab day={day} pins={pins} onPins={onPins} go={() => {}} links={{}} />);
  return onPins;
};

const rows = () => within(screen.getByRole('list', { name: '明细' })).getAllByRole('listitem');

afterEach(cleanup);

describe('brief detail tab', () => {
  it('shows all 15 items and no off note when every switch is on', async () => {
    show(await read());
    expect(rows()).toHaveLength(15);
    expect(screen.queryByText(/另有/)).toBeNull();
  });

  it('drops the items whose switches are off and names those switches', async () => {
    show(await read('voice'));
    expect(screen.queryByText('任务完成')).toBeNull();
    expect(rows()).toHaveLength(9);
    const note = screen.getByText(/另有/);
    expect(note.textContent).toContain('屏幕感知');
    expect(screen.getByRole('button', { name: '前往设置' })).toBeTruthy();
  });

  it('stars an item through onPins', async () => {
    const five = DEFAULT_PINS.slice(0, 5);
    const onPins = show(await read(), five);
    fireEvent.click(screen.getByRole('button', { name: '添加至总览：角色发言' }));
    expect(onPins).toHaveBeenCalledWith([...five, 'line']);
  });

  it('does not add a seventh star', async () => {
    const onPins = show(await read());
    const star = screen.getByRole('button', { name: '添加至总览：动作播放' });
    expect(star.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(star);
    expect(onPins).not.toHaveBeenCalled();
  });

  it('puts the item furthest above its 7-day mean first under 比平时多', async () => {
    const day = await read();
    show(day);
    fireEvent.click(screen.getByRole('button', { name: '排序' }));
    fireEvent.click(screen.getByRole('option', { name: '高于均值' }));
    const ratio = (id: BriefItemId) => (day.items[id].today - day.items[id].avg7!) / day.items[id].avg7!;
    const top = [...ITEM_ORDER].sort((a, b) => ratio(b) - ratio(a))[0]!;
    expect(within(rows()[0]!).getByText(ITEMS[top].name)).toBeTruthy();
  });
});
