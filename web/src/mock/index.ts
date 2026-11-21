import type { MockModule, MockRoute } from './types';

export type { MockHandler, MockModule, MockRequest, MockResponse, MockRoute } from './types';

// Each page adds `src/mock/<id>.ts` exporting `routes`; endpoints several pages call live in `shared.ts`.
const modules = import.meta.glob<MockModule>(['./*.ts', '!./index.ts', '!./types.ts'], { eager: true });

export const mockRoutes: MockRoute[] = Object.keys(modules)
  .sort()
  .flatMap((key) => modules[key]?.routes ?? []);
