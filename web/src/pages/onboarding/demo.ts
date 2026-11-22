import type { BridgeError, CharacterEntry, OnboardingOps, PermissionKind, PermissionState, SettingValue } from '../../bridge';
import type { DemoState } from '../../shell/demo';
import type { WireModelSettings } from '../settings/wire';

// The browser preview's views (`?demo=`); the native guide never reads them.

/** The step each view opens on; the steps before it count as passed. */
const STEP: Record<string, number> = {
  chat: 2, 'chat-ok': 2, 'chat-off': 2, 'chat-key': 2, 'agentd-off': 2, skip: 2,
  voice: 3, 'voice-novoice': 3, 'voice-granted': 3,
  done: 4,
};

const CONNECTED = new Set(['chat-ok', 'voice', 'voice-novoice', 'voice-granted', 'done']);

/** The fake bridge's guide per `?demo=` / `?state=`. */
export function demoOps(base: OnboardingOps, demo: string | null, state: DemoState | null): OnboardingOps {
  let warm: Promise<void> | null = null;
  return {
    state: async () => {
      if (state === 'loading') return new Promise<never>(() => {});
      if (state === 'error') throw { code: 'offline', detail: '' } satisfies BridgeError;
      warm ??= (async () => {
        for (let i = 1; i < (STEP[demo ?? ''] ?? 1); i += 1) await base.advance();
      })();
      await warm;
      return base.state();
    },
    advance: (opts) => base.advance(opts),
    back: () => base.back(),
    goto: (step) => base.goto(step),
    skip: () => base.skip(),
    complete: (end) => base.complete(end),
  };
}

/** The view's agentd: down on agentd-off. */
export const demoAgentdOff = (demo: string | null) => demo === 'agentd-off';

/** The view's saved values: 和她对话 off on chat-off, on elsewhere. */
export function demoSaved(demo: string | null, saved: Record<string, SettingValue>): Record<string, SettingValue> {
  return { ...saved, 'plugins.light_ai': demo !== 'chat-off', mute: false, tts: 'local' };
}

/** The view's account: one ChatGPT sign-in once connected, none before; DeepSeek without a key on chat-key. */
export function demoModels(demo: string | null, m: WireModelSettings): WireModelSettings {
  if (demo === 'chat-key') return { ...m, provider: 'deepseek' };
  const connected = CONNECTED.has(demo ?? '');
  return {
    ...m,
    provider: 'chatgpt',
    chatgpt: connected
      ? { active: 'demo', pending: false, error: null, profiles: [{ id: 'demo', label: '连接 1', email: 'me@example.com', connected: true, sharing: false }] }
      : { active: null, pending: false, error: null, profiles: [] },
  };
}

/** The view's permissions: on voice the microphone refused and input monitoring never asked. */
export function demoPerms(demo: string | null, s: Partial<Record<PermissionKind, PermissionState>>): Partial<Record<PermissionKind, PermissionState>> {
  if (demo === 'voice') return { ...s, microphone: 'denied', inputMonitoring: 'notDetermined' };
  if (demo === 'voice-granted') return { ...s, microphone: 'granted', inputMonitoring: 'granted' };
  return s;
}

/** The view's roster: empty on char-empty, her voice gone on voice-novoice. */
export function demoRoster(demo: string | null, list: CharacterEntry[]): CharacterEntry[] {
  if (demo === 'char-empty') return [];
  if (demo === 'voice-novoice') return list.map((c) => (c.active ? { ...c, voice: false } : c));
  return list;
}
