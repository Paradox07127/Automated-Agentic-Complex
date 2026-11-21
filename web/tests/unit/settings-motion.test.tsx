import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetNav } from '../../src/pages/settings/SetNav';
import { Switch, Toggle } from '../../src/ui';

// jsdom has no Web Animations: record what each run asks for.
let runs: Array<{ el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions }> = [];

beforeEach(() => {
  runs = [];
  Object.assign(Element.prototype, {
    animate(this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
      runs.push({ el: this, frames, opts });
      return { finished: new Promise(() => undefined), cancel() {} };
    },
  });
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).animate;
  document.documentElement.classList.remove('still');
});

const keys = () => [...new Set(runs.map((r) => r.el.getAttribute('data-g')))].sort();

describe('toggle clips', () => {
  it('plays common_toggle_to_left on the knob when Toggle turns on, nothing on mount; the labels fade in CSS', () => {
    render(<Toggle on={false} label="窗口文字" />);
    expect(runs).toEqual([]);
    fireEvent.click(screen.getByRole('switch', { name: '窗口文字' }));
    expect(keys()).toEqual(['knob']);
    const anchor = runs.find((r) => '--anchor-min-x' in r.frames[0]!)!;
    expect(anchor.frames.map((f) => f['--anchor-min-x'])).toEqual([1, 0]);
    expect(anchor.opts).toMatchObject({ duration: 200, fill: 'backwards' });
  });

  it('plays common_toggle_to_right when Switch turns off', () => {
    render(<Switch checked label="终端" />);
    fireEvent.click(screen.getByRole('switch', { name: '终端' }));
    const anchor = runs.find((r) => '--anchor-min-x' in r.frames[0]!)!;
    expect(anchor.frames.map((f) => f['--anchor-min-x'])).toEqual([0, 1]);
  });

  it('jumps to the end state in still shots', () => {
    document.documentElement.classList.add('still');
    render(<Toggle on={false} label="终端" />);
    fireEvent.click(screen.getByRole('switch', { name: '终端' }));
    expect(screen.getByRole('switch', { name: '终端' }).getAttribute('aria-checked')).toBe('true');
    expect(runs).toEqual([]);
  });
});

describe('settings tab clips', () => {
  it('plays tab_select_out on the cell left and tab_select_in on the cell picked', () => {
    const props = { searching: false, marks: {}, drafts: [], onGroup: () => undefined };
    const { container, rerender } = render(<SetNav group="speak" {...props} />);
    expect(runs).toEqual([]);
    rerender(<SetNav group="keys" {...props} />);
    const on = (id: string) => [...new Set(runs.filter((r) => r.el.closest(`[data-tab="${id}"]`)).map((r) => r.el.getAttribute('data-g')))].sort();
    expect(on('speak')).toEqual(['flash', 'icon']);
    expect(on('keys')).toEqual(['slc', 'slcIcon']);
    expect(container.querySelector('[data-tab="keys"]')?.getAttribute('aria-selected')).toBe('true');
  });
});
