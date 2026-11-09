// Scores one-way direction recovery against transit ground truth (vehicles really
// drove these segments). Each segment's own transit evidence is hidden while it is
// scored (5-fold), so the number reflects segments we have no direct evidence for.
//   npm run check:oneway [files...]   (default: every export in CSLMAP_DIR)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { inferOneWay } from '../src/oneway';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2);
if (!files.length) {
  if (!existsSync(dir)) { console.log('no export folder; pass files as arguments'); process.exit(0); }
  // newest export of each city
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); })
    .map((f) => path.join(dir, f));
}
let worst = 1;
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const full = inferOneWay(city);
  const truthIds = [...full.truth.keys()];
  let ok = 0, n = 0, okRaw = 0;
  for (let fold = 0; fold < 5; fold++) {
    const hide = new Set(truthIds.filter((_, i) => i % 5 === fold));
    const r = inferOneWay(city, { hideTruth: hide });
    for (const id of hide) { n++; ok += r.dir.get(id) === full.truth.get(id) ? 1 : 0; }
  }
  // raw lane value for comparison
  for (const id of truthIds) { const s = city.segs.find((x) => x.id === id)!; const lanes = city.segTypes.get(s.name)!.lanes; okRaw += (lanes.some((l) => l.dir.includes('Backward')) ? -1 : 1) === full.truth.get(id) ? 1 : 0; }
  // dead-ends: nodes where every road is one-way yet traffic can only enter or only leave
  const at = new Map<number, number[]>();
  for (const s of city.segs) if (full.dir.has(s.id)) for (const nd of [s.sn, s.en]) at.set(nd, [...(at.get(nd) ?? []), s.id]);
  const deg = new Map<number, number>();
  for (const s of city.segs) if (!s.path && s.pts.length > 1) for (const nd of [s.sn, s.en]) deg.set(nd, (deg.get(nd) ?? 0) + 1);
  let dead = 0;
  for (const [nd, inc] of at) {
    if (inc.length < 2 || inc.length !== deg.get(nd)) continue;
    const flows = new Set(inc.map((id) => { const s = city.segs.find((x) => x.id === id)!; return full.dir.get(id)! * (s.sn === nd ? 1 : -1); }));
    if (flows.size === 1) dead++;
  }
  const acc = n ? ok / n : 1;
  worst = Math.min(worst, acc);
  const s = full.stats;
  console.log(`${path.basename(f).padEnd(34)} one-way ${String(s.oneway).padStart(5)}  groups ${String(s.groups).padStart(4)}  conflicts ${s.conflicts}  ` +
    `decided by transit ${pct(s.bySource.transit, s.oneway)} keep-right ${pct(s.bySource.keepright, s.oneway)} prior ${pct(s.bySource.prior, s.oneway)}  ` +
    `| held-out accuracy ${ok}/${n} = ${(acc * 100).toFixed(1)}% (raw lanes ${(okRaw / Math.max(1, n) * 100).toFixed(0)}%)  dead-ends ${dead}`);
}
function pct(a: number, b: number) { return `${Math.round((a / Math.max(1, b)) * 100)}%`.padStart(4); }
if (worst < 0.9) { console.error(`accuracy below 90% (${(worst * 100).toFixed(1)}%)`); process.exit(1); }
