import type { BridgeError, AgenticComplexBridge, OnboardingResult, OnboardingState, OnboardingStep, Surface } from '../protocol';
import { ONBOARDING_PROFILE, ONBOARDING_STEPS } from '../../mock/onboarding';

const fail = (code: string, detail: string): Promise<never> => Promise.reject({ code, detail } satisfies BridgeError);

const LAST = ONBOARDING_STEPS.length;

/** `complete`'s argument as the native host checks it: nothing, or `{ destination?: 'home' | 'talk' }`. */
const isEnd = (e: unknown): boolean => {
  if (e == null) return true;
  const f = typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
  return f !== null && Object.keys(f).every((k) => k === 'destination') && (f.destination === undefined || f.destination === 'home' || f.destination === 'talk');
};

/** The `onboarding` ops over the board's sample guide; only the onboarding surface may call it. */
export function createFakeOnboarding(surface: Surface): AgenticComplexBridge['onboarding'] {
  let step: OnboardingStep = 1;
  let done = false;
  const results = new Map<number, OnboardingResult>();

  const snapshot = (): OnboardingState => ({
    steps: ONBOARDING_STEPS.map((s) => ({ ...s, result: results.get(s.id) ?? 'todo' })),
    step,
    done,
    canAdvance: !done && step < LAST,
    characterName: ONBOARDING_PROFILE.characterName,
    completionError: null,
  });

  const allowed = <A extends unknown[]>(op: string, run: (...args: A) => Promise<OnboardingState>) =>
    (...args: A): Promise<OnboardingState> => (surface === 'onboarding' ? run(...args) : fail('not_implemented', `onboarding.${op}`));

  return {
    state: allowed('state', async () => snapshot()),
    advance: allowed('advance', async (opts?: { skip: true }) => {
      if (opts != null && opts.skip !== true) return fail('invalid_args', 'onboarding advance');
      if (done || step === LAST) return fail('invalid_state', 'cannot advance this step');
      results.set(step, opts?.skip ? 'skipped' : 'done');
      step = (step + 1) as OnboardingStep;
      return snapshot();
    }),
    back: allowed('back', async () => {
      if (done || step === 1) return fail('invalid_state', 'cannot go back');
      step = (step - 1) as OnboardingStep;
      return snapshot();
    }),
    goto: allowed('goto', async (to: OnboardingStep) => {
      if (!Number.isInteger(to) || to < 1 || to > LAST) return fail('invalid_args', 'onboarding step');
      if (done) return fail('invalid_state', 'the guide is done');
      step = to;
      return snapshot();
    }),
    skip: allowed('skip', async () => {
      if (done) return fail('invalid_state', 'the guide is done');
      done = true;
      return snapshot();
    }),
    complete: allowed('complete', async (end?: { destination?: 'home' | 'talk' }) => {
      if (!isEnd(end)) return fail('invalid_args', 'onboarding destination');
      if (done || step !== LAST) return fail('invalid_state', 'complete at the last step');
      done = true;
      return snapshot();
    }),
  };
}
