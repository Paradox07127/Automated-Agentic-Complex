// `onboarding.*`: the guide's three steps; 「完成」 stores the companion choice as `plugins.light_ai` and `onboarding_done` in
// config.json, restarts agentd when the plug-in changed, and ends the guide's window at the choice's destination
// (`ctx.endOnboarding`).
import { BridgeFailure } from '../../common/bridge.ts';
import { type Companion, OnboardingModel } from '../../common/onboarding.ts';
import { planSave, settingValues, withSettings } from '../../common/settings.ts';
import type { Ops, OpsContext } from './context.ts';
import { readObject, writeObject } from './settings.ts';

interface Choice { companion: Companion; destination?: 'plugins' }

/** `onboarding.complete`'s argument: `{ companion: 'pet' | 'chat', destination?: 'plugins' }` and nothing else. */
function choice(input: unknown): Choice {
  const fields = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (fields === null || (fields.companion !== 'pet' && fields.companion !== 'chat')
    || (fields.destination !== undefined && fields.destination !== 'plugins')
    || !Object.keys(fields).every((k) => k === 'companion' || k === 'destination')) {
    throw new BridgeFailure('invalid_args', 'onboarding choice');
  }
  return fields as unknown as Choice;
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

  /** Writes the choice and the mark at once; a changed plug-in restarts agentd like a saved `restart: 'backend'` row. */
  function finish({ companion, destination }: Choice): void {
    const light = { 'plugins.light_ai': companion === 'chat' };
    let restart: string;
    try {
      const config = readObject(ctx.config.path);
      restart = planSave(settingValues(config), null, light, ctx.platform ?? 'mac').restart;
      writeObject(ctx.config.path, { ...withSettings(config, light), onboarding_done: true });
    } catch (e) {
      log(`finish failed: ${e instanceof Error ? e.message : String(e)}`);
      model.completionNotSaved();
      return;
    }
    model.finished();
    if (restart === 'backend') ctx.supervisor?.restart();
    const to = destination ?? (companion === 'chat' ? 'model' : 'home');
    log(`done companion=${companion} destination=${to}`);
    ctx.endOnboarding?.(to);
  }

  const steps: Record<string, (args: unknown[]) => void> = {
    'onboarding.state': () => {},
    'onboarding.advance': () => {
      if (!model.canAdvance) throw new BridgeFailure('invalid_state', 'cannot advance this step');
      model.advance();
    },
    'onboarding.back': () => {
      if (model.completed || model.step === 1) throw new BridgeFailure('invalid_state', 'cannot go back');
      model.back();
    },
    'onboarding.complete': ([input]) => {
      if (model.completed || model.step !== 3) throw new BridgeFailure('invalid_state', 'complete at step 3');
      finish(choice(input));
    },
  };

  return Object.fromEntries(Object.entries(steps).map(([op, step]) => [op, (args: unknown[]) => {
    step(args);
    return model.json(done());
  }]));
}
