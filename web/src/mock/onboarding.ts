import type { OnboardingState } from '../bridge/protocol';

// The first-run guide.

export const ONBOARDING_STEPS: OnboardingState['steps'] = [
  { id: 1, number: '01', title: '选角色' },
  { id: 2, number: '02', title: '怎么陪你' },
  { id: 3, number: '03', title: '完成' },
];

export const ONBOARDING_PROFILE = { characterName: '示例乙' };
