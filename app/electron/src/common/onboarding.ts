// The first-run guide's flow and its `onboarding.*` value: 01 角色 → 02 对话 → 03 声音 → 完成, each step done, skipped or not
// reached; and the session hook commands and `<support>/bin` scripts the shell gives the settings.
import type { ShellPlatform } from './config.ts';

const STEPS = [{ id: 1, number: '01', title: '角色' }, { id: 2, number: '02', title: '对话' }, { id: 3, number: '03', title: '声音' },
  { id: 4, number: '04', title: '完成' }];

const LAST = STEPS.length;

export type StepResult = 'done' | 'skipped' | 'todo';

/** The setting ids the guide's rows save through `settings.save`; it refuses the others. */
export const GUIDE_SETTINGS: ReadonlySet<string> = new Set(['plugins.light_ai', 'mute', 'hk_ptt']);

const WINDOWS_HOOK = 'agentic-complex-hook.cmd';

/** The hook installer's command, without `--target`; on Windows in cmd's double quotes, with `flags` before the
 *  script. The hooks post to this launch's agentd (its port and hook.token), which /diag/state counts as installed. */
export function hookCommand(python: string, agentdDir: string, supportDir: string, agentd: { port: number; stateDir: string },
  platform: ShellPlatform = 'mac', flags: string[] = []): string {
  const url = `http://127.0.0.1:${agentd.port}`;
  if (platform === 'windows') {
    return [`"${python}"`, ...flags, `"${agentdDir}\\tools\\install_hooks.py"`, '--hook-script',
      `"${supportDir}\\bin\\${WINDOWS_HOOK}"`, '--url', url, '--token-file', `"${agentd.stateDir}\\hook.token"`].join(' ');
  }
  const script = `${agentdDir}/tools/install_hooks.py`;
  const quoted = script.includes(' ') ? `'${script}'` : script;
  return [`'${python}'`, ...flags, quoted, '--hook-script', `'${supportDir}/bin/agentic-complex-hook'`, '--url', url,
    '--token-file', `'${agentd.stateDir}/hook.token'`].join(' ');
}

/** `<support>/bin/<name>`, a fixed path users' settings run: `python flags script ...args` and then its own arguments, by
 *  `/bin/sh` on macOS and as a `.cmd` (name and `.cmd`) on Windows. */
function binScript(name: string, python: string, flags: string[], script: string, args: string[], platform: ShellPlatform): { name: string; text: string } {
  if (platform === 'windows') {
    const quoted = (s: string) => `"${s.replaceAll('%', '%%')}"`;
    const line = [quoted(python), ...flags, ...[script, ...args].map(quoted), '%*'].join(' ');
    if (!/[^ -~]/.test(line)) return { name: `${name}.cmd`, text: `@echo off\r\n${line}\r\n` };
    // cmd decodes each batch line in the console's code page, so the paths go to PowerShell as UTF-16 and the
    // arguments cmd was given follow as they came; the child shares the console and its standard handles.
    const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const target = [...flags, ...[script, ...args].map((s) => `"${s}"`)].join(' ');
    // Progress records (module set-up) would reach a redirected stderr as CLIXML.
    const command = `$ProgressPreference='SilentlyContinue';$p=[System.Diagnostics.Process]::new();$p.StartInfo.FileName=${literal(python)};`
      + `$p.StartInfo.Arguments=${literal(`${target} `)}+$env:AGENTIC_COMPLEX_ARGS;$p.StartInfo.UseShellExecute=$false;`
      + '[void]$p.Start();$p.WaitForExit();exit $p.ExitCode';
    const powershell = '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive';
    return { name: `${name}.cmd`, text: `@echo off\r\nset "AGENTIC_COMPLEX_ARGS=%*"\r\n${powershell} -EncodedCommand ${
      Buffer.from(command, 'utf16le').toString('base64')}\r\n` };
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

/** `native-host.cmd`, the browser extension's native messaging host on Windows: `script` (agent/browser/native_host.py)
 *  on agentd's state dir, with the origin and the window handle the browser adds. */
export function nativeHostScript(python: string, flags: string[], script: string, stateDir: string): { name: string; text: string } {
  return binScript('native-host', python, flags, script, ['--state-dir', stateDir], 'windows');
}

export class OnboardingModel {
  step = 1;
  completed = false;
  characterName = '';
  completionError: string | null = null;
  /** The results of the steps passed with 下一步, by step id. */
  private results = new Map<number, StepResult>();

  /** Steps 1–3 go on; 完成 only completes. */
  get canAdvance(): boolean {
    return !this.completed && this.step < LAST;
  }

  /** The step left counts as done, or as skipped (「稍后再连」「先不导入」). */
  advance(skip = false): void {
    if (!this.canAdvance) return;
    this.results.set(this.step, skip ? 'skipped' : 'done');
    this.step += 1;
  }

  back(): void {
    if (!this.completed && this.step > 1) this.step -= 1;
  }

  /** A step cell: any step, forward too; the steps passed keep their results. */
  goto(step: number): void {
    if (!this.completed && Number.isInteger(step) && step >= 1 && step <= LAST) this.step = step;
  }

  /** 「完成」 or 「跳过引导」 with `onboarding_done` stored. */
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
    const steps = STEPS.map((s) => ({ ...s, result: this.results.get(s.id) ?? 'todo' }));
    return { steps, step: this.step, done, canAdvance: this.canAdvance, characterName: this.characterName, completionError: this.completionError };
  }
}
