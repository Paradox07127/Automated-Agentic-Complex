import { describe, expect, it } from 'vitest';
import { fromEpisode } from '../../src/domain/adapt';
import { PRESENCE_ROLE } from '../../src/mock/fixtures';
import { WIRE_EPISODES } from '../../src/mock/fixtures/wire/memory';
import { WIRE_SESSIONS } from '../../src/mock/fixtures/wire/work';
import type { WireEpisode } from '../../src/domain/wire';
import { S_9A41 } from '../../src/mock/fixtures/ids';

describe('mock wire values', () => {
  it('uses the registry tool state for the active external session', () => {
    expect(WIRE_SESSIONS.find((s) => s.session_id === S_9A41)?.state).toBe('running_tool');
  });

  it('uses the presence tool event phase', () => {
    expect(PRESENCE_ROLE.phase).toBe('tool_started');
  });

  it('exercises nullable episode outcomes and omits them from the domain model', () => {
    const episode = WIRE_EPISODES[0]!;
    expect(episode.outcome).toBeNull();
    const wire: WireEpisode = { ...episode, outcome: null };
    expect(fromEpisode(wire)).not.toHaveProperty('outcome');
    expect(fromEpisode({ ...wire, outcome: 'ok' }).outcome).toBe('ok');
    const { outcome: _, ...withoutOutcome } = wire;
    expect(fromEpisode(withoutOutcome)).not.toHaveProperty('outcome');
  });
});
