// A tool run that rewrites the current character's package: the
// switch is held while it runs, then the renderer restarts on the new package. `avatar.motionChain.apply` and the import ops.
import { BridgeFailure } from '../../common/bridge.ts';
import type { AvatarHost } from './avatar.ts';
import type { OpsContext } from './context.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What she lists in her hello; empty without one. */
export const listed = (host: Pick<AvatarHost, 'hello'>): string[] => host.hello?.capabilities ?? [];

/** `reloadAvatar`: restarts the renderer and waits until it is back, at most a minute. `ctx` is an OpsContext's, or the shell's
 *  own for the MMD sync. */
export async function reloadAvatar(ctx: { switcher?: { readonly busy: boolean } | null; supervisor: { restartAvatar?(): void } | null;
  log(line: string): void; }, link: Pick<AvatarHost, 'hello'>): Promise<void> {
  while (ctx.switcher?.busy) await sleep(100);
  // The new renderer can connect within one poll, so her hello may never read as null.
  const before = link.hello;
  ctx.supervisor?.restartAvatar?.();
  const deadline = Date.now() + 60_000;
  let dropped = false;
  while (Date.now() < deadline) {
    if (link.hello !== before) dropped = true;
    if (dropped && link.hello !== null && listed(link).includes('actions')) return;
    await sleep(100);
  }
  ctx.log('avatar not back 60 s after the motion import');
}

/** `holdingMotions`: `body` on the current character while no switch or other import can start. */
export async function holdingMotions<T>(link: AvatarHost, sw: NonNullable<OpsContext['switcher']>,
  body: (character: string) => Promise<T>): Promise<T> {
  const character = link.currentCharacter;
  if (character === null) throw new BridgeFailure('internal', '角色还没连上');
  if (sw.busy || sw.held) throw new BridgeFailure('busy', '角色正在切换，或另一个导入还没完成');
  sw.held = true;
  try {
    return await body(character);
  } finally {
    sw.held = false;
  }
}
