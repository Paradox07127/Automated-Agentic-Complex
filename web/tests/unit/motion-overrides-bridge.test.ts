// The fake bridge's motion settings (C3 v27 rules 51, 52) and agentd's motion-graph route (C6).
import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { MotionOverrides } from '../../src/bridge/protocol';
import { MOTION_GRAPH } from '../../src/mock/motionGraph';

const SET: MotionOverrides = {
  chains: { A_clip_birch_customized_state_chesthugging3_start: false },
  pools: { 'session.thinking': [{ clip: 'A_clip_birch_customized_state_think_start', weight: 2 }], 'idle.t2': [{ clip: 'b', weight: 1 }] },
  blend_in: { A_clip_birch_customized_state_think_start: 0.3 },
};

describe('fake motion overrides', () => {
  it('starts empty, keeps the whole set per character and counts what it took', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    expect(await bridge.avatar.motionOverrides.get()).toEqual({ chains: {}, pools: {}, blend_in: {} });
    expect(await bridge.avatar.motionOverrides.set(SET)).toEqual({ applied: { chains: 1, pools: 2, blend_in: 1 }, adjusted: [] });
    expect(await bridge.avatar.motionOverrides.get()).toEqual(SET);
    await bridge.avatar.motionOverrides.set({ chains: {}, pools: {}, blend_in: { b: 0 } });
    expect(await bridge.avatar.motionOverrides.get()).toEqual({ chains: {}, pools: {}, blend_in: { b: 0 } });
    await bridge.character.switchTo('voice_a');
    expect(await bridge.avatar.motionOverrides.get()).toEqual({ chains: {}, pools: {}, blend_in: {} });
  });

  it('plays a chain and has no live preview sequence', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    await expect(bridge.avatar.playChain({ start: 'A_clip_birch_customized_state_think_start', speed: 0.5 })).resolves.toBeUndefined();
    expect(await bridge.avatar.preview.sequence({ clips: ['a', 'b'], blend_s: [0.25] })).toBe(false);
    for (const bad of [
      { clips: [], blend_s: [] },
      { clips: Array(33).fill('a'), blend_s: Array(32).fill(0) },
      { clips: ['a', ''], blend_s: [0] },
      { clips: ['c'.repeat(129)], blend_s: [] },
      { clips: ['a', 'b'], blend_s: [] },
      { clips: ['a', 'b'], blend_s: [2.5] },
    ])
      await expect(bridge.avatar.preview.sequence(bad)).rejects.toMatchObject({ code: 'invalid_args' });
  });

  it('is refused outside the main surface', async () => {
    const bridge = createFakeBridge({ surface: 'stack', still: true });
    await expect(bridge.avatar.motionOverrides.get()).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(bridge.avatar.playChain({ start: 'a' })).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('fake GET /characters/:id/motion-graph', () => {
  it('serves the graph of a character with one and the two 404s', async () => {
    const { agentd } = createFakeBridge({ surface: 'main', still: true });
    expect(await agentd.request('GET', '/characters/si/motion-graph')).toEqual({ status: 200, body: MOTION_GRAPH });
    expect(await agentd.request('GET', '/characters/voice_a/motion-graph')).toEqual({
      status: 404, body: { error: 'motion_graph_missing' }, error: { code: 'motion_graph_missing' },
    });
    expect(await agentd.request('GET', '/characters/nobody/motion-graph')).toEqual({
      status: 404, body: { error: 'unknown_character' }, error: { code: 'unknown_character' },
    });
  });
});
