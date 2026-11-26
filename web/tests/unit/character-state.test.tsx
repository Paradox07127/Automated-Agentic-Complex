import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CAUSE_LIMIT, STATE_WITH_CAUSES } from '../../src/mock/character';
import { CHARACTER_STATE, STATE_LOG, VALENCE_SPAN } from '../../src/mock/fixtures';
import { CAUSE_LABELS } from '../../src/features/character/tables';
import { BracketMeter } from '../../src/charts';

describe('character state mock', () => {
  it('keeps at most 8 causes, newest first, all labelled', () => {
    const causes = STATE_WITH_CAUSES.causes;
    expect(causes.length).toBeLessThanOrEqual(CAUSE_LIMIT);
    expect([...causes].sort((a, b) => b.at - a.at)).toEqual(causes);
    for (const c of causes) expect(CAUSE_LABELS[c.cause]).toBeTruthy();
  });

  it('explains every 24 h mood jump bigger than the natural drift', () => {
    const pts = STATE_LOG.d24;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!a || !b || Math.abs(b.valence - a.valence) < 0.09) continue;
      const near = STATE_WITH_CAUSES.causes.some((c) => c.attr === 'valence' && c.at > a.at - 30 * 60_000 && c.at <= b.at);
      expect(near, `jump at ${new Date(b.at).toTimeString()}`).toBe(true);
    }
  });
});

describe('mood bar', () => {
  it('draws below-baseline mood in s2 grey, not attention', () => {
    const { container } = render(<BracketMeter value={CHARACTER_STATE.valence!} max={VALENCE_SPAN} center={CHARACTER_STATE.baseline!} marks={[0]} label="心情" readout="−0.10" />);
    expect(screen.getByText('−0.10')).toBeTruthy();
    expect(container.querySelector('[data-stub="BracketMeter"]')?.getAttribute('data-level')).toBe('negative');
    expect(container.innerHTML).not.toContain('attention');
  });
});

