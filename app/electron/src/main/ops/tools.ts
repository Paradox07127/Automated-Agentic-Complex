// agentd's command-line tools (motion_tool.py, character_tool.py), and the host they validate with.
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ImportProgress, parseProgress } from '../../common/import-state.ts';
import type { ToolResult } from './context.ts';

/** `<python> <pythonFlags> <agentdDir>/<script> <args>`. Stdout is read as it comes, each progress line going to `progress`;
 *  `signal` sends the tool SIGTERM, and the result still waits for its exit, which releases the library lock. */
export function runAgentdTool(python: string, pythonFlags: string[], agentdDir: string, script: string, args: string[],
  progress?: (p: ImportProgress) => void, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [...pythonFlags, join(agentdDir, script), ...args], { cwd: agentdDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => child.kill('SIGTERM');
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    let partial = '', last = '', stderr = '';
    const read = (line: string) => {
      if (line === '') return;
      const p = parseProgress(line);
      if (p === null) last = line;
      else progress?.(p);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop()!;
      lines.forEach(read);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-8192); });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      read(partial.replace(/\r$/, ''));
      resolve({ last, status: code ?? -1, stderr: code === 0 ? '' : stderr });
    });
  });
}

/** `avatar_executable`, else the avatar app bundle's executable. */
export function validationHost(avatarExecutable: string | null, avatarApp: string): string {
  let host = avatarExecutable ?? '';
  if (host === '' && avatarApp !== '') {
    try {
      const plist = readFileSync(join(avatarApp, 'Contents', 'Info.plist'), 'utf8');
      const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
      if (name !== undefined) host = join(avatarApp, 'Contents', 'MacOS', name);
    } catch { /* no bundle */ }
  }
  if (host === '') throw new Error('未配置 Metal 宿主可执行文件');
  try {
    accessSync(host, constants.X_OK);
  } catch {
    throw new Error(`Metal 宿主可执行文件不存在或无法执行：${host}`);
  }
  return host;
}
