// ui/game press feedback: the game never moves or shadows a control on press, but for the close key, which sinks onto its
// shadow; selection out clips run on the cell or tab that loses it.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameTabs, RailCell } from '../../src/ui/game';

const KIT = resolve(__dirname, '../../src/ui/game');
const css = (f: string) => readFileSync(resolve(KIT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const sheets = readdirSync(KIT).filter((f) => f.endsWith('.module.css') && f !== 'CloseKey.module.css');

/** Innermost `selector { declarations }` blocks, so rules inside @media come out with their own selector. */
function rules(text: string): Array<{ sel: string; body: string }> {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? '').trim(), body: m[2] ?? '' }));
}

describe('kit press CSS', () => {
  it('no :active rule moves, scales or shadows a control', () => {
    const bad = sheets.flatMap((f) =>
      rules(css(f))
        .filter((r) => r.sel.includes(':active') && /(^|[;\s])(transform|translate|scale|box-shadow)\s*:/.test(r.body))
        .map((r) => `${f}: ${r.sel}`),
    );
    expect(bad).toEqual([]);
  });

  it('the pressable pieces switch states without timing under .still and reduced motion', () => {
    const pressable = ['RailCell', 'GameTabs', 'WhiteCapsule', 'YellowKey', 'GameSeg', 'DarkRow', 'Stepper'];
    const missing = pressable.filter((n) => {
      const t = css(`${n}.module.css`);
      return !t.includes(':global(.still)') || !t.includes('prefers-reduced-motion');
    });
    expect(missing).toEqual([]);
  });
});

interface Run {
  el: Element;
  frames: Keyframe[];
  finish: () => void;
}

describe('selection clips', () => {
  let runs: Run[] = [];
  beforeEach(() => {
    runs = [];
    Element.prototype.animate = vi.fn(function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null) {
      let finish = () => undefined as void;
      const finished = new Promise<Animation>((ok) => {
        finish = () => ok(a);
      });
      const a = { finished, cancel: vi.fn() } as unknown as Animation;
      runs.push({ el: this, frames: (frames ?? []) as Keyframe[], finish });
      return a;
    }) as unknown as Element['animate'];
  });
  afterEach(() => {
    cleanup();
    delete (Element.prototype as Partial<Element>).animate;
  });

  const values = (r: Run, prop: string) => r.frames.map((k) => k[prop]);

  it('RailCell: the cell that loses current plays charinfo_menucell_selectbtn_out on its white plate', () => {
    const { container, rerender } = render(<RailCell label="动作" icon="play" current />);
    expect(runs).toEqual([]);
    rerender(<RailCell label="动作" icon="play" />);
    const plate = container.querySelector('[data-g="plate"]');
    expect(plate).not.toBeNull();
    const shrink = runs.find((r) => r.el === plate && r.frames.some((k) => '--size-x' in k));
    expect(shrink && values(shrink, '--size-x')).toEqual([0, -55, -55]);
    // Only the plate runs: the cell's own icon and band stay as they are.
    expect(runs.every((r) => r.el === plate)).toBe(true);
  });

  it('GameTabs: the new tab opens its plate rightwards; the old one keeps a closing plate until the close run ends', async () => {
    const tabs = [
      { id: 'look', label: '外观', icon: 'look' as const },
      { id: 'show', label: '显示', icon: 'eye' as const },
    ];
    const { container, rerender } = render(<GameTabs label="t" tabs={tabs} value="look" />);
    rerender(<GameTabs label="t" tabs={tabs} value="show" />);
    const tab = (id: string) => container.querySelector(`[data-tab="${id}"]`);
    const open = tab('show')?.querySelector('[data-g="slc"]');
    const leaving = tab('look')?.querySelector('[data-leaving]');
    expect(open).not.toBeNull();
    expect(leaving).not.toBeNull();
    const clip = (el: Element | null | undefined) => runs.find((r) => r.el === el && r.frames.some((k) => 'clipPath' in k));
    expect(values(clip(open)!, 'clipPath')).toEqual(['inset(-6px 143px -6px -6px)', 'inset(-6px)']);
    expect(values(clip(leaving)!, 'clipPath')).toEqual(['inset(-6px)', 'inset(-6px 143px -6px -6px)']);
    await act(async () => {
      for (const r of runs) r.finish();
    });
    expect(tab('look')?.querySelector('[data-leaving]')).toBeNull();
  });
});
