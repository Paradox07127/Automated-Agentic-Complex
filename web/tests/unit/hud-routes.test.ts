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
      ['#/ring', 'ring'],
      ['#/cmd', 'cmd'],
      ['#/', 'hud'],
    ];
    for (const [hash, panel] of cases) {
      window.location.hash = hash;
      expect(hashPanel(), hash).toBe(panel);
    }
  });

  it('puts the ring under her feet, its row centred on them, with no arc', () => {
    expect(fakeAnchor('ring', null)).toMatchObject({ side: 'below', toHead: { dx: 0 } });
    expect(fakeAnchor('ring', null)).not.toHaveProperty('arc');
    expect(fakeAnchor('hud', null)).not.toHaveProperty('arc');
  });
});
