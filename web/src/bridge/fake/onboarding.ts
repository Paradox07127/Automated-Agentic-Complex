import type { BridgeError, AgenticComplexBridge, OnboardingPermissionKind, OnboardingProfile, OnboardingState, Surface, VoiceTrial } from '../protocol';
import {
  ONBOARDING_HOOKS,
  ONBOARDING_PERMISSIONS,
  ONBOARDING_PERMISSION_STATES,
  ONBOARDING_PROFILE,
  ONBOARDING_STEPS,
  ONBOARDING_TRIAL,
} from '../../mock/onboarding';

const fail = (code: string, detail: string): Promise<never> => Promise.reject({ code, detail } satisfies BridgeError);

/** The `onboarding` ops over the board's sample guide; only the onboarding surface may call it. */
export function createFakeOnboarding(surface: Surface, still: boolean): AgenticComplexBridge['onboarding'] {
  const states = { ...ONBOARDING_PERMISSION_STATES };
  let step: OnboardingState['step'] = 1;
  let done = false;
  let { callName, birthday } = ONBOARDING_PROFILE;
  let trial: VoiceTrial = { levels: [], elapsed: '00:00', transcript: '' };

  const snapshot = (): OnboardingState => ({
    steps: ONBOARDING_STEPS.map((s) => ({ ...s })),
    step,
    done,
    // No permission gates a step (PermissionKind.requiredAt is nil), so only a finished guide stops here.
    canAdvance: !done,
    canSkip: !done,
    permissions: ONBOARDING_PERMISSIONS.map(({ kind, title, purpose, promptsOnFirstUse }) => ({
      kind, title, purpose, state: states[kind],
      needsSystemSettings: states[kind] === 'denied' || (states[kind] === 'undetermined' && !promptsOnFirstUse),
    })),
    characterName: ONBOARDING_PROFILE.characterName,
    callName,
    birthday,
    talkKey: ONBOARDING_PROFILE.talkKey,
    trial: { ...trial, levels: [...trial.levels] },
    hooks: ONBOARDING_HOOKS.map((h) => ({ ...h, installSteps: [...h.installSteps] })),
    hooksCheckedAt: ONBOARDING_PROFILE.hooksCheckedAt,
    saveError: null,
    completionError: null,
  });

  const allowed = <A extends unknown[]>(op: string, run: (...args: A) => Promise<OnboardingState>) =>
    (...args: A): Promise<OnboardingState> => (surface === 'onboarding' ? run(...args) : fail('not_implemented', `onboarding.${op}`));

  const kindOf = (kind: unknown): kind is OnboardingPermissionKind => ONBOARDING_PERMISSIONS.some((p) => p.kind === kind);

  const listeners = new Set<(t: VoiceTrial) => void>();
  // One sample try on step 2, as if the talk key was held once; `still` sends none.
  const tryOnce = () => {
    if (still) return;
    queueMicrotask(() => {
      if (step !== 2) return;
      trial = { ...ONBOARDING_TRIAL, levels: [...ONBOARDING_TRIAL.levels] };
      listeners.forEach((cb) => cb({ ...trial, levels: [...trial.levels] }));
    });
  };

  return {
    state: allowed('state', async () => snapshot()),
    advance: allowed('advance', async (profile?: OnboardingProfile) => {
      if (done || step === 3) return fail('invalid_state', 'cannot advance this step');
      if (profile !== undefined) {
        const entries = Object.entries(profile as Record<string, unknown>);
        if (!entries.every(([k, v]) => (k === 'callName' || k === 'birthday') && typeof v === 'string')) {
          return fail('invalid_args', 'callName and birthday strings');
        }
        if (step !== 2) return fail('invalid_state', 'profile belongs to step 2');
        if (profile.callName !== undefined) callName = profile.callName.trim();
        if (profile.birthday !== undefined) birthday = profile.birthday.trim();
      }
      step = step === 1 ? 2 : 3;
      if (step === 2) tryOnce();
      return snapshot();
    }),
    back: allowed('back', async () => {
      if (done || step === 1) return fail('invalid_state', 'cannot go back');
      step = step === 3 ? 2 : 1;
      if (step === 2) tryOnce();
      return snapshot();
    }),
    // Step 1 closes the window for later and leaves the state as it is.
    skip: allowed('skip', async () => {
      if (done) return fail('invalid_state', 'cannot skip this step');
      if (step === 2) step = 3;
      else if (step === 3) done = true;
      return snapshot();
    }),
    complete: allowed('complete', async () => {
      if (done || step !== 3) return fail('invalid_state', 'complete at step 3');
      done = true;
      return snapshot();
    }),
    requestPermission: allowed('requestPermission', async (kind: OnboardingPermissionKind) => {
      if (!kindOf(kind)) return fail('invalid_args', 'onboarding permission kind');
      states[kind] = 'granted';
      return snapshot();
    }),
    openSettings: allowed('openSettings', async (kind: OnboardingPermissionKind) => {
      if (!kindOf(kind)) return fail('invalid_args', 'onboarding permission kind');
      return snapshot();
    }),
    onVoiceTrial: (cb) => {
      if (surface !== 'onboarding') return () => {};
      listeners.add(cb);
      if (step === 2) tryOnce();
      return () => void listeners.delete(cb);
    },
  };
}
