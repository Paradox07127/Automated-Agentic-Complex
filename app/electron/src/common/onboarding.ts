// The first-run guide's flow and its `onboarding.*` value: 01 选角色 → 02 怎么陪你 → 03 完成, which stores the companion
// choice; and the session hook commands and `<support>/bin` scripts the shell gives the settings.
import type { ShellPlatform } from './config.ts';

const STEPS = [{ id: 1, number: '01', title: '选角色' }, { id: 2, number: '02', title: '怎么陪你' }, { id: 3, number: '03', title: '完成' }];

/** 只陪伴 runs without light AI, 陪伴加对话 with it. */
export type Companion = 'pet' | 'chat';

const WINDOWS_HOOK = 'agentic-complex-hook.cmd';

/** The hook installer's command, without `--target`; on Windows in cmd's double quotes, with `flags` before the
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

export class OnboardingModel {
  step = 1;
  completed = false;
  characterName = '';
  completionError: string | null = null;

  /** Steps 1 and 2 go on; step 3 only completes. */
  get canAdvance(): boolean {
    return !this.completed && this.step < 3;
  }

  advance(): void {
    if (this.canAdvance) this.step += 1;
  }

  back(): void {
    if (!this.completed && this.step > 1) this.step -= 1;
  }

  /** 「完成」 on step 3 with its choice stored. */
  finished(): void {
    this.completionError = null;
    this.completed = true;
  }

  completionNotSaved(): void {
    this.completed = false;
    this.completionError = '配置没有存上，请检查配置文件权限后再点完成重试';
  }

  /** The `onboarding.*` value. */
  json(done: boolean): Record<string, unknown> {
    return { steps: STEPS, step: this.step, done, canAdvance: this.canAdvance, characterName: this.characterName, completionError: this.completionError };
  }
}
