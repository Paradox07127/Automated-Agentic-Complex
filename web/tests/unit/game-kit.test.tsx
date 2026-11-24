// ui/game: the character area's shared game pieces — keyboard, selected states, the stepper's default tick and its list threshold.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionBar, Barcode, DarkRow, Diamond, GameSeg, GameTabs, LoadBar, MicroLabel, RailCell, Stepper, TitleBar, TrainingRoom, WhiteCapsule, YellowKey } from '../../src/ui/game';

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

  it('the selected plate carries no corner marks, a changed tab included: those are for notices', () => {
    render(<GameTabs label="t" tabs={tabs} value="mod" />);
    expect(screen.getByRole('tab', { name: '模组设置' }).querySelectorAll('[data-side]')).toHaveLength(0);
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

  it('warn: an orange-edged lead with the warning glyph, spoken 出错 after the name', () => {
    const { container } = render(<DarkRow title="角色未运行" sub="退避 8 秒后重试" mark="warn" />);
    expect(container.querySelector('[data-stub="DarkRow"]')?.getAttribute('data-mark')).toBe('warn');
    expect(container.querySelector('[aria-hidden="true"] svg path')).not.toBeNull();
    expect(screen.getByText('，出错')).toBeTruthy();
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

  it('countAccent marks the count for the accent colour; a plain count is not marked', () => {
    const { rerender } = render(<TitleBar title="舞曲库" count={6} countAccent />);
    expect(screen.getByText('6').hasAttribute('data-accent')).toBe(true);
    rerender(<TitleBar title="舞曲库" count={6} />);
    expect(screen.getByText('6').hasAttribute('data-accent')).toBe(false);
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

  it('two options: a click anywhere, the selected one included, flips; three options keep click-to-pick', () => {
    const onoff = [
      { value: 'on', label: '开' },
      { value: 'off', label: '关' },
    ];
    const two = vi.fn();
    render(<GameSeg label="二选一" options={onoff} value="on" onChange={two} />);
    fireEvent.click(screen.getByRole('radio', { name: '开' }));
    expect(two).toHaveBeenLastCalledWith('off');
    const three = vi.fn();
    render(<GameSeg label="三选一" options={speed} value="1" onChange={three} />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '三选一' })).getByRole('radio', { name: '1×' }));
    expect(three).not.toHaveBeenCalled();
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

  it('the vertical YellowKey keeps its label as the name and its micro out of it; a WhiteCapsule carries its tone', () => {
    const go = vi.fn();
    const { container } = render(
      <>
        <YellowKey vertical label="连播" micro="SETLIST" onClick={go} />
        <WhiteCapsule label="重启角色" icon="refresh" tone="accent" />
        <WhiteCapsule label="关闭" icon="close" />
      </>,
    );
    const key = screen.getByRole('button', { name: '连播' });
    expect(key.hasAttribute('data-vertical')).toBe(true);
    fireEvent.click(key);
    expect(go).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll('[data-stub="WhiteCapsule"]')].map((b) => b.getAttribute('data-tone'))).toEqual(['accent', 'plain']);
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

  it('a white diamond is its own tone', () => {
    const { container } = render(<Diamond tone="white" />);
    expect(container.querySelector('[data-stub="Diamond"]')?.getAttribute('data-tone')).toBe('white');
  });

  it('the room draws her watermark only when given one, and drops it when it does not load', () => {
    const { container, rerender } = render(<TrainingRoom />);
    expect(container.querySelector('img')).toBeNull();
    rerender(<TrainingRoom watermark="art/characters/si/charinfo-bg.png" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('art/characters/si/charinfo-bg.png');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    rerender(<TrainingRoom watermark="art/characters/cedar/charinfo-bg.png" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('art/characters/cedar/charinfo-bg.png');
  });

  it('the room draws the game lattice from both cameras and floor contours, and no ids two rooms could share', () => {
    const { container } = render(
      <>
        <TrainingRoom />
        <TrainingRoom />
      </>,
    );
    const room = container.querySelector('[data-training-room]') as HTMLElement;
    expect([...room.querySelectorAll('svg g')].map((g) => g.querySelectorAll('line').length)).toEqual([23, 26]);
    expect(room.querySelectorAll('svg path').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[id]')).toHaveLength(0);
  });
});

describe('variants the pages asked for', () => {
  it('TitleBar: a fraction count, a one-line note and its own word for 已改', () => {
    const { container } = render(<TitleBar title="说话" count={2} total={5} note="批准之后点头" changed={1} changedLabel="隐藏" />);
    expect(container.querySelector('[data-total]')?.textContent).toBe('2/5');
    expect(screen.getByText('批准之后点头')).toBeTruthy();
    expect(screen.getByText('隐藏 1')).toBeTruthy();
  });

  it('GameSeg: an option carries its own title and icon, the default option is marked, the compact size is marked', () => {
    const { container } = render(
      <GameSeg
        label="播放方式"
        size="compact"
        value="once"
        defaultValue="loop"
        options={[
          { value: 'once', label: '一次' },
          { value: 'loop', label: '循环', disabled: true, title: '这个版本的角色还不支持循环', icon: 'refresh' },
        ]}
      />,
    );
    const loop = screen.getByRole('radio', { name: '循环' });
    expect(loop.getAttribute('title')).toBe('这个版本的角色还不支持循环');
    expect(loop.querySelector('svg')).not.toBeNull();
    expect(loop.hasAttribute('data-default')).toBe(true);
    expect(screen.getByRole('radio', { name: '一次' }).hasAttribute('data-default')).toBe(false);
    expect(container.querySelector('[data-stub="GameSeg"]')?.getAttribute('data-size')).toBe('compact');
  });

  it('YellowKey: busy is announced and ignores clicks; the white tone is marked', () => {
    const go = vi.fn();
    render(
      <>
        <YellowKey label="保存" busy onClick={go} />
        <YellowKey label="停止" icon="stop" tone="white" onClick={go} />
      </>,
    );
    const save = screen.getByRole('button', { name: '保存' });
    expect(save.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(save);
    expect(go).not.toHaveBeenCalled();
    const stop = screen.getByRole('button', { name: '停止' });
    expect(stop.getAttribute('data-tone')).toBe('white');
    fireEvent.click(stop);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('DarkRow: no row draws a barcode; ok is its own mark; the lead takes custom content and a press of its own', () => {
    const reset = vi.fn();
    const pick = vi.fn();
    const { container } = render(
      <>
        <DarkRow title="导入完成" mark="ok" compact />
        <DarkRow title="外套" lead={<span>01</span>} state="busy" focused />
        <DarkRow title="亮度" mark="changed" leadAction={{ label: '恢复「亮度」的默认', title: '恢复这一行的默认', onPress: reset }} onPress={pick} />
      </>,
    );
    const rows = [...container.querySelectorAll('[data-stub="DarkRow"]')];
    expect(rows[0]?.getAttribute('data-mark')).toBe('ok');
    expect(rows[0]?.hasAttribute('data-compact')).toBe(true);
    expect(container.querySelector('[data-stub="Barcode"]')).toBeNull();
    expect(rows[1]?.textContent).toContain('01');
    expect(rows[1]?.getAttribute('data-state')).toBe('busy');
    expect(rows[1]?.hasAttribute('data-focused')).toBe(true);
    const lead = screen.getByRole('button', { name: '恢复「亮度」的默认' });
    expect(lead.getAttribute('title')).toBe('恢复这一行的默认');
    fireEvent.click(lead);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled();
    expect(lead.contains(screen.getByRole('button', { name: /亮度，已改/ }))).toBe(false);
  });

  it('ActionBar: the progress line runs in the left part only; looping draws the running hatch there', () => {
    const { container, rerender } = render(<ActionBar label="播放" progress={0.5} left={<i />} right={<i />} />);
    const left = container.querySelector('[data-side="left"]');
    expect((left?.querySelector('[style]') as HTMLElement | null)?.style.getPropertyValue('--p')).toBe('0.5');
    expect(container.querySelector('[data-side="right"] [style]')).toBeNull();
    rerender(<ActionBar label="播放" looping left={<i />} />);
    expect(container.querySelector('[data-side="left"] [data-looping]')).not.toBeNull();
  });

  it('WhiteCapsule: the dark tone is marked', () => {
    const { container } = render(<WhiteCapsule label="收起提示" icon="chev" tone="dark" />);
    expect(container.querySelector('[data-stub="WhiteCapsule"]')?.getAttribute('data-tone')).toBe('dark');
  });

  it('Stepper: the compact size is marked', () => {
    const { container } = render(<Stepper label="裙摆" compact options={[{ value: 'a', label: '短' }]} value="a" />);
    expect(container.querySelector('[data-stub="Stepper"]')?.getAttribute('data-size')).toBe('compact');
  });

  it('Stepper with numbers: arrows step (Shift by big), typing commits on Enter, values are kept in range', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Stepper label="权重" value={5} min={1} max={100000} step={1} big={10} changed onChange={onChange} />);
    const box = screen.getByRole('spinbutton', { name: '权重' }) as HTMLInputElement;
    expect(box.value).toBe('5');
    expect(container.querySelector('[data-stub="Stepper"]')?.hasAttribute('data-changed')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '权重：增加' }));
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.click(screen.getByRole('button', { name: '权重：减少' }), { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.change(box, { target: { value: '200000' } });
    key(box, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(100000);
    rerender(<Stepper label="权重" value={1} min={1} max={100000} step={1} onChange={onChange} />);
    expect((screen.getByRole('button', { name: '权重：减少' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Stepper label="保持" value={1.5} min={0} max={600} step={0.5} digits={1} onChange={onChange} />);
    expect((screen.getByRole('spinbutton', { name: '保持' }) as HTMLInputElement).value).toBe('1.5');
  });

  it('Stepper with a format: focusing and leaving an off-grid value without typing keeps it', () => {
    const onChange = vi.fn();
    render(<Stepper label="上下文长度" value={262144} min={16000} max={2000000} step={16000} format={String} onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: '上下文长度' });
    fireEvent.focus(box);
    fireEvent.blur(box);
    fireEvent.focus(box);
    key(box, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '262000' } });
    key(box, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(256000);
  });
});

describe('LoadBar', () => {
  it('is a progressbar at the rounded percent: the text and the line both at that share', () => {
    const { container } = render(<LoadBar fraction={0.564} name="示例乙" />);
    const bar = screen.getByRole('progressbar', { name: '正在载入 示例乙' });
    expect(bar.getAttribute('aria-valuenow')).toBe('56');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(within(bar).getByText('56%')).toBeTruthy();
    expect(within(bar).getByText('正在载入')).toBeTruthy();
    expect(within(bar).getByText('示例乙')).toBeTruthy();
    expect([...container.querySelectorAll<HTMLElement>('[data-fill]')].map((f) => f.style.width)).toEqual(['56%']);
  });

  it('keeps the share within 0–100 and leaves the name out without one', () => {
    const { rerender } = render(<LoadBar fraction={1.2} name="示例乙" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    rerender(<LoadBar fraction={-0.1} />);
    expect(screen.getByRole('progressbar', { name: '正在载入' }).getAttribute('aria-valuenow')).toBe('0');
    expect(screen.queryByText('示例乙')).toBeNull();
  });
});
