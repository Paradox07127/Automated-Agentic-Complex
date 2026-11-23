import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { BracketMeter, LineChart, type Pt } from '../../src/charts';
import * as game from '../../src/ui/game';
import { DeviceRow, GameFrame, GameTable, LoadBar, ReadTick, ReadoutPlate, StationCard, type GameTableColumn, type GameTableRow } from '../../src/ui/game';
import { StateGlyph } from '../../src/ui/game/StateGlyph';
import cardStyles from '../../src/ui/game/StationCard.module.css';

afterEach(cleanup);

const css = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the first rule whose selector is exactly `sel`. */
const rule = (text: string, sel: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.trim() === sel)?.[2] ?? '';

const COLS: GameTableColumn[] = [{ key: 'what', label: '写了什么', width: 'minmax(0, 1fr)' }];
const ROWS: GameTableRow[] = [
  { id: 'a', cells: { what: '第一行' }, body: '甲的展开体' },
  { id: 'b', cells: { what: '第二行' }, body: '乙的展开体' },
];

describe('GameTable controlled rows', () => {
  it('opens the rows `expanded` names and reports a toggle without opening by itself', () => {
    const seen: string[][] = [];
    const { rerender } = render(<GameTable label="记录" columns={COLS} rows={ROWS} expanded={['b']} onExpandedChange={(ids) => seen.push(ids)} />);
    expect(screen.queryByText('甲的展开体')).toBeNull();
    expect(screen.getByText('乙的展开体')).toBeTruthy();
    fireEvent.click(screen.getByText('第一行'));
    expect(seen).toEqual([['b', 'a']]);
    expect(screen.queryByText('甲的展开体')).toBeNull();
    rerender(<GameTable label="记录" columns={COLS} rows={ROWS} expanded={['a']} onExpandedChange={(ids) => seen.push(ids)} />);
    expect(screen.getByText('甲的展开体')).toBeTruthy();
    expect(screen.queryByText('乙的展开体')).toBeNull();
  });

  it('follows its owner when the owner keeps the ids', () => {
    function Owner() {
      const [ids, setIds] = useState<string[]>([]);
      return <GameTable label="记录" columns={COLS} rows={ROWS} expanded={ids} onExpandedChange={setIds} />;
    }
    render(<Owner />);
    fireEvent.click(screen.getByText('第二行'));
    expect(screen.getByText('乙的展开体')).toBeTruthy();
    fireEvent.click(screen.getByText('第二行'));
    expect(screen.queryByText('乙的展开体')).toBeNull();
  });
});

const card = { no: '03', micro: 'CONSOLIDATE', icon: 'data', name: '整理', value: '4', note: '今天整理批次', sub: '写入 7 条', state: 'failed', onSelect: () => undefined } as const;

describe('StationCard', () => {
  it('marks the compact variant and leaves the default unmarked', () => {
    const { container, rerender } = render(<StationCard {...card} />);
    expect(container.querySelector('[data-stub="StationCard"]')!.hasAttribute('data-compact')).toBe(false);
    rerender(<StationCard {...card} compact />);
    expect(container.querySelector('[data-stub="StationCard"]')!.hasAttribute('data-compact')).toBe(true);
    expect(rule(css('ui/game/StationCard.module.css'), ".card[data-compact]")).toMatch(/min-height/);
  });

  // A flex box clips its text without an ellipsis; the words sit in a block span that ends in one.
  it('sets a text note and sub line in an ellipsis span, so a narrow card never cuts a glyph in half', () => {
    render(<StationCard {...card} />);
    const sheet = css('ui/game/StationCard.module.css');
    const body = rule(sheet, `.${'clip'}`);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).not.toMatch(/display:\s*flex/);
    for (const text of ['今天整理批次', '写入 7 条']) expect(screen.getByText(text).className).toBe(cardStyles.clip);
  });

  it('keeps a meter note as it is', () => {
    const { container } = render(<StationCard {...card} note={<LoadBar variant="port" fraction={0.5} label="额度" />} />);
    expect(container.querySelector('small > [data-stub="LoadBar"]')).not.toBeNull();
  });
});

describe('Readout', () => {
  it('lays a ReadTick on one line with `inline`', () => {
    const { container, rerender } = render(<ReadTick value="12" label="近 1 小时" />);
    expect(container.querySelector('[data-stub="ReadTick"]')!.hasAttribute('data-inline')).toBe(false);
    rerender(<ReadTick value="12" label="近 1 小时" inline />);
    expect(container.querySelector('[data-stub="ReadTick"]')!.hasAttribute('data-inline')).toBe(true);
    expect(rule(css('ui/game/Readout.module.css'), ".tick[data-inline]")).toMatch(/display:\s*inline-flex/);
  });

  it('marks a compact ReadoutPlate', () => {
    const { container, rerender } = render(<ReadoutPlate cells={[{ label: '今天截图', value: '12 / 40' }]} />);
    expect(container.querySelector('[data-stub="ReadoutPlate"]')!.hasAttribute('data-compact')).toBe(false);
    rerender(<ReadoutPlate cells={[{ label: '今天截图', value: '12 / 40' }]} compact />);
    expect(container.querySelector('[data-stub="ReadoutPlate"]')!.hasAttribute('data-compact')).toBe(true);
    expect(rule(css('ui/game/Readout.module.css'), ".plate[data-compact]")).toMatch(/min-height/);
  });
});

