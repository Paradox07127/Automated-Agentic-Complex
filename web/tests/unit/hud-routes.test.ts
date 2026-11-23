import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnchor, hashPanel } from '../../src/bridge/fake/desktop';

describe('desktop HUD routes', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('names the panel each hash path loads', () => {
    const cases: [string, string][] = [
      ['#/bubble', 'bubble'],
      ['#/hud?demo=x', 'hud'],
      ['#/chip', 'chip'],
      ['#/dock', 'dock'],
      ['#/cmd', 'cmd'],
      ['#/', 'hud'],
    ];
    for (const [hash, panel] of cases) {
      window.location.hash = hash;
      expect(hashPanel(), hash).toBe(panel);
    }
  });

  it('puts her hover buttons beside her and the stack cards under her, with no arc', () => {
    expect(fakeAnchor('dock', null)).toMatchObject({ side: 'left', toHead: { dx: 220 } });
    expect(fakeAnchor('hud', null)).toMatchObject({ side: 'below', toHead: { dx: 0 } });
    expect(fakeAnchor('hud', null)).not.toHaveProperty('arc');
  });
});
