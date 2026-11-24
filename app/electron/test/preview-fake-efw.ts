// Builds test/native/preview-fake-efw.cpp with MSVC (Windows only), for the Windows preview tests.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vcvars } from '../native/win/build.mjs';

/** The fake efw built into `dir`. */
export function buildFakeEfw(dir: string): string {
  const exe = join(dir, 'preview-fake-efw.exe');
  const script = join(dir, 'fake-efw.bat');
  writeFileSync(script, ['@echo off', `call "${vcvars()}" >nul || exit /b 1`,
    `cl /nologo /std:c++17 /O2 /EHsc /W4 /WX /utf-8 /DUNICODE /D_UNICODE "${join(import.meta.dirname, 'native', 'preview-fake-efw.cpp')}"`
      + ` /Fo"${dir}\\\\" /Fe"${exe}" /link d3d11.lib dxgi.lib || exit /b 1`].join('\r\n') + '\r\n');
  try {
    execFileSync('cmd.exe', ['/d', '/c', script], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    throw new Error(`preview-fake-efw.cpp did not build:\n${stdout ?? ''}${stderr ?? ''}`);
  }
  return exe;
}
