import { describe, expect, it } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import { exampleRoutes } from '../../src/bridge/fake/endpoints';
import { mockRoutes } from '../../src/mock';
import { CHARACTERS, SWITCH_REJECT } from '../../src/mock/fixtures';

describe('mock routes', () => {
  it('registers each method + path only once', () => {
    const seen = new Map<string, number>();
    for (const r of [...exampleRoutes, ...mockRoutes]) {
      const key = `${r.method} ${r.path}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });
});

describe('fake bridge character', () => {
  it('lists the fixture characters with their appearances', async () => {
    const list = await createFakeBridge({ surface: 'main', still: true }).character.list();
    expect(list.map((c) => c.id)).toEqual(CHARACTERS.map((c) => c.id));
    expect(list.filter((c) => c.active)).toHaveLength(1);
    expect(list.every((c) => c.appearances.length > 0)).toBe(true);
  });

  it('rejects a switch with the stage and reason and accepts the others', async () => {
    const bridge = createFakeBridge({ surface: 'main', still: true });
    expect(await bridge.character.switchTo(SWITCH_REJECT.id)).toEqual({ ok: false, stage: SWITCH_REJECT.stage, reason: SWITCH_REJECT.reason });
    expect(await bridge.character.switchTo('voice_a')).toEqual({ ok: true });
    expect((await bridge.character.list()).find((c) => c.active)?.id).toBe('voice_a');
  });
});
