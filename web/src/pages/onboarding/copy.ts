import type { OnboardingCompanion, OnboardingStep } from '../../bridge';
import { settingPath } from '../settings/groups';

export type ViewStep = OnboardingStep;

export interface StepCopy {
  title: string;
  lead: string;
  next: string;
  hint: string;
}

export const STEPS: Record<ViewStep, StepCopy> = {
  1: { title: '选角色', lead: '她会出现在桌面上；也可以导入新的角色包。', next: '下一步', hint: '之后可在 角色 页切换和导入' },
  2: { title: '怎么陪你', lead: '选一种，马上就能用。', next: '下一步', hint: `之后可在 ${settingPath('perm')} 中修改` },
  3: { title: '已在桌面就位', lead: `点她互动，右键打开菜单；更多功能在 ${settingPath('perm')} 里按需打开。`, next: '完成', hint: '以上选项之后均可在 设置 中修改' },
};

/** Steps 1 and 3 over STEPS when the roster is empty: nobody is on the desktop. */
export const NO_CHARACTER_STEPS: Partial<Record<ViewStep, Partial<StepCopy>>> = {
  1: { lead: '还没有角色。先完成设置，之后导入角色包。' },
  3: { title: '设置完成', lead: `桌面上暂时看不到她，导入角色包后她会出现；更多功能在 ${settingPath('perm')} 里按需打开。` },
};

export const COMPANIONS: Array<{ id: OnboardingCompanion; name: string; line: string }> = [
  { id: 'pet', name: '只陪伴', line: '她在桌面上活动，点她、摸头都有反应；不用 AI 账号。' },
  { id: 'chat', name: '陪伴加对话', line: '还能和她聊天，她会记得聊过的事；完成后连一个 AI 账号。' },
];

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** Footer line: a failed op or save first, then the step's own hint. */
export function footHint(step: ViewStep, error: string | null): { text: string; danger: boolean } {
  return error ? { text: error, danger: true } : { text: STEPS[step].hint, danger: false };
}
