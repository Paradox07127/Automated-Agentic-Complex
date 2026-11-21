import type { BridgeError, OnboardingOps, OnboardingPermissionKind, OnboardingPermissionState, OnboardingState } from '../../bridge';
import type { DemoState } from '../../shell/demo';
import { ONBOARDING_PERMISSIONS } from './permissions';

const FRESH: Record<OnboardingPermissionKind, OnboardingPermissionState> = {
  screenRecording: 'undetermined',
  accessibility: 'undetermined',
  microphone: 'undetermined',
  automation: 'askWhenUsed',
  loginItem: 'undetermined',
};

/** `step2`–`step4`, alone or after `denied-` / `sparse-`. */
const stepOf = (demo: string | null) => Number(/(?:^|-)step([234])$/.exec(demo ?? '')?.[1] ?? 1);

/** `?demo=step4` opens on the closing screen. */
export const demoReady = (demo: string | null) => stepOf(demo) === 4;

const needsSettings = (kind: OnboardingPermissionKind, state: OnboardingPermissionState) =>
  state === 'denied' || (state === 'undetermined' && !ONBOARDING_PERMISSIONS.find((p) => p.kind === kind)?.promptsOnFirstUse);

/**
 * The fake bridge's guide per `?demo=` / `?state=` in the browser preview: steps 2–4 open there, `denied` and `sparse`
 * (a new Mac) change the samples, and 前往系统设置 comes back granted like after the user allowed it.
 */
export function demoOps(base: OnboardingOps, demo: string | null, state: DemoState | null): OnboardingOps {
  const sparse = demo?.startsWith('sparse') ?? false;
  const perm: Partial<Record<OnboardingPermissionKind, OnboardingPermissionState>> = sparse ? { ...FRESH } : demo?.startsWith('denied') ? { microphone: 'denied' } : {};
  let blankName = sparse;
  let warm: Promise<void> | null = null;

  const wrap = (s: OnboardingState): OnboardingState => ({
    ...s,
    permissions: s.permissions.map((p) => {
      const st = perm[p.kind] ?? p.state;
      return st === p.state ? p : { ...p, state: st, needsSystemSettings: needsSettings(p.kind, st) };
    }),
    callName: blankName ? '' : s.callName,
    hooks: sparse ? s.hooks.map((h) => ({ ...h, connected: false, lastEvent: null })) : s.hooks,
    trial: sparse ? { levels: [], elapsed: '00:00', transcript: '' } : s.trial,
  });
  const grant = (kind: OnboardingPermissionKind) => {
    perm[kind] = 'granted';
  };

  return {
    state: async () => {
      if (state === 'loading') return new Promise<never>(() => {});
      if (state === 'error') throw { code: 'offline', detail: '' } satisfies BridgeError;
      warm ??= (async () => {
        for (let i = 1; i < Math.min(stepOf(demo), 3); i += 1) await base.advance();
      })();
      await warm;
      return wrap(await base.state());
    },
    advance: async (profile) => {
      if (profile?.callName !== undefined) blankName = false;
      return wrap(await base.advance(profile));
    },
    back: async () => wrap(await base.back()),
    skip: async () => wrap(await base.skip()),
    complete: async () => wrap(await base.complete()),
    requestPermission: async (kind) => {
      grant(kind);
      return wrap(await base.requestPermission(kind));
    },
    openSettings: async (kind) => {
      grant(kind);
      return wrap(await base.openSettings(kind));
    },
    onVoiceTrial: (cb) => (sparse ? () => {} : base.onVoiceTrial(cb)),
  };
}
