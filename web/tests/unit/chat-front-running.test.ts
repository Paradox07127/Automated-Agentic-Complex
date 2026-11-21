import { describe, expect, it } from 'vitest';
import { frontRunning } from '../../src/pages/chat/useChatData';

const run = (run_id: string, state = 'running') => ({ run_id, state });

describe('frontRunning: only a running foreground line counts', () => {
  it('counts a running line', () => {
    expect(frontRunning([run('47a904639f2e')])).toBe(true);
  });

  it('skips background jobs and observation semantic runs', () => {
    expect(frontRunning([run('bg-520a5c2ae1ab46609620e8b6325d8db9'), run('semantic-cc3201d0344b4c1e9a7d5f0e2b6c8a91')])).toBe(false);
  });

  it('skips finished lines', () => {
    expect(frontRunning([run('47a904639f2e', 'completed')])).toBe(false);
  });
});
