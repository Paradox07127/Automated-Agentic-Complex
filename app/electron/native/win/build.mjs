// Compiles preview.cpp into a Node-API addon with MSVC, from the Visual Studio with the C++ x64 tools that vswhere finds (as
// app/helpers/windows/build.bat does). The headers and node.exe's import library come from node-api-headers; node.exe is
// delay-loaded and preview.cpp's hook binds it to the process that loads the addon, Electron's main process or Node.
// NAPI_VERSION holds the addon to what Electron 45's Node 24 has.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** vcvars64.bat of the newest Visual Studio with the C++ x64 tools. */
export function vcvars() {
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  if (!vs) throw new Error('no Visual Studio with the C++ x64 tools');
  return join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
}

export function buildPreviewAddonWin(out) {
  const target = resolve(out);
  const headers = createRequire(import.meta.url)('node-api-headers');
  mkdirSync(dirname(target), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'preview-addon-'));
  try {
    const lib = join(work, 'node.lib');
    // Through a file: cmd /c would drop the quotes around a path with (x86) in it.
    const script = join(work, 'build.bat');
    writeFileSync(script, ['@echo off',
      `call "${vcvars()}" >nul || exit /b 1`,
      `lib /nologo /def:"${headers.def_paths.node_api_def}" /name:node.exe /machine:x64 /out:"${lib}" || exit /b 1`,
      `cl /nologo /std:c++17 /O2 /MT /EHsc /W4 /WX /utf-8 /DUNICODE /D_UNICODE /DWINVER=0x0A00 /D_WIN32_WINNT=0x0A00 /DNAPI_VERSION=8`
        + ` /I"${headers.include_dir}" "${join(import.meta.dirname, 'preview.cpp')}" /Fo"${work}\\\\" /LD /Fe"${target}"`
        + ` /link /IMPLIB:"${join(work, 'preview.lib')}" "${lib}" delayimp.lib /DELAYLOAD:node.exe advapi32.lib dxgi.lib || exit /b 1`,
    ].join('\r\n') + '\r\n');
    execFileSync('cmd.exe', ['/d', '/c', script], { cwd: work, stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
