import type { OnboardingPermissionKind, OnboardingPermissionState, OnboardingState, VoiceTrial } from '../bridge/protocol';

// The first-run guide; samples other than the step titles follow the prototype's pages/onboarding.js.

export const ONBOARDING_STEPS: OnboardingState['steps'] = [
  { id: 1, number: '01', title: '权限' },
  { id: 2, number: '02', title: '按住说话 · 称呼' },
  { id: 3, number: '03', title: '接上会话' },
];

export { ONBOARDING_PERMISSIONS } from '../pages/onboarding/permissions';

/** FakePermissionProbe.boardSample(). */
export const ONBOARDING_PERMISSION_STATES: Record<OnboardingPermissionKind, OnboardingPermissionState> = {
  screenRecording: 'granted',
  accessibility: 'undetermined',
  microphone: 'undetermined',
  automation: 'askWhenUsed',
  loginItem: 'granted',
};

const HOOK_INSTALLER =
  "'/path/to/runtime/python/bin/python3' '/path/to/agentd/tools/install_hooks.py' --hook-script '/path/to/support/bin/agentic-complex-hook'";

/** HookIntegration.samples. */
export const ONBOARDING_HOOKS: OnboardingState['hooks'] = [
  { id: 'claude', name: 'Claude Code', connected: true, lastEvent: '14:29:06', installHint: '', installSteps: [] },
  {
    id: 'codex',
    name: 'Codex',
    connected: false,
    lastEvent: null,
    installHint: '按以下三步安装，然后重启 Codex',
    installSteps: [`${HOOK_INSTALLER} --target codex --dry-run`, `${HOOK_INSTALLER} --target codex`, '/hooks'],
  },
];

/** VoiceTrial.sample. */
export const ONBOARDING_TRIAL: VoiceTrial = {
  levels: Array.from({ length: 44 }, (_, i) => Math.round(3 + 15 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)))),
  elapsed: '00:02',
  transcript: '你好，我叫阿砚',
};

export const ONBOARDING_PROFILE = { characterName: '示例乙', callName: '阿砚', birthday: '', talkKey: 'right_option', hooksCheckedAt: '14:03:20' };
