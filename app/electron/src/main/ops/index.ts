// The op registry: each namespace's handlers by op name. An op without one answers `not_implemented`.
import type { Handler } from '../../common/bridge.ts';
import type { PageSession } from '../../common/page.ts';
import { agentdOps } from './agentd.ts';
import { appOps } from './app.ts';
import { avatarOps } from './avatar.ts';
import { characterOps, mmdOps } from './character.ts';
import { clipboardOps } from './clipboard.ts';
import { computerUseOps } from './computer-use.ts';
import type { OpsContext } from './context.ts';
import { diagOps } from './diag.ts';
import { eventsOps } from './events.ts';
import { feedOps } from './feed.ts';
import { filesOps } from './files.ts';
import { logsOps } from './logs.ts';
import { onboardingOps } from './onboarding.ts';
import { openOps } from './open.ts';
import { permissionsOps } from './permissions.ts';
import { previewOps } from './preview.ts';
import { servicesOps } from './services.ts';
import { settingsOps } from './settings.ts';
import { supervisorOps } from './supervisor.ts';
import { voiceOps } from './voice.ts';
import { windowOps } from './window.ts';

export type { OpsContext } from './context.ts';

export function registry(ctx: OpsContext): Map<string, Handler<PageSession>> {
  const namespaces = [agentdOps, feedOps, diagOps, eventsOps, supervisorOps, appOps, settingsOps, openOps, filesOps, clipboardOps,
    windowOps, characterOps, mmdOps, onboardingOps, avatarOps, previewOps, permissionsOps, voiceOps, computerUseOps, logsOps, servicesOps];
  return new Map(namespaces.flatMap((ns) => Object.entries(ns(ctx))));
}
