import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlassRect, Region } from '../../src/bridge';
import { createFakeBridge } from '../../src/bridge/fake';
import { stackScenario } from '../../src/mock/stack';
import { useRegions } from '../../src/surfaces/desktop/hooks/useRegions';
import { StackCardView } from '../../src/surfaces/stack/StackCardView';
import { stubMatchMedia } from './mediaStub';

// The desktop overlay as one card per panel: band fallback and card rects, and the error card without the unrelated button.

stubMatchMedia();
document.documentElement.dataset.surface = 'stack';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.location.hash = '';
  localStorage.clear();
  delete window.agenticComplex;
});

describe('glass tint', () => {
  // The bubble and HUD draw a band instead of a glass tint; reduced transparency and increased contrast turn it solid.
  const surfaces = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/surfaces');
  for (const file of ['desktop/BubbleRoot.module.css', 'desktop/HudRoot.module.css']) {
    it(`${file} has no glass tint and a solid band fallback`, () => {
      const css = readFileSync(resolve(surfaces, file), 'utf8');
      expect(css, file).not.toMatch(/data-glass-mode|--ef-hud-glass\b/);
      const fallback = css.match(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{([^@]*?)\n\}/);
      expect(fallback?.[1], file).toMatch(/--band:\s*var\(--ef-hud-solid\)/);
    });
  }
});

describe('glass rects', () => {
  it('go with the regions, one per [data-glass] card that has a size', async () => {
    const bridge = createFakeBridge({ surface: 'stack', still: true });
    const sent: Array<[Region[], GlassRect[] | undefined]> = [];
    bridge.window.setInteractiveRegions = (r, glass) => void sent.push([r, glass]);
    window.agenticComplex = bridge;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.dataset.box?.split(',').map(Number) ?? [0, 0, 0, 0];
      return { left: box[0], top: box[1], width: box[2], height: box[3] } as DOMRect;
    });
    const Panel = () => {
      const ref = useRef<HTMLDivElement>(null);
      useRegions(ref);
      return (
        <div ref={ref}>
          <div data-glass="" data-box="16,0,360,120">
            <button data-region="" data-box="28,8,80,22">待处理</button>
          </div>
          <div data-glass="" data-box="0,0,0,0" />
        </div>
      );
    };
    render(<Panel />);
    await act(async () => {});
    expect(sent.at(-1)).toEqual([[{ x: 28, y: 8, width: 80, height: 22 }], [{ x: 16, y: 0, w: 360, h: 120 }]]);
  });
});

describe('error card', () => {
  it('offers 看出错 and no settings button unrelated to the cause', () => {
    const card = stackScenario('task-error').cards.find((c) => c.kind === 'error')!;
    render(<StackCardView card={card} index={1} total={1} top now={0} act={() => {}} />);
    expect(screen.getByRole('button', { name: '看出错' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去权限与授权' })).toBeNull();
  });
});
