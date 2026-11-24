// Compiles preview.m into a Node-API addon with the Xcode clang. Node-API is ABI-stable, so the headers of the Node that runs the
// build serve the Node inside the pinned Electron; NAPI_VERSION holds the addon to what Electron 45's Node 24 has.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function buildPreviewAddon(out) {
  const include = join(dirname(process.execPath), '../include/node');
  if (!existsSync(join(include, 'node_api.h'))) throw new Error(`no node_api.h under ${include}`);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync('xcrun', ['clang', '-bundle', '-undefined', 'dynamic_lookup', '-fobjc-arc', '-O2', '-Wall', '-Werror',
    '-DNAPI_VERSION=8', '-mmacosx-version-min=15.0', `-I${include}`, '-framework', 'AppKit', '-framework', 'IOSurface',
    join(import.meta.dirname, 'preview.m'), '-o', out], { stdio: 'inherit' });
}
