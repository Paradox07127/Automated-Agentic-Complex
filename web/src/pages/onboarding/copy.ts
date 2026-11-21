import type { OnboardingPermissionKind, OnboardingPermissionState, OnboardingState } from '../../bridge';
import type { IconName } from '../../ui';
import { settingPath } from '../settings/groups';

export type Perm = OnboardingState['permissions'][number];
export type Hook = OnboardingState['hooks'][number];
/** Steps 1–3 come from the bridge; 4 is the closing screen before `complete()`. */
export type ViewStep = 1 | 2 | 3 | 4;

export interface StepCopy {
  title: string;
  chain: string;
  lead: string;
  skip?: string;
  next?: string;
  hint: string;
}

export const STEPS: Record<ViewStep, StepCopy> = {
  1: { title: '开始使用 Agentic Complex', chain: '开始', lead: '现在打开角色，或继续设置语音、称呼与编码工具。', skip: '先使用角色', next: '继续设置', hint: '使用对应功能时，可以再按需授权' },
  2: { title: '按住说话 │ 称呼', chain: '说话与称呼', lead: '试用按住说话，并设置用户称呼。', skip: '跳过', next: '下一步', hint: '称呼可留空，之后在 记忆 › 用户档案 中填写' },
  3: { title: '接入编码会话', chain: '接入会话', lead: '接入 Claude Code 和 Codex 后，角色可播报会话进度并显示审批卡。会话里的工具输入、输出和最后一条回复在本机保存 48 小时，可在 设置 › 隐私 关掉「读取编码会话」。', skip: '跳过', next: '完成设置', hint: '不接入也可使用；之后可在 设置 › pi 账号与凭据 中接入' },
  4: { title: '已在桌面就位', chain: '完成', lead: '点她互动，右键打开菜单；按住 {key} 说话。', hint: '以上选项之后均可在 设置 中修改' },
};

/** Steps 1 and 4 over STEPS when the roster is empty: nobody is on the desktop. */
export const NO_CHARACTER_STEPS: Partial<Record<ViewStep, Partial<StepCopy>>> = {
  1: { lead: '还没有角色。先完成设置，之后导入角色包。', skip: '先跳过' },
  4: { title: '设置完成', lead: '还没有角色，桌面上暂时看不到她。导入角色包后，她会出现在桌面。' },
};

export const PERM_ICON: Record<OnboardingPermissionKind, IconName> = {
  screenRecording: 'look',
  accessibility: 'hand',
  microphone: 'mic',
  automation: 'tool',
  loginItem: 'bolt',
};

export type PipKind = 'ok' | 'attention' | 'offline' | 'failed';

export const PERM_STATE: Record<OnboardingPermissionState, [PipKind, string]> = {
  granted: ['ok', '已允许'],
  undetermined: ['attention', '未决定'],
  askWhenUsed: ['offline', '使用时询问'],
  denied: ['failed', '已拒绝'],
};

export const pad2 = (n: number) => String(n).padStart(2, '0');

const MOD: Record<string, string> = { control: '⌃', ctrl: '⌃', option: '⌥', alt: '⌥', command: '⌘', cmd: '⌘', shift: '⇧' };

/** Keycap text of the configured talk key, like HotkeyLabel.text(spaced: false); '' when no key is set. */
export function keyLabel(name: string): string {
  if (name === '') return '';
  if (name === 'right_option') return '右⌥';
  const parts = name.toLowerCase().split('+');
  const mods = parts.filter((p) => p in MOD).map((p) => MOD[p]).join('');
  const keys = parts.filter((p) => !(p in MOD)).map((p) => (p === 'space' ? 'Space' : p.toUpperCase())).join('');
  return mods + keys;
}

/** Step 4's lead with the talk key, or where to set one. */
export function readyLead(keycap: string): string {
  return keycap ? STEPS[4].lead.replace('{key}', keycap) : `点她互动，右键打开菜单；按住说话的热键可在 ${settingPath('keys')} 中设置。`;
}

/** `'…/python3' '…/install_hooks.py' --hook-script '…' --target codex` reads as `python3 …/install_hooks.py --target codex`;
 * Windows' `"…\python.exe" -I -B "…\install_hooks.py" --hook-script "…" --target codex` as `python …\install_hooks.py --target codex`. */
export function shortCommand(cmd: string): string {
  return cmd
    .replace(/^('[^']*python3'|\S*python3)\s+('[^']*\/install_hooks\.py'|\S*\/install_hooks\.py)/, 'python3 …/install_hooks.py')
    .replace(/^"[^"]*python\.exe"(?: -I -B)? "[^"]*\\install_hooks\.py"/, 'python …\\install_hooks.py')
    .replace(/\s+--hook-script\s+('[^']*'|"[^"]*"|\S+)/, '');
}

export function commandLabel(cmd: string): string {
  if (/--dry-run\b/.test(cmd)) return '预览改动';
  if (cmd.startsWith('/')) return '在 Codex 中信任 hooks';
  return '执行安装';
}

/** Footer line: denied permissions first, then a failed save, then the step's own hint. */
export function footHint(step: ViewStep, perms: Perm[], error: string | null): { text: string; danger: boolean } {
  if (error) return { text: error, danger: true };
  const denied = perms.filter((p) => p.state === 'denied');
  if (denied.length > 0) {
    const what = denied[0]?.kind === 'microphone' ? '按住说话不可用，' : '对应功能停用，';
    return { text: `${denied.map((p) => p.title).join('、')}已拒绝：${what}可前往系统设置打开`, danger: true };
  }
  return { text: STEPS[step].hint, danger: false };
}
