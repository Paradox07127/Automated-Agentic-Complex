// Bundles the main process to dist/main.mjs and the preload to dist/preload.cjs (a sandboxed preload is one CommonJS file); on macOS
// also compiles the preview addon to dist/native/preview.node.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildPreviewAddon } from './native/mac/build.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
// The release profile's `ui_art` (relative to the checkout), the profile chosen as tools/release/release.py's default_profile
// chooses it; Node reads it because a Windows build host has no python3.
const localProfile = join(repo, 'private/release/release.json');
const profile = process.env.AAC_RELEASE_PROFILE || (existsSync(localProfile) ? localProfile : join(repo, 'app/packaging/release.json'));
const uiArt = JSON.parse(readFileSync(profile, 'utf8')).ui_art ?? '';

const shared = { bundle: true, platform: 'node', target: 'node24', external: ['electron'], sourcemap: 'linked', logLevel: 'warning' };
await build({ ...shared, entryPoints: ['src/main/index.ts'], format: 'esm', outfile: 'dist/main.mjs',
  define: { AAC_BUILD_GIT: JSON.stringify(git), AAC_UI_ART: JSON.stringify(uiArt) } });
await build({ ...shared, entryPoints: ['src/preload/index.ts'], format: 'cjs', outfile: 'dist/preload.cjs' });
if (process.platform === 'darwin') buildPreviewAddon('dist/native/preview.node');
