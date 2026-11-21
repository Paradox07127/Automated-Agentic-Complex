// The first-run guide's flow and its `onboarding.*` value: 01 permissions →
// 02 push-to-talk trial and call name → 03 session hooks → done.
import type { ShellPlatform } from './config.ts';

export type PermissionKind = 'screenRecording' | 'accessibility' | 'microphone' | 'automation' | 'loginItem';
export type PermissionState = 'granted' | 'undetermined' | 'askWhenUsed' | 'denied';

/** In the order the guide lists them. */
export const PERMISSIONS: { kind: PermissionKind; title: string; purpose: string; promptsOnFirstUse: boolean }[] = [
  { kind: 'screenRecording', title: '屏幕录制', purpose: '屏幕识读和窗口截图，只在你点「屏幕识读」时截取', promptsOnFirstUse: false },
  { kind: 'accessibility', title: '设备控制与数据访问（辅助功能）', purpose: '可选：读取焦点控件和选中文字；读取范围单独在隐私设置选择',
    promptsOnFirstUse: false },
  { kind: 'microphone', title: '麦克风与语音识别', purpose: '按住右 Option 说话；第一次按热键时系统会问', promptsOnFirstUse: true },
  { kind: 'automation', title: '自动化', purpose: '检测「终端」授权，用于跳转终端会话。Safari 和 Chrome 的授权独立。', promptsOnFirstUse: true },
  { kind: 'loginItem', title: '登录时启动', purpose: '开机后角色自动出现，可在 设置 › 启动与关于 关闭', promptsOnFirstUse: false },
];

const STEPS = [{ id: 1, number: '01', title: '权限' }, { id: 2, number: '02', title: '按住说话 · 称呼' }, { id: 3, number: '03', title: '接上会话' }];

export interface Hook {
  id: string; name: string; connected: boolean; lastEvent: string | null; installHint: string; installSteps: string[];
}

/** One agent's entry in `/diag/state`'s `hooks` block. */
export interface HookReading { target: string; installed: boolean | null; lastAt: Date | null }

/** claude first, then codex; empty when the snapshot has no `hooks` block. */
export function hookReadings(diag: unknown): HookReading[] {
  const hooks = typeof diag === 'object' && diag !== null ? (diag as Record<string, unknown>).hooks : undefined;
  if (typeof hooks !== 'object' || hooks === null) return [];
  return ['claude', 'codex'].flatMap((target) => {
    const entry = (hooks as Record<string, unknown>)[target];
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const at = typeof e.last_at === 'string' ? new Date(e.last_at) : null;
    return [{ target, installed: typeof e.installed === 'boolean' ? e.installed : null,
      lastAt: at !== null && !Number.isNaN(at.getTime()) ? at : null }];
  });
}

const WINDOWS_HOOK = 'agentic-complex-hook.cmd';

/** The install command of the guide's hook rows, without `--target`; on Windows in cmd's double quotes, with `flags` before the
 *  script. */
export function hookCommand(python: string, agentdDir: string, supportDir: string, platform: ShellPlatform = 'mac', flags: string[] = []): string {
  if (platform === 'windows') {
    return [`"${python}"`, ...flags, `"${agentdDir}\\tools\\install_hooks.py"`, '--hook-script',
      `"${supportDir}\\bin\\${WINDOWS_HOOK}"`].join(' ');
  }
  const script = `${agentdDir}/tools/install_hooks.py`;
  const quoted = script.includes(' ') ? `'${script}'` : script;
  return [`'${python}'`, ...flags, quoted, '--hook-script', `'${supportDir}/bin/agentic-complex-hook'`].join(' ');
}

/** `<support>/bin/<name>`, a fixed path users' settings run: `python flags script ...args` and then its own arguments, by
 *  `/bin/sh` on macOS and as a `.cmd` (name and `.cmd`) on Windows. */
function binScript(name: string, python: string, flags: string[], script: string, args: string[], platform: ShellPlatform): { name: string; text: string } {
  if (platform === 'windows') {
    const quoted = (s: string) => `"${s.replaceAll('%', '%%')}"`;
    const line = [quoted(python), ...flags, ...[script, ...args].map(quoted), '%*'].join(' ');
    // cmd decodes each batch line in the console's code page: UTF-8 from here on when a path is not ASCII.
    return { name: `${name}.cmd`, text: `@echo off\r\n${/[^ -~]/.test(line) ? 'chcp 65001 >nul\r\n' : ''}${line}\r\n` };
  }
  const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return { name, text: `#!/bin/sh\nexec ${[python, ...flags, script, ...args].map(quoted).join(' ')} "$@"\n` };
}

/** The hook settings' script: it runs `<agentdDir>/codex_hook_forward.py` with the hook's arguments. */
export function hookScript(python: string, flags: string[], agentdDir: string, platform: ShellPlatform): { name: string; text: string } {
  const forwarder = platform === 'windows' ? `${agentdDir}\\codex_hook_forward.py` : `${agentdDir}/codex_hook_forward.py`;
  return binScript('agentic-complex-hook', python, flags, forwarder, [], platform);
}

/** `agentic-complex`, the CLI and MCP server outside agents run: `<agentdDir>/tools/agentic_complex.py` on this launch's
 *  agentd state dir, told its own path in `binDir` so `install-mcp` writes it into the agents' settings. */
