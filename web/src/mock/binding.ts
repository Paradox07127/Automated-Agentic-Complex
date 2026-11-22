// GET /characters/:character_id/binding (binding.py:49-66): `si` speaks with her package voice; the others have none.
import { CHARACTERS } from './fixtures';
import type { MockRoute } from './types';

const VOICES: Record<string, { voice_id: string; language: string; source: 'package' | 'user' }> = {
  si: { voice_id: 'si', language: 'zh', source: 'package' },
};

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/characters/:character_id/binding',
    handler: ({ params }) => {
      const id = params.character_id ?? '';
      if (!CHARACTERS.some((c) => c.id === id)) return { status: 404, body: { error: 'unknown_character' } };
      return {
        status: 200,
        body: {
          character_id: id,
          revision: 0,
          voice: VOICES[id] ?? null,
          motion: { driver: 'game', source: 'global' },
          persona: { overrides: {}, source: 'package' },
        },
      };
    },
  },
];
