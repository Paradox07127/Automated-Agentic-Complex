// Turns off RunAsNode, EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments in a staged Electron app before it
// is signed, then prints every fuse read back as JSON. Usage: node tools/release/flip_fuses.mjs <staged .app>
// On macOS the fuse wire is in Contents/Frameworks/Electron Framework.framework/Electron Framework, not in Contents/MacOS
// (@electron/fuses pathToFuseFile), so the renamed main executable does not matter.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../app/electron/package.json', import.meta.url));
const { flipFuses, FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire, pathToFuseFile } =
  await import(pathToFileURL(require.resolve('@electron/fuses')).href);

const app = path.resolve(process.argv[2]);
// The release signs the whole app right after, so the ad hoc signature is not reset here.
await flipFuses(app, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
});
const { version, ...wire } = await getCurrentFuseWire(app);
const states = { [FuseState.ENABLE]: 'enabled', [FuseState.DISABLE]: 'disabled', [FuseState.REMOVED]: 'removed' };
const fuses = Object.fromEntries(Object.entries(wire).map(([index, state]) => [FuseV1Options[index] ?? index, states[state] ?? String(state)]));
const file = path.relative(app, pathToFuseFile(app)).split(path.sep).join('/');
console.log(JSON.stringify({ file, version, fuses }));
