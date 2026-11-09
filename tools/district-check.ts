// District areas are rebuilt from the district ids public-transport nodes record
// (the only nodes with real ids). This hides 10% of them, rebuilds from the rest, and scores whether each hidden node lands
// in the district it really records (incl. "no district"), old vs new method, and counts districts that come
// out in several pieces (a sign of a broken fill: in-game districts are usually one painted area).
//   npm run check:districts [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { districtGrid, districtSamples } from '../src/build';
import { HALF, MAP_SIZE } from '../src/geo';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
// previous method: only districted nodes, 4-neighbour flood ~200 m on a 32 m grid
function oldGrid(nodes: { x: number; z: number; dist: number }[]) {
  const DC = 32, dn = Math.ceil(MAP_SIZE / DC), g = new Int32Array(dn * dn), dd = new Uint8Array(dn * dn), q: number[] = [];
  for (const nd of nodes) { if (!nd.dist) continue; const i = Math.floor((nd.x + HALF) / DC), j = Math.floor((nd.z + HALF) / DC); if (i < 0 || j < 0 || i >= dn || j >= dn || g[j * dn + i]) continue; g[j * dn + i] = nd.dist; q.push(j * dn + i); }
  for (let h = 0; h < q.length; h++) { const k = q[h], i = k % dn, j = (k / dn) | 0; if (dd[k] >= 6) continue; for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) { if (a < 0 || b < 0 || a >= dn || b >= dn) continue; const p = b * dn + a; if (g[p]) continue; g[p] = g[k]; dd[p] = dd[k] + 1; q.push(p); } }
  return (x: number, z: number) => { const i = Math.floor((x + HALF) / DC), j = Math.floor((z + HALF) / DC); return i >= 0 && j >= 0 && i < dn && j < dn ? g[j * dn + i] : 0; };
}
let worst = 1, mostSplit = 0;
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  // only public-transport nodes carry a real district id; they are the ground truth
  const all = [...city.nodes.values()];
  const truth = all.filter((n) => n.srv === 'PublicTransport');
  if (!truth.some((n) => n.dist)) { console.log(`${path.basename(f).padEnd(34)} no districts`); continue; }
  const extra = districtSamples(city).filter((s) => !('srv' in s));
  const sc = { old: [0, 0, 0, 0], new: [0, 0, 0, 0] }; // [ok in-district, n in-district, ok outside, n outside]
  for (let fold = 0; fold < 10; fold++) {
    const test = truth.filter((_, i) => i % 10 === fold), hidden = new Set(test);
    const o = oldGrid(all.filter((n) => !hidden.has(n))), nw = districtGrid([...truth.filter((n) => !hidden.has(n)), ...extra]).at;
    for (const nd of test) {
      const k = nd.dist ? 0 : 2;
      for (const [name, fn] of [['old', o], ['new', nw]] as const) { sc[name][k + 1]++; if (fn(nd.x, nd.z) === nd.dist) sc[name][k]++; }
    }
  }
  const fmt = (s: number[]) => `in districts ${(s[0] / s[1] * 100).toFixed(1)}%  outside ${(s[2] / s[3] * 100).toFixed(1)}%  overall ${((s[0] + s[2]) / (s[1] + s[3]) * 100).toFixed(1)}%`;
  const acc = (sc.new[0] + sc.new[2]) / (sc.new[1] + sc.new[3]);
  worst = Math.min(worst, acc);
  // pieces: districts broken into separate patches (8-connected cells) look wrong on the map
  const pieces = (G: ReturnType<typeof districtGrid>) => {
    const seen = new Uint8Array(G.grid.length), count = new Map<number, number>();
    for (let k = 0; k < G.grid.length; k++) {
      const id = G.grid[k]; if (!id || seen[k]) continue;
      count.set(id, (count.get(id) ?? 0) + 1);
      const st = [k]; seen[k] = 1;
      while (st.length) { const c = st.pop()!, i = c % G.n, j = (c / G.n) | 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= G.n || b >= G.n) continue; const q = b * G.n + a; if (!seen[q] && G.grid[q] === id) { seen[q] = 1; st.push(q); } } }
    }
    return [...count.values()].filter((v) => v > 1).length;
  };
  const split = pieces(districtGrid([...truth, ...extra]));
  console.log(`${path.basename(f).padEnd(34)} old: ${fmt(sc.old)}\n${''.padEnd(34)} new: ${fmt(sc.new)}\n${''.padEnd(34)} districts in more than one piece: ${split}`);
  mostSplit = Math.max(mostSplit, split);
}
if (worst < 0.9) { console.error('district accuracy below 90%'); process.exit(1); }
if (mostSplit > 3) { console.error('districts come out in pieces: the fill is broken'); process.exit(1); }