export function cliScript(python: string, flags: string[], agentdDir: string, stateDir: string, binDir: string,
  platform: ShellPlatform): { name: string; text: string } {
  const windows = platform === 'windows', sep = windows ? '\\' : '/';
  const self = `${binDir}${sep}agentic-complex${windows ? '.cmd' : ''}`;
  return binScript('agentic-complex', python, flags, `${agentdDir}${sep}tools${sep}agentic_complex.py`,
    ['--state-dir', stateDir, '--launcher', self], platform);
}

/** `HH:mm:ss` in local time. */
export function clock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One row per agent; an agent agentd did not report reads as not connected. The hooks run in the background, so a
 *  session never waits for them. */
export function hookRows(readings: HookReading[], command: string, platform: ShellPlatform): Hook[] {
  const where = platform === 'windows' ? '在命令提示符（cmd）里' : '在终端里';
  return [['claude', 'Claude Code hooks', `${where}按下面两步只接入 Claude Code，之后新开的会话就会接上；hook 在后台运行，不拖慢会话`],
    ['codex', 'Codex', `${where}按下面两步装好，再打开一次 codex，在「Hooks need review」里（或输入 /hooks）信任它们；hook 在后台运行，不拖慢会话`]].map(([id, name, hint]) => {
    const r = readings.find((x) => x.target === id);
    return { id: id!, name: name!, connected: r !== undefined && (r.installed === true || r.lastAt !== null),
      lastEvent: r?.lastAt ? clock(r.lastAt) : null, installHint: hint!,
      installSteps: [`${command} --target ${id} --dry-run`, `${command} --target ${id}`] };
  });
}

export interface OnboardingActions {
  /** A fact the user typed in on step 2 (`name` or `birthday`). */
  saveFact(kind: 'name' | 'birthday', text: string): void;
  /** 「稍后」 on step 1: close for now without finishing. */
  later(): void;
  complete(): void;
}

export class OnboardingModel {
  step = 1;
  completed = false;
  characterName = '';
  callName = '';
  birthday = '';
  trial = { levels: [] as number[], elapsed: '00:00', transcript: '' };
  hooks: Hook[] = [];
  hooksCheckedAt = '';
  saveError: string | null = null;
  completionError: string | null = null;
  private permissions = new Map<PermissionKind, PermissionState>();
  private readonly probe: (kind: PermissionKind) => PermissionState;
  private readonly actions: OnboardingActions;

  constructor(probe: (kind: PermissionKind) => PermissionState, actions: OnboardingActions) {
    this.probe = probe;
    this.actions = actions;
    this.refreshPermissions();
  }

  /** No permission gates a step (PermissionKind.requiredAt is nil for all). */
  get canAdvance(): boolean {
    return !this.completed;
  }

  /** Step 1's 「稍后」 always works; on later steps skipping is gated like 「下一步」. */
  get canSkip(): boolean {
    return this.step === 1 ? !this.completed : this.canAdvance;
  }

  refreshPermissions(): void {
    this.permissions = new Map(PERMISSIONS.map((p) => [p.kind, this.probe(p.kind)]));
  }

  /** 「继续」/「下一步」/「开始」. */
  advance(): void {
    if (!this.canAdvance) return;
    if (this.step === 1) {
      this.step = 2;
    } else if (this.step === 2) {
      this.saveError = null;
      const name = this.callName.trim(), day = this.birthday.trim();
      if (name !== '') this.actions.saveFact('name', name);
      if (day !== '') this.actions.saveFact('birthday', day);
      this.step = 3;
    } else {
      this.finish();
    }
  }

  /** 「稍后」/「跳过」/「以后再接」. */
  skip(): void {
    if (!this.canSkip) return;
    if (this.step === 1) this.actions.later();
    else if (this.step === 2) this.step = 3;
    else this.finish();
  }

  back(): void {
    if (!this.completed && this.step > 1) this.step -= 1;
  }

  /** The facts of step 2 were not stored: back there instead of finishing. */
  factsNotSaved(): void {
    this.completed = false;
    this.step = 2;
    this.saveError = '称呼或生日没存上，再点一次下一步重试';
  }

  completionNotSaved(): void {
    this.completed = false;
    this.completionError = '配置没有存上，请检查配置文件权限后再点开始重试';
  }

  /** The `onboarding.*` value. */
  json(done: boolean, talkKey: string): Record<string, unknown> {
    return {
      steps: STEPS, step: this.step, done, canAdvance: this.canAdvance, canSkip: this.canSkip,
      permissions: PERMISSIONS.map((p) => {
        const state = this.permissions.get(p.kind) ?? 'undetermined';
        return { kind: p.kind, title: p.title, purpose: p.purpose, state,
          needsSystemSettings: state === 'denied' || (state === 'undetermined' && !p.promptsOnFirstUse) };
      }),
      characterName: this.characterName, callName: this.callName, birthday: this.birthday, talkKey, trial: this.trial,
      hooks: this.hooks, hooksCheckedAt: this.hooksCheckedAt, saveError: this.saveError, completionError: this.completionError,
    };
  }

  private finish(): void {
    this.completionError = null;
    this.completed = true;
    this.actions.complete();
  }
}
