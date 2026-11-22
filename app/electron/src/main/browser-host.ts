// The browser extension's native messaging host on Windows, where Chrome and Edge find a host's manifest through HKCU
// (macOS has agent/browser/install.sh): written at each agentd start while the plug-in that reads the browser is on, removed
// once it is off.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { nativeHostScript } from '../common/onboarding.ts';

export const HOST_NAME = 'local.agenticcomplex.agentd';
export const HOST_KEYS = [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`];

/** A registry key's default value. */
export interface RegistryPort {
  set(key: string, value: string): Promise<void>;
  /** Fails when the key is not there. */
  remove(key: string): Promise<void>;
}

/** RegistryPort over Windows's reg.exe. */
export function regExe(env: NodeJS.ProcessEnv = process.env): RegistryPort {
  const reg = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const run = (args: string[]) => new Promise<void>((resolve, reject) =>
    execFile(reg, args, { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
  return { set: (key, value) => run(['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f']), remove: (key) => run(['delete', key, '/f']) };
}

export interface BrowserHostOptions {
  /** `<support>/native-host` gets the manifest and the `.cmd` it names. */
  supportDir: string;
  agentdStateDir: string;
  /** The component Python (`python.exe`) and its flags. */
  python: string;
  pythonFlags: string[];
  /** agent/browser/native_host.py; `extension-origin` beside it names the extension. */
  script: string;
  registry: RegistryPort;
  log(line: string): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Registers the host for Chrome and Edge when `on` and the script is there; else takes a registration made before away. */
export async function syncBrowserHost(on: boolean, o: BrowserHostOptions): Promise<void> {
  const dir = join(o.supportDir, 'native-host'), manifest = join(dir, `${HOST_NAME}.json`);
  const script = existsSync(o.script);
  if (on && !script) o.log(`BROWSER_HOST not registered: ${o.script} missing`);
  if (!on || !script) {
    if (!existsSync(manifest)) return;
    for (const key of HOST_KEYS) await o.registry.remove(key).catch((e: unknown) => o.log(`BROWSER_HOST ${key} not removed: ${message(e)}`));
    rmSync(dir, { recursive: true, force: true });
    o.log('BROWSER_HOST removed');
    return;
  }
  try {
    const origin = readFileSync(join(dirname(o.script), 'extension-origin'), 'utf8').trim();
    const cmd = nativeHostScript(o.python, o.pythonFlags, o.script, o.agentdStateDir), wrapper = join(dir, cmd.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(wrapper, cmd.text);
    writeFileSync(manifest, `${JSON.stringify({ name: HOST_NAME, description: 'Agentic Complex agentd browser bridge', path: wrapper,
      type: 'stdio', allowed_origins: [origin] }, null, 2)}\n`);
    for (const key of HOST_KEYS) await o.registry.set(key, manifest);
    o.log(`BROWSER_HOST registered ${manifest}`);
  } catch (e) {
    o.log(`BROWSER_HOST not registered: ${message(e)}`);
  }
}
