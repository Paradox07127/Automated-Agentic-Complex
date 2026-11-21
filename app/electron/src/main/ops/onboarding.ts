// `onboarding.*`: the guide's steps, the profile facts it stores in
// agentd's memory, the hook rows from `/diag/state`, `onboarding_done` in config.json, and the permission rows, which the
// platform helper reads and asks for. 「稍后」 and a saved 「开始」 end the guide's window (`ctx.endOnboarding`).
import { BridgeFailure } from '../../common/bridge.ts';
import { silentSource } from '../../common/feed.ts';
import type { EventSource } from '../../common/page.ts';
import { clock, hookReadings, hookRows, OnboardingModel, PERMISSIONS, type PermissionKind } from '../../common/onboarding.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';
import { guideState, helperRequest, helperStatus, openSettings } from './permissions.ts';
import { readObject, writeObject } from './settings.ts';

type Destination = 'home' | 'chat' | 'privacy' | 'model';

export function onboardingOps(ctx: OpsContext): Ops {
  const log = (line: string) => ctx.log(`ONBOARDING ${line}`);

  async function agentd(method: string, path: string, json?: unknown): Promise<unknown> {
    if (!ctx.agentd) throw new Error('agentd is unreachable');
    const reply = await ctx.agentd.request(method, path, json);
    if (reply.status < 200 || reply.status >= 300) throw new Error(`${method} ${path} status=${reply.status}`);
    return reply.body.length === 0 ? null : JSON.parse(reply.body.toString('utf8'));
  }

  async function profileFact(kind: string): Promise<{ fact_id: string; text: string; version: number } | undefined> {
    const memory = await agentd('GET', '/memory') as { facts?: { fact_id: string; kind: string; text: string; version: number }[] };
    return (memory.facts ?? []).find((f) => f.kind === kind);
  }

  // Saves run one after another; a kind whose last save failed sends the guide back to step 2.
  let saving: Promise<void> = Promise.resolve();
  const failed = new Set<string>();
  async function saveFact(kind: string, text: string): Promise<void> {
    try {
      const old = await profileFact(kind);
      if (old === undefined) {
        await agentd('POST', '/memory/facts', { text, kind, expected_absent: true });
      } else if (old.text !== text) {
        await agentd('PATCH', `/memory/facts/${old.fact_id}`, { text, expected_version: old.version });
      }
      failed.delete(kind);
    } catch (e) {
      log(`save ${kind} failed: ${e instanceof Error ? e.message : String(e)}`);
      failed.add(kind);
    }
  }
  async function settleSaves(done: () => void): Promise<void> {
    await saving;
    if (failed.size > 0) {
      failed.clear();
      model.factsNotSaved();
    } else {
      done();
    }
  }

  /** An unreadable config.json reads as empty, so the guide still answers. */
  const raw = (): Record<string, unknown> => {
    try {
      return readObject(ctx.config.path);
    } catch {
      return {};
    }
  };
  const done = () => raw().onboarding_done === true;
  let completion: Promise<void> | null = null;
  let destination: Destination = 'home';
  let profileLoaded = false;
  /** The helper's last `permissions.status`, read on each refresh; null when it did not answer. */
  let readings: Record<string, unknown> | null = null;
  const probe = (kind: PermissionKind) => (kind !== 'loginItem' && readings ? guideState(kind, readings[kind]) : null) ?? ctx.permission(kind);
  const model: OnboardingModel = new OnboardingModel(probe, {
    saveFact: (kind, text) => { saving = saving.then(() => saveFact(kind, text)); },
    later: () => ctx.endOnboarding?.(false, 'home'),
    complete: () => {
      completion = settleSaves(() => {
        try {
          const config = readObject(ctx.config.path);
          config.onboarding_done = true;
          writeObject(ctx.config.path, config);
          log(`done destination=${destination}`);
          ctx.endOnboarding?.(true, destination);
        } catch (e) {
          log(`finish failed: ${e instanceof Error ? e.message : String(e)}`);
          model.completionNotSaved();
        }
      });
    },
  });
  model.characterName = ctx.library?.characterName ?? '';
  model.hooks = hookRows([], ctx.library?.hookCommand ?? '', ctx.platform ?? 'mac');

  async function refreshHooks(): Promise<void> {
    let diag: unknown = null;
    try {
      diag = await agentd('GET', '/diag/state');
    } catch (e) {
      log(`diag failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    model.hooks = hookRows(hookReadings(diag), ctx.library?.hookCommand ?? '', ctx.platform ?? 'mac');
    model.hooksCheckedAt = clock(new Date());
  }

  async function refresh(): Promise<void> {
    if (!profileLoaded) {
      try {
        const [name, birthday] = [await profileFact('name'), await profileFact('birthday')];
        if (model.step === 1) {
          model.callName = name?.text ?? '';
          model.birthday = birthday?.text ?? '';
          profileLoaded = true;
        }
      } catch (e) {
        log(`profile failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    readings = await helperStatus(ctx);
    model.refreshPermissions();
    await refreshHooks();
  }

  const permissionKind = (kind: unknown): PermissionKind => {
    const found = PERMISSIONS.find((p) => p.kind === kind);
    if (!found) throw new BridgeFailure('invalid_args', 'onboarding permission kind');
    return found.kind;
  };

  async function settle(): Promise<void> {
    if (completion) {
      await completion;
      completion = null;
    } else {
      await settleSaves(() => {});
    }
  }

  function talkKey(): string {
    const key = raw().voice_hotkey;
    const name = typeof key === 'string' ? key : 'right_option';
    // A refused key reads as none, so the guide says where to set one.
    return ctx.unregisteredHotkeys?.().voice_hotkey === name ? '' : name;
  }

  const steps: Record<string, (args: unknown[]) => Promise<void> | void> = {
    'onboarding.state': () => refresh(),
    'onboarding.advance': async ([input]) => {
      if (model.completed || model.step === 3 || !model.canAdvance) throw new BridgeFailure('invalid_state', 'cannot advance this step');
      if (input !== undefined && input !== null) {
        const fields = input as Record<string, unknown>;
        if (typeof input !== 'object' || Array.isArray(input) || !Object.keys(fields).every((k) => k === 'callName' || k === 'birthday')
          || !Object.values(fields).every((v) => typeof v === 'string')) {
          throw new BridgeFailure('invalid_args', 'callName and birthday strings');
        }
        if (model.step !== 2) throw new BridgeFailure('invalid_state', 'profile belongs to step 2');
        if (typeof fields.callName === 'string') model.callName = fields.callName.trim();
        if (typeof fields.birthday === 'string') model.birthday = fields.birthday.trim();
      }
      model.refreshPermissions();
      model.advance();
      await settle();
    },
    'onboarding.requestPermission': async ([input]) => {
      const kind = permissionKind(input);
      if (kind === 'loginItem') {
        // Only the installed app's instance owns the system login item.
        if (ctx.loginItem.enabled() === false) ctx.loginItem.set(true);
      } else {
        await helperRequest(ctx, kind);
      }
      await refresh();
    },
    'onboarding.openSettings': async ([input]) => {
      const kind = permissionKind(input);
      await openSettings(ctx, kind === 'loginItem' ? 'loginItems' : kind);
      await refresh();
    },
    'onboarding.back': () => {
      if (model.completed || model.step === 1) throw new BridgeFailure('invalid_state', 'cannot go back');
      model.back();
    },
    'onboarding.skip': async () => {
      model.refreshPermissions();
      if (!model.canSkip) throw new BridgeFailure('invalid_state', 'cannot skip this step');
      model.skip();
      await settle();
    },
    'onboarding.complete': async ([input]) => {
      model.refreshPermissions();
      if (model.step !== 3 || !model.canAdvance) throw new BridgeFailure('invalid_state', 'complete at step 3');
      if (input !== undefined && input !== null) {
        if (input !== 'home' && input !== 'chat' && input !== 'privacy' && input !== 'model') throw new BridgeFailure('invalid_args', 'onboarding destination');
        destination = input;
      } else {
        destination = 'home';
      }
      model.advance();
      await settle();
    },
  };

  let busy = false;
  const ops: Ops = Object.fromEntries(Object.entries(steps).map(([op, step]) => [op, async (args: unknown[]) => {
    if (busy) throw new BridgeFailure('busy', op);
    busy = true;
    try {
      await step(args);
    } finally {
      busy = false;
    }
    return model.json(done(), talkKey());
  }]));
  // Only step 2 shows a try.
  const trials: EventSource = {
    subscribe: (afterSeq, onEvent, onReload) => (ctx.voiceTrial ?? silentSource).subscribe(afterSeq, (e) => {
      if (model.step !== 2) return;
      model.trial = JSON.parse(e.data) as OnboardingModel['trial'];
      onEvent(e);
    }, onReload),
  };
  ops['onboarding.onVoiceTrial'] = watch('onboarding.onVoiceTrial', trials);
  return ops;
}
