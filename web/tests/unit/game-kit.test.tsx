// ui/game: the character area's shared game pieces — keyboard, selected states, the stepper's default tick and its list threshold.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionBar, Barcode, DarkRow, Diamond, GameSeg, GameTabs, MicroLabel, RailCell, Stepper, TitleBar, TrainingRoom, WhiteCapsule, YellowKey } from '../../src/ui/game';

afterEach(cleanup);

const key = (el: Element, k: string) => act(() => void fireEvent.keyDown(el, { key: k }));

describe('GameTabs', () => {
  const tabs = [
    { id: 'look', label: '外观', icon: 'look' as const, micro: 'OUTFIT' },
    { id: 'show', label: '显示', icon: 'eye' as const },
    { id: 'mod', label: '模组设置', icon: 'tune' as const, count: 9, changed: true },
  ];

  it('marks the current tab, moves with ←→ Home End and keeps one tab stop', () => {
    const onChange = vi.fn();
    render(<GameTabs label="外观页签" tabs={tabs} value="look" onChange={onChange} />);
    const list = screen.getByRole('tablist', { name: '外观页签' });
    const tab = (name: string) => within(list).getByRole('tab', { name });
    expect(tab('外观').getAttribute('aria-selected')).toBe('true');
    expect(within(list).getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    key(tab('外观'), 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('show');
    key(tab('外观'), 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('mod');
    key(tab('外观'), 'End');
    expect(onChange).toHaveBeenLastCalledWith('mod');
  });

  it('uncontrolled: the arrow moves selection and focus; a changed tab is described 有改动 and its count stays out of the name', () => {
    render(<GameTabs label="外观页签" tabs={tabs} value="show" />);
    const list = screen.getByRole('tablist');
    key(within(list).getByRole('tab', { name: '显示' }), 'ArrowRight');
    const mod = within(list).getByRole('tab', { name: '模组设置' });
    expect(mod.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(mod);
    expect(mod.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(mod.getAttribute('aria-describedby') ?? '')?.textContent).toBe('有改动');
    expect(mod.textContent).toContain('9');
  });

  it('clicking the current tab does not report a change', () => {
    const onChange = vi.fn();
    render(<GameTabs label="t" tabs={tabs} value="look" onChange={onChange} />);
    fireEvent.click(screen.getByRole('tab', { name: '外观' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('DarkRow', () => {
  it('with onPress the lead and body are one button, pressed when selected; the end slot sits outside it', () => {
    const onPress = vi.fn();
    render(<DarkRow title="点头附和" sub="批准之后" selected onPress={onPress} end={<button type="button">关</button>} />);
    const row = screen.getByRole('button', { name: /点头附和/ });
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.contains(screen.getByRole('button', { name: '关' }))).toBe(false);
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(row.closest('[data-stub="DarkRow"]')?.hasAttribute('data-selected')).toBe(true);
  });

  it('without onPress it is a static row; a missing resource is spoken after the name', () => {
    render(<DarkRow title="思考" mark="missing" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('，缺资源')).toBeTruthy();
    render(<DarkRow title="被拖起" mark="missing" onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: /被拖起.*缺资源/ }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('TitleBar', () => {
  it('heads the group with its count and 已改 n; no 已改 at 0', () => {
    const { rerender } = render(<TitleBar title="衣服" micro="Clothing" count={3} changed={2} />);
    expect(screen.getByRole('heading', { name: '衣服' })).toBeTruthy();
    expect(screen.getByText('已改 2')).toBeTruthy();
    rerender(<TitleBar title="衣服" count={3} changed={0} />);
    expect(screen.queryByText(/已改/)).toBeNull();
  });
});

describe('Stepper', () => {
  const three = [
    { value: 'short', label: '短' },
    { value: 'mid', label: '中' },
    { value: 'long', label: '长' },
  ];
  const seven = Array.from({ length: 7 }, (_, i) => ({ value: `v${i}`, label: `值${i}` }));

  it('draws one tick per value, the current one on and the default one marked', () => {
    const { container } = render(<Stepper label="裙摆" options={three} value="short" defaultValue="long" />);
    const ticks = [...container.querySelectorAll('[aria-hidden="true"] > i')];
    expect(ticks).toHaveLength(3);
    expect(ticks.map((t) => t.hasAttribute('data-on'))).toEqual([true, false, false]);
    expect(ticks.map((t) => t.hasAttribute('data-default'))).toEqual([false, false, true]);
  });

  it('steps with the arrows and ←→, the ends disabled', () => {
    const onChange = vi.fn();
    render(<Stepper label="裙摆" options={three} value="short" onChange={onChange} />);
    expect((screen.getByRole('button', { name: '裙摆：上一个' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '裙摆：下一个' }));
    expect(onChange).toHaveBeenLastCalledWith('mid');
    key(screen.getByRole('group', { name: '裙摆' }), 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('mid');
    key(screen.getByRole('group', { name: '裙摆' }), 'ArrowLeft');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('six values stay a plain value; seven open a list with the default marked, picked with ↓ and Enter', () => {
    render(<Stepper label="六" options={seven.slice(0, 6)} value="v0" />);
    expect(screen.queryByRole('button', { name: /^六：值/ })).toBeNull();
    cleanup();

    const onChange = vi.fn();
    render(<Stepper label="发色" options={seven} value="v1" defaultValue="v0" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: '发色：值1' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox', { name: '发色' });
    expect(within(list).getAllByRole('option')).toHaveLength(7);
    expect(within(list).getByRole('option', { name: /值0.*默认/ })).toBeTruthy();
    expect(within(list).getByRole('option', { name: /值1/ }).getAttribute('aria-selected')).toBe('true');
    key(list, 'ArrowDown');
    key(list, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('v2');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('GameSeg', () => {
  const speed = [
    { value: '0.5', label: '0.5×' },
    { value: '1', label: '1×' },
    { value: '2', label: '2×' },
  ];

  it('is a radiogroup: ← → wrap, the checked option holds the tab stop', () => {
    const onChange = vi.fn();
    render(<GameSeg label="速度" options={speed} value="1" onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: '速度' });
    expect(within(group).getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    key(group, 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('2');
    key(group, 'Home');
    expect(onChange).toHaveBeenLastCalledWith('0.5');
  });

  it('开｜关: the second option checked marks the switch off; a locked switch ignores keys', () => {
    const onoff = [
      { value: 'on', label: '开' },
      { value: 'off', label: '关' },
    ];
    const { container, rerender } = render(<GameSeg label="思考" variant="onoff" options={onoff} value="off" />);
    expect(container.querySelector('[data-stub="GameSeg"]')?.hasAttribute('data-off')).toBe(true);
    expect(screen.getByRole('radio', { name: '关' }).getAttribute('aria-checked')).toBe('true');
    const onChange = vi.fn();
    rerender(<GameSeg label="思考" variant="onoff" options={onoff} value="on" disabled onChange={onChange} />);
    key(screen.getByRole('radiogroup'), 'ArrowRight');
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-stub="GameSeg"]')?.hasAttribute('data-off')).toBe(false);
  });
});

describe('keys, capsule, rail cell, action bar, marks, room', () => {
  it('YellowKey and WhiteCapsule click, and do nothing when disabled', () => {
    const go = vi.fn();
    render(
      <>
        <YellowKey label="桌面预览" micro="Desktop" onClick={go} />
        <WhiteCapsule label="恢复默认" icon="refresh" onClick={go} />
        <YellowKey label="保存" disabled onClick={go} />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: '桌面预览' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('RailCell: the current cell is aria-current=page; its micro label stays out of the name', () => {
    const go = vi.fn();
    render(
      <>
        <RailCell label="动作" icon="play" micro="Mot" current />
        <RailCell label="外观" icon="look" micro="Look" onClick={go} />
      </>,
    );
    expect(screen.getByRole('button', { name: '动作' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '外观' }).hasAttribute('aria-current')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '外观' }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('ActionBar is a named group with both slots; progress is clamped to 0–1', () => {
    const { container } = render(<ActionBar label="播放" progress={1.7} left={<button type="button">左</button>} right={<button type="button">右</button>} />);
    const bar = screen.getByRole('group', { name: '播放' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['左', '右']);
    expect((container.querySelector('[style]') as HTMLElement).style.getPropertyValue('--p')).toBe('1');
  });

  it('micro labels, diamonds, barcodes and the room are hidden from screen readers', () => {
    const { container } = render(
      <>
        <MicroLabel>AGENTIC</MicroLabel>
        <Diamond />
        <Barcode label="AGENTIC" />
        <TrainingRoom />
      </>,
    );
    for (const stub of ['MicroLabel', 'Diamond', 'Barcode', 'TrainingRoom']) {
      expect(container.querySelector(`[data-stub="${stub}"]`)?.getAttribute('aria-hidden'), stub).toBe('true');
    }
  });
});
