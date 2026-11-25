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
  1: { label: '角色', icon: 'user', en: 'Character', title: '选择角色', lead: '所选角色将在桌面上显示。可在名册中点选，或导入角色包。' },
  2: { label: '对话', icon: 'g-chat', en: 'Chat', title: '连接模型账号', lead: '连接模型账号后即可与角色对话并保留记忆；跳过连接仍可使用桌面陪伴。' },
  3: { label: '声音', icon: 'voice', en: 'Voice', title: '语音配置', lead: '语音播报需连接自建语音服务，按住语音输入需授予麦克风等系统权限；均可稍后再配置。' },
  4: { label: '完成', icon: 'check', en: 'Ready', title: '完成', lead: '' },
};

export const STEP_IDS: OnboardingStep[] = [1, 2, 3, 4];

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** The closing screen's title and line: whether she is on the desktop and can talk. */
export function doneCopy(name: string | null, talks: boolean): { title: string; lead: string } {
  if (!name) return { title: '配置完成', lead: '导入角色包后，角色将在桌面显示。' };
  return { title: `${name} 已就绪`, lead: talks ? `现可与 ${name} 进行对话，其余功能可在「设置」中按需开启。` : `${name} 已启用桌面陪伴；连接模型账号后可开启对话功能。` };
}
