// GET /characters/:character_id/mod-settings (C6): `si` has a table for 夏装; the other characters' packages have none.
import { CHARACTERS, MOD_SETTINGS } from './fixtures';
import type { MockRoute } from './types';

export const routes: MockRoute[] = [
  {
    method: 'GET',
    path: '/characters/:character_id/mod-settings',
    handler: ({ params }) => {
      const id = params.character_id ?? '';
      if (!CHARACTERS.some((c) => c.id === id)) return { status: 404, body: { error: 'unknown_character' } };
      return {
        status: 200,
        body: { character: id, package_sha256: 'a'.repeat(64), schema: 'endfield-mod-settings/v1', appearances: MOD_SETTINGS[id] ?? {} },
      };
    },
  },
];
