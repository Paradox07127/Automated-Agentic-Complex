// Runs `node --test` over the files given (default test/**/*.test.ts) with the TAP reporter, prints its output, then one
// line `<label> <n> passed <n> failed <n> skipped`; exits 1 when one failed or none passed. No --test-force-exit: the
// forced exit drops results still on their way to stdout, with exit 0.
// Usage: node test/count.mjs <label> [file...]
import { spawnSync } from 'node:child_process';

const [label = 'ELECTRON-UNIT', ...files] = process.argv.slice(2);
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(files.length > 0 ? files : ['test/**/*.test.ts'])],
  { encoding: 'utf8', maxBuffer: 1 << 28 });
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(out);
const count = (key) => Number(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm').exec(out)?.[1] ?? 0);
const [pass, fail, skipped] = [count('pass'), count('fail'), count('skipped')];
console.log(`${label} ${pass} passed ${fail} failed ${skipped} skipped`);
// Not process.exit: on macOS it drops what a pipe has not taken yet.
process.exitCode = run.status === 0 && fail === 0 && pass > 0 ? 0 : 1;
