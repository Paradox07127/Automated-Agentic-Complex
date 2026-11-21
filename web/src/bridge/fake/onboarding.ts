import type { BridgeError, AgenticComplexBridge, OnboardingChoice, OnboardingState, Surface } from '../protocol';
import { ONBOARDING_PROFILE, ONBOARDING_STEPS } from '../../mock/onboarding';

const fail = (code: string, detail: string): Promise<never> => Promise.reject({ code, detail } satisfies BridgeError);

/** `complete`'s argument as the native host checks it. */
const isChoice = (c: unknown): c is OnboardingChoice => {
  const f = typeof c === 'object' && c !== null && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
  return (
    f !== null &&
    (f.companion === 'pet' || f.companion === 'chat') &&
    (f.destination === undefined || f.destination === 'plugins') &&
    Object.keys(f).every((k) => k === 'companion' || k === 'destination')
  );
};

/** The `onboarding` ops over the board's sample guide; only the onboarding surface may call it. */
export function createFakeOnboarding(surface: Surface): AgenticComplexBridge['onboarding'] {
  let step: OnboardingState['step'] = 1;
  let done = false;

  const snapshot = (): OnboardingState => ({
    steps: ONBOARDING_STEPS.map((s) => ({ ...s })),
    step,
    done,
    canAdvance: !done && step < 3,
    characterName: ONBOARDING_PROFILE.characterName,
    completionError: null,
  });

  const allowed = <A extends unknown[]>(op: string, run: (...args: A) => Promise<OnboardingState>) =>
    (...args: A): Promise<OnboardingState> => (surface === 'onboarding' ? run(...args) : fail('not_implemented', `onboarding.${op}`));

  return {
    state: allowed('state', async () => snapshot()),
    advance: allowed('advance', async () => {
      if (done || step === 3) return fail('invalid_state', 'cannot advance this step');
      step = step === 1 ? 2 : 3;
      return snapshot();
    }),
    back: allowed('back', async () => {
      if (done || step === 1) return fail('invalid_state', 'cannot go back');
      step = step === 3 ? 2 : 1;
      return snapshot();
    }),
    complete: allowed('complete', async (choice: OnboardingChoice) => {
      if (done || step !== 3) return fail('invalid_state', 'complete at step 3');
      if (!isChoice(choice)) return fail('invalid_args', 'onboarding choice');
      done = true;
      return snapshot();
    }),
  };
}
