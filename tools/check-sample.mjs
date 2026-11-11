// Runs the data checks that need a real export against the public sample city, so they can run in CI.
// Checks that need several exports of one city (check:history) or a game save (check:sim) stay local-only.
//   npm run check:data
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const CHECKS = ['access', 'oneway', 'districts', 'transit', 'reach', 'discover', 'closure', 'schematic', 'tolls', 'groups', 'route-geometry'];

const dir = mkdtempSync(join(tmpdir(), 'skyline-sample-'));
const file = join(dir, 'Seorang.cslmap');
writeFileSync(file, gunzipSync(readFileSync('public/samples/seorang.cslmap.gz')));

let failed = 0;
for (const c of CHECKS) {
  process.stdout.write(`\n=== check:${c}\n`);
  try {
    execFileSync('npm', ['run', '-s', `check:${c}`, '--', file], { stdio: 'inherit', env: { ...process.env, CSLMAP_DIR: dir } });
  } catch {
    failed++;
    console.error(`check:${c} failed`);
  }
}
if (failed) { console.error(`\n${failed} of ${CHECKS.length} data checks failed`); process.exit(1); }
console.log(`\nall ${CHECKS.length} data checks passed on the sample city`);
