import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { stackScenario } from '../../src/mock/stack';
import { ConfirmCard } from '../../src/surfaces/desktop/bubble/ConfirmCard';
import type { StackCard } from '../../src/surfaces/stack/model';
import { stubMatchMedia } from './mediaStub';

// The desktop panels and stack cards draw with tokens: no colour literals and no private palette, and a dangerous
// approval on the bubble's confirm card wears the red tape.

stubMatchMedia();
afterEach(cleanup);

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/surfaces') + '/';

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith('.css') ? [p] : [];
  });
}

/** CSS without comments and without the mask declarations, whose black is an alpha ramp. */
function painted(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(-webkit-)?mask(-image)?:[^;]*;/gm, '');
}

describe('desktop and stack CSS', () => {
  const files = [...cssFiles(join(src, 'desktop')), ...cssFiles(join(src, 'stack'))];

  for (const file of files) {
    const name = file.slice(src.length);
    it(`${name} paints with tokens only`, () => {
      // The camera area's near-zero fill is what makes the transparent area take clicks, not a colour.
      const css = painted(file).replace(/background: rgb\(255 255 255 \/ 0\.001\);/, '');
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [], name).toEqual([]);
    });

    it(`${name} keeps no private HUD palette`, () => {
      expect(painted(file).match(/--(hud-[a-z0-9-]+|ink-[a-z]+|hb-[a-z]+|chip-plate|head|field|dot|b[6-9][a-z-]*)\s*:/g) ?? [], name).toEqual([]);
    });
  }

  it('the head bubble casts the frame shadow, not the button one', () => {
    const css = readFileSync(join(src, 'desktop/bubble/HeadBubble.module.css'), 'utf8');
    expect(css).not.toContain('--ef-shadow-btn');
    expect(css).toMatch(/var\(--ef-shadow-card\)/);
  });
});

describe('ConfirmCard tape', () => {
  const approvals = stackScenario('default').cards.filter((c): c is Extract<StackCard, { kind: 'approval' }> => c.kind === 'approval');

  it('turns red for a dangerous approval only', () => {
    const danger = approvals.find((c) => c.item.dangerous);
    const safe = approvals.find((c) => !c.item.dangerous);
    if (!danger || !safe) throw new Error('the default scenario has a dangerous and a safe approval');
    render(<ConfirmCard card={danger} more={0} act={() => {}} onDetails={() => {}} />);
    expect(screen.getByRole('alertdialog').hasAttribute('data-danger')).toBe(true);
    cleanup();
    render(<ConfirmCard card={safe} more={0} act={() => {}} onDetails={() => {}} />);
    expect(screen.getByRole('alertdialog').hasAttribute('data-danger')).toBe(false);
    const css = readFileSync(join(src, 'desktop/bubble/ConfirmCard.module.css'), 'utf8');
    expect(css).toMatch(/\.paper\[data-danger\]\s*\{[^}]*--tape-hi:\s*var\(--ef-danger-vivid\)/);
  });
});