describe('BracketMeter width', () => {
  it('takes a track width in px over the size step', () => {
    const { container, rerender } = render(<BracketMeter value={5} max={12} label="后台调用" size="sm" />);
    const root = () => container.querySelector<HTMLElement>('[data-stub="BracketMeter"]')!;
    expect(root().style.getPropertyValue('--w')).toBe('80px');
    rerender(<BracketMeter value={5} max={12} label="后台调用" size="sm" width={200} />);
    expect(root().style.getPropertyValue('--w')).toBe('200px');
  });
});

describe('LoadBar thresholds and indeterminate', () => {
  it('draws a fine tick at each threshold on both variants', () => {
    const { container, rerender } = render(<LoadBar fraction={0.4} thresholds={[0.7, 0.9]} />);
    const ticks = () => [...container.querySelectorAll<HTMLElement>('[data-threshold]')].map((t) => t.style.left);
    expect(ticks()).toEqual(['70%', '90%']);
    rerender(<LoadBar fraction={0.4} variant="port" label="额度" thresholds={[0.5]} />);
    expect(ticks()).toEqual(['50%']);
    rerender(<LoadBar fraction={0.4} />);
    expect(ticks()).toEqual([]);
  });

  it('reads no value while indeterminate and stands still under reduced motion', () => {
    render(<LoadBar fraction={0} indeterminate name="示例乙" />);
    const bar = screen.getByRole('progressbar', { name: '正在载入 示例乙' });
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('data-indeterminate')).toBe(true);
    expect(screen.queryByText('0%')).toBeNull();
    const sheet = css('ui/game/LoadBar.module.css');
    expect(sheet).toMatch(/\[data-indeterminate\] \.fill \{[^}]*animation:/);
    const still = [...sheet.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('');
    expect(still).toMatch(/\[data-indeterminate\] \.fill/);
  });
});

describe('LineChart reference lines', () => {
  const pts: Pt[] = Array.from({ length: 7 }, (_, i) => [1_000_000 + i * 600_000, i]);

  it('draws one line per entry of a `limit` array', () => {
    const { container } = render(<LineChart label="帧耗时" w={400} series={[{ id: 'f', label: '帧耗时', pts }]} limit={[{ v: 2, label: '注意 2' }, { v: 5, label: '预算 5' }]} />);
    expect(container.querySelectorAll('[data-limit]')).toHaveLength(2);
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts).toEqual(expect.arrayContaining(['注意 2', '预算 5']));
    expect(container.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toMatch(/上限 2；上限 5$/);
  });

  it('still takes a single limit', () => {
    const { container } = render(<LineChart label="帧耗时" w={400} series={[{ id: 'f', label: '帧耗时', pts }]} limit={{ v: 5 }} />);
    expect(container.querySelectorAll('[data-limit]')).toHaveLength(1);
    expect([...container.querySelectorAll('svg text')].map((t) => t.textContent)).toContain('上限 5');
  });
});

describe('DeviceRow attributes', () => {
  it('passes data-*, aria-*, className and onClick to its root', () => {
    let clicks = 0;
    const { container } = render(
      <DeviceRow icon="hub" name="后台服务" state="ok" data-k="agentd" aria-describedby="x" className="mine" onClick={() => (clicks += 1)} />,
    );
    const root = container.querySelector<HTMLElement>('[data-stub="DeviceRow"]')!;
    expect(root.getAttribute('data-k')).toBe('agentd');
    expect(root.getAttribute('aria-describedby')).toBe('x');
    expect(root.classList.contains('mine')).toBe(true);
    expect(root.classList.length).toBe(2);
    fireEvent.click(root);
    expect(clicks).toBe(1);
  });
});

describe('GameFrame compact', () => {
  it('marks the compact padding on every variant', () => {
    for (const variant of ['monitor', 'media', 'chart'] as const) {
      const { container, unmount } = render(<GameFrame variant={variant} title="帧率" compact />);
      expect(container.querySelector('[data-stub="GameFrame"]')!.hasAttribute('data-compact'), variant).toBe(true);
      unmount();
    }
    const { container } = render(<GameFrame title="帧率" />);
    expect(container.querySelector('[data-stub="GameFrame"]')!.hasAttribute('data-compact')).toBe(false);
    expect(css('ui/game/GameFrame.module.css')).toMatch(/\[data-compact\][^{]*\{[^}]*padding/);
  });
});

describe('ui/game index', () => {
  it('exports StateGlyph', () => {
    expect((game as Record<string, unknown>).StateGlyph).toBe(StateGlyph);
  });
});
