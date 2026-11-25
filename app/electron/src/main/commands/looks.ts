// Each `/feed` `looks` event, her own change of outfit, is carried out with the calls the menu makes (AvatarLooks), so it
// is remembered the same way, one at a time, and answered with `POST /avatar/looks/receipts`. Platform-free.
import { feedLooks, type FeedLooks } from '../../common/commands.ts';
import type { ModReceipt } from '../../common/looks.ts';
import type { StreamEvent } from '../../common/page.ts';
import type { HostLink } from '../renderer/link.ts';
import type { AvatarLooks } from '../renderer/looks.ts';

export interface LooksCommandOptions {
  looks: Pick<AvatarLooks, 'setAppearance' | 'setLayers' | 'saveModSettings' | 'modSettings'>;
  link: Pick<HostLink, 'currentCharacter' | 'currentAppearance'>;
  /** agentd's HTTP API. */
  post(path: string, body: unknown): Promise<{ status: number }>;
  /** The companion log. */
  log(line: string): void;
}

/** Appearance, then layers, then mod switches; stops at the first that fails. */
async function run(o: LooksCommandOptions, c: FeedLooks): Promise<void> {
  const character = o.link.currentCharacter;
  let reason: string | null = character === null ? 'no_character' : null, drawn: ModReceipt | null = null;
  if (character !== null) {
    try {
      if (c.appearance !== undefined) await o.looks.setAppearance(c.appearance);
      if (c.layers !== undefined) await o.looks.setLayers(c.layers);
      if (c.modSettings !== undefined) {
        const { appearance, values } = c.modSettings;
        // The switches she leaves out keep what the user or she chose before.
        drawn = await o.looks.saveModSettings(character, appearance, { ...o.looks.modSettings(character)[appearance], ...values });
      }
    } catch (error) {
      reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  }
  const now = o.link.currentCharacter, appearance = o.link.currentAppearance;
  const values = drawn !== null && drawn.appearance === appearance ? drawn.values
    : now !== null && appearance !== null ? o.looks.modSettings(now)[appearance] ?? {} : {};
  const { status } = await o.post('/avatar/looks/receipts',
    { request_id: c.requestId, ok: reason === null, ...(reason === null ? {} : { reason }), appearance, values });
  o.log(`FEED looks request=${c.requestId} ok=${reason === null}${reason === null ? '' : ` reason=${reason}`} receipt=${status}`);
}

/** The `/feed` subscriber (AgentStore.subscribe); a receipt that does not reach agentd is logged. */
export function looksCommands(o: LooksCommandOptions): (e: StreamEvent) => void {
  let queue = Promise.resolve();
  return (e) => {
    const c = feedLooks(e);
    if (c === null) return;
    queue = queue.then(() => run(o, c)).catch((error: unknown) =>
      o.log(`FEED looks request=${c.requestId} failed: ${error instanceof Error ? error.message : String(error)}`));
  };
}
