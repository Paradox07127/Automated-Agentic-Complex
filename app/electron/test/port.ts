// Test ports no two running test processes share, tried from the checkout's own one. Kept clear of 48800 (the live agentd).
// A process holds its port by a listening socket 1000 ports below it until it exits; the port itself is agentd's to bind
// and to lose.
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../..');

async function claimPort(base: number, span: number): Promise<number> {
  const first = createHash('sha256').update(REPO).digest().readUInt32BE(0) % span;
  for (let i = 0; i < span; i += 1) {
    const port = base + (first + i) % span;
    const claim = createServer().unref();
    if (await new Promise<boolean>((r) => {
      claim.once('error', () => r(false)).listen({ host: '127.0.0.1', port: port - 1000 }, () => r(true));
    })) return port;
  }
  throw new Error(`every test port of ${base}–${base + span - 1} is taken`);
}

/** agentd.integration.test.ts: 48970–49044. */
export const integrationPort = (): Promise<number> => claimPort(48970, 75);
/** e2e-headless.test.ts: 49045–49119. */
export const e2ePort = (): Promise<number> => claimPort(49045, 75);
