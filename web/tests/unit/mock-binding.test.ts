// The fake bridge answers agentd's GET /characters/:id/binding: `si` has her package voice, the others none, an unknown id 404.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readVoiceBinding } from '../../src/bridge/agentd';
import { createFakeBridge } from '../../src/bridge/fake';

beforeEach(() => {
  window.agenticComplex = createFakeBridge({ surface: 'main', still: true });
});
afterEach(() => {
  delete window.agenticComplex;
});

describe('mock binding route', () => {
  it('reads her voice, none for the others, and 404 for an unknown character', async () => {
    expect(await readVoiceBinding('si')).toEqual({ voiceId: 'si', language: 'zh' });
    expect(await readVoiceBinding('voice_a')).toBeNull();
    await expect(readVoiceBinding('nobody')).rejects.toMatchObject({ status: 404 });
  });
});
