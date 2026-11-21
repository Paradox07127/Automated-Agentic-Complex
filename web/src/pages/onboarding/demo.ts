import type { BridgeError, OnboardingOps } from '../../bridge';
import type { DemoState } from '../../shell/demo';

/** `step2` / `step3`. */
const stepOf = (demo: string | null) => Number(/(?:^|-)step([23])$/.exec(demo ?? '')?.[1] ?? 1);

/** The fake bridge's guide per `?demo=` / `?state=` in the browser preview: steps 2 and 3 open there. */
export function demoOps(base: OnboardingOps, demo: string | null, state: DemoState | null): OnboardingOps {
  let warm: Promise<void> | null = null;
  return {
    state: async () => {
      if (state === 'loading') return new Promise<never>(() => {});
      if (state === 'error') throw { code: 'offline', detail: '' } satisfies BridgeError;
      warm ??= (async () => {
        for (let i = 1; i < stepOf(demo); i += 1) await base.advance();
      })();
      await warm;
      return base.state();
    },
    advance: () => base.advance(),
    back: () => base.back(),
    complete: (choice) => base.complete(choice),
  };
}
