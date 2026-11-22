import type { IconName } from '../../ui';
import type { OnboardingStep } from '../../bridge';

export interface StepCopy {
  /** The step cell's name. */
  label: string;
  icon: IconName;
  /** Micro English of the card and the frame. */
  en: string;
  title: string;
  lead: string;
}

export const STEPS: Record<OnboardingStep, StepCopy> = {
  1: { label: '角色', icon: 'user', en: 'Character', title: '选她', lead: '她会出现在桌面上。名册里点一个，或导入角色包。' },
  2: { label: '对话', icon: 'g-chat', en: 'Chat', title: '连一个账号', lead: '连一个模型账号，她就能聊天、记得聊过的事。不连也能陪你。' },
  3: { label: '声音', icon: 'voice', en: 'Voice', title: '声音', lead: '她念出回答要你自己部署的语音服务；按住说话要麦克风。都可以先不开。' },
  4: { label: '完成', icon: 'check', en: 'Ready', title: '完成', lead: '' },
};

export const STEP_IDS: OnboardingStep[] = [1, 2, 3, 4];

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** The closing screen's title and line: whether she is on the desktop and can talk. */
export function doneCopy(name: string | null, talks: boolean): { title: string; lead: string } {
  if (!name) return { title: '设置完成', lead: '导入角色包后她会出现在桌面上。' };
  return { title: `${name} 已在桌面就位`, lead: talks ? '现在就能和她聊天。其余的能力在设置里按需打开。' : '她会在桌面上陪你；连上账号后才能对话。' };
}
