// `onboarding.*`: the guide's steps. Its rows save through `settings.save` as they change; 「完成」 and 「跳过引导」 only store
// `onboarding_done` in config.json and end the guide's window (`ctx.endOnboarding`); 「和她说句话」 then opens the desktop's
// 快速输入. Completing it, not skipping it, has her greet on the desktop (`ctx.greet`), and after 「和她说句话」 say an opening line.
import { BridgeFailure } from '../../common/bridge.ts';
import { OnboardingModel } from '../../common/onboarding.ts';
import type { Ops, OpsContext } from './context.ts';
import { readObject, writeObject } from './settings.ts';

type Destination = 'home' | 'talk';

/** `onboarding.complete`'s argument: nothing, or `{ destination?: 'home' | 'talk' }`. */
function destination(input: unknown): Destination | null {
  if (input == null) return null;
  const fields = typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (fields === null || !Object.keys(fields).every((k) => k === 'destination')
    || (fields.destination !== undefined && fields.destination !== 'home' && fields.destination !== 'talk')) {
    throw new BridgeFailure('invalid_args', 'onboarding destination');
  }
  return (fields.destination as Destination | undefined) ?? null;
}

/** `onboarding.advance`'s argument: nothing, or `{ skip: true }`. */
function skipping(input: unknown): boolean {
  if (input == null) return false;
  const fields = typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (fields === null || fields.skip !== true || Object.keys(fields).length !== 1) throw new BridgeFailure('invalid_args', 'onboarding advance');
  return true;
}

export function onboardingOps(ctx: OpsContext): Ops {
  const log = (line: string) => ctx.log(`ONBOARDING ${line}`);

  /** An unreadable config.json reads as empty, so the guide still answers. */
  const raw = (): Record<string, unknown> => {
    try {
      return readObject(ctx.config.path);
    } catch {
      return {};
    }
  };
  const done = () => raw().onboarding_done === true;
  const model = new OnboardingModel();
  model.characterName = ctx.library?.characterName ?? '';

  /** Writes the mark alone; the choices were saved as they were made. */
  function finish(to: Destination | null, completed: boolean): void {
    try {
      writeObject(ctx.config.path, { ...readObject(ctx.config.path), onboarding_done: true });
    } catch (e) {
      log(`finish failed: ${e instanceof Error ? e.message : String(e)}`);
      model.completionNotSaved();
      return;
    }
    model.finished();
    log(`done destination=${to ?? 'none'}`);
    ctx.endOnboarding?.(to);
    if (to === 'talk') ctx.openQuickInput?.();
    if (completed) ctx.greet?.(to);
  }

  const steps: Record<string, (args: unknown[]) => void> = {
    'onboarding.state': () => {},
    'onboarding.advance': ([input]) => {
      const skip = skipping(input);
      if (!model.canAdvance) throw new BridgeFailure('invalid_state', 'cannot advance this step');
      model.advance(skip);
    },
    'onboarding.back': () => {
      if (model.completed || model.step === 1) throw new BridgeFailure('invalid_state', 'cannot go back');
      model.back();
    },
    'onboarding.goto': ([step]) => {
      if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > 4) throw new BridgeFailure('invalid_args', 'onboarding step');
      if (model.completed) throw new BridgeFailure('invalid_state', 'the guide is done');
      model.goto(step as number);
    },
    'onboarding.skip': () => {
      if (model.completed) throw new BridgeFailure('invalid_state', 'the guide is done');
      finish(null, false);
    },
    'onboarding.complete': ([input]) => {
      const to = destination(input);
      if (model.completed || model.step !== 4) throw new BridgeFailure('invalid_state', 'complete at the last step');
      finish(to, true);
    },
  };

  return Object.fromEntries(Object.entries(steps).map(([op, step]) => [op, (args: unknown[]) => {
    step(args);
    return model.json(done());
  }]));
}
