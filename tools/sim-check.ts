// Simulation data (.crp) checks against real saves and exports on this computer.
//   npm run check:sim
// Saves:   $CS_SAVES_DIR  (default: the game's Saves folder on macOS)
// Exports: $CSLMAP_DIR    (default: CSLMapView's folder in the game install)
// Pairs that aren't present are reported as skipped, never as passed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { parseCity, type CityData } from '../src/parse';
import { loadSim, type SimResult } from '../src/sim';
import { readCrp, openSaveData, ASSET_DATA } from '../src/sim/reader';
import { readNet } from '../src/sim/net';
import { readBuildings } from '../src/sim/buildings';
import { readGrids } from '../src/sim/grids';
import { validate } from '../src/sim/validate';

const SAVES = process.env.CS_SAVES_DIR ?? path.join(os.homedir(), 'Library/Application Support/Colossal Order/Cities_Skylines/Saves');
const EXPORTS = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
const WORKSHOP = path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/workshop/content/255710');

let failures = 0, skipped = 0, passed = 0;
const ok = (m: string) => { passed++; console.log('  ✓ ' + m); };
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const skip = (m: string) => { skipped++; console.log('  - skipped: ' + m); };
const check = (cond: boolean, m: string) => (cond ? ok(m) : fail(m));

// exports are stored NFD on macOS; accept either form
const exportFile = (name: string) => { const want = name.normalize('NFC'); const f = existsSync(EXPORTS) ? readdirSync(EXPORTS).find((x) => x.normalize('NFC') === want) : undefined; return f ? path.join(EXPORTS, f) : null; };
const saveFile = (name: string) => { const f = path.join(SAVES, name); return existsSync(f) ? f : null; };
const cities = new Map<string, CityData>();
const city = (f: string) => { if (!cities.has(f)) cities.set(f, parseCity(readFileSync(f, 'utf8'))); return cities.get(f)!; };
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sim = (save: string | Uint8Array, c: CityData): Promise<SimResult> => loadSim(buf(typeof save === 'string' ? new Uint8Array(readFileSync(save)) : save), c, () => {});

const REF_EXPORT = '서랑시-20261107-234707.cslmap', REF_SAVE = '!w_nweg_23%002E0%002E1.crp';

async function main() {
  const refE = exportFile(REF_EXPORT), refS = saveFile(REF_SAVE);
  console.log('\n1. Matching export and save (CSLMapView "Auto export on saving game" pair)');
  if (!refE || !refS) { skip(`${REF_EXPORT} + ${REF_SAVE} not found`); return report(); }
  const c = city(refE);
  const t0 = performance.now();
  const r = await sim(refS, c);
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) { fail('reference pair failed: ' + r.code + ' ' + r.detail); return report(); }
  check(r.v.verdict === 'match', `verdict match (${r.v.verdict}), loaded in ${ms} ms`);
  check(r.v.nodes.verified === r.v.nodes.exported && r.v.segments.verified === r.v.segments.exported && r.v.buildings.verified === r.v.buildings.exported, `every node (${r.v.nodes.exported}), segment (${r.v.segments.exported}) and building (${r.v.buildings.exported}) matched`);
  check(r.unavailable.length === 0, 'every data section read' + (r.unavailable.length ? ': missing ' + r.unavailable.join(', ') : ''));

  // values shown must equal the decoded save, object by object
  const bytes = new Uint8Array(readFileSync(refS));
  const crp = readCrp(bytes); const de = crp.entries.find((e) => e.type === ASSET_DATA)!;
  const sd = openSaveData(bytes.subarray(de.offset, de.offset + de.size));
  const net = readNet(sd), bld = readBuildings(sd);
  let bad = 0;
  for (let i = 0; i < r.traffic!.ids.length; i++) if (net.segTraffic[r.traffic!.ids[i]] !== r.traffic!.pct[i]) bad++;
  check(bad === 0 && r.traffic!.ids.length === r.v.segments.verified, `traffic: ${r.traffic!.ids.length} values equal NetSegment.m_trafficDensity`);
  check(r.city?.population === 204831, `population ${r.city?.population} = save metadata 204,831`);
  const res = r.buildings!.residents.reduce((s, v) => s + Math.max(0, v), 0);
  check(Math.abs(res - 204831) / 204831 < 0.001, `residents in matched buildings ${res} within 0.1% of the city population`);
  check((r.lines?.length ?? 0) === r.v.lines.verified && r.v.lines.verified === r.v.lines.exported, `ridership for all ${r.v.lines.exported} lines`);
  check((r.tmpe?.segs.filter((s) => s.kmh.length).length ?? 0) > 0, `TM:PE speed limits placed on ${r.tmpe?.segs.filter((s) => s.kmh.length).length} matched segments`);

  console.log('\n2. Same bytes under another name / gzipped');
  const again = await sim(bytes, c);
  check(again.ok && again.v.verdict === 'match' && again.traffic!.ids.length === r.traffic!.ids.length, 'identical result from the same bytes (file names and dates are never read)');
  const gz = await sim(new Uint8Array(gzipSync(bytes)), c);
  check(gz.ok && gz.v.verdict === 'match', 'gzipped save gives the same verdict');

  console.log('\n3. Grid alignment');
  const g = readGrids(sd);
  let on = 0, flip = 0, n = 0;
  for (const b of c.buildings) {
    if (!(bld.flags[b.id] & 1)) continue;
    const x = Math.trunc(bld.posX[b.id] / 38.4 + 128), z = Math.trunc(bld.posZ[b.id] / 38.4 + 128);
    if (x < 0 || x > 255 || z < 0 || z > 255) continue;
    on += g.noise[z * 256 + x]; flip += g.noise[(255 - z) * 256 + x]; n++;
  }
  check(on > flip * 2, `noise is higher on buildings than on the same cells mirrored north-south (${(on / n).toFixed(1)} vs ${(flip / n).toFixed(1)}), so rows run along +z`);

  console.log('\n4–5. Export and save from different moments');
  for (const [e, s, want, label] of [
    ['서랑시-20260912-235951.cslmap', REF_SAVE, 'near', 'older export, newer save'],
    [REF_EXPORT, '!w_nweg_22%002E8.crp', 'near', 'newer export, older save'],
    [REF_EXPORT, '!w_nweg_21%002E3.crp', 'incompatible', 'same city, months apart'],
  ] as const) {
    const ef = exportFile(e), sf = saveFile(s);
    if (!ef || !sf) { skip(label); continue; }
    const rr = await sim(sf, city(ef));
    const v = rr.ok ? rr.v : rr.v;
    check(!!v && v.verdict === want, `${label}: ${v?.verdict} (${v?.reason}), worst share ${v ? Math.min(v.share.nodes, v.share.segments, v.share.buildings).toFixed(3) : '?'}`);
    if (rr.ok && rr.traffic) {
      // per-object guard: everything attached is individually verified
      const { m } = validate(city(ef), readNetOf(sf), readBldOf(sf), null);
      check([...rr.traffic.ids].every((id) => m.seg[id] === 1) && [...(rr.buildings?.ids ?? [])].every((id) => m.bld[id] === 1), `${label}: values attached only to matched objects (${rr.traffic.ids.length} roads, ${rr.buildings?.ids.length ?? 0} buildings)`);
    }
  }

  console.log('\n6. A different city');
  const other = saveFile('!u_qudacity_01%002E03.crp');
  if (!other) skip('Quda City save'); else { const rr = await sim(other, c); check(!rr.ok && rr.code === 'incompatible' && rr.v?.reason === 'different-city', `rejected: ${rr.ok ? 'accepted!' : rr.v?.reason}`); }

  console.log('\n7. Missing or malformed data');
  const tr = await sim(bytes.subarray(0, 20_000_000), c);
  check(!tr.ok && tr.code === 'truncated', `truncated save → ${tr.ok ? 'ok?' : tr.code}`);
  const junk = await sim(new TextEncoder().encode('not a save at all'), c);
  check(!junk.ok && junk.code === 'not-crp', `random bytes → ${junk.ok ? 'ok?' : junk.code}`);
  const flipped = bytes.slice(); flipped.fill(0x7f, de.offset + 13_000_000, de.offset + 13_000_400);
  // damaged bytes must never surface as values: the checksum the game stored for the data block catches them
  const fr = await sim(flipped, c);
  check(!fr.ok && fr.code === 'damaged', `400 corrupted bytes in building data → ${fr.ok ? 'accepted!' : fr.code} (the game's MD5 of the data block no longer matches)`);
  const f2 = bytes.slice(); f2[de.offset + 30_000_000] ^= 1; // one flipped bit deep in the vehicle data
  const fr2 = await sim(f2, c);
  check(!fr2.ok && fr2.code === 'damaged', `one flipped bit → ${fr2.ok ? 'accepted!' : fr2.code}`);
  const old = saveFile('20240914_11pm.crp');
  if (!old) skip('format 117013 save'); else { const rr = await sim(old, c); check(!rr.ok && rr.code === 'unsupported-version', `format 117013 → ${rr.ok ? 'ok?' : rr.code}`); }
  const asset = existsSync(path.join(WORKSHOP, '1174471092/Damaged Road.crp')) ? path.join(WORKSHOP, '1174471092/Damaged Road.crp') : null;
  if (!asset) skip('workshop asset .crp'); else { const rr = await sim(asset, c); check(!rr.ok && rr.code === 'not-save', `asset package → ${rr.ok ? 'ok?' : rr.code}`); }

  console.log('\n8. Format 118011 (previous game build) pair');
  const e118 = exportFile('서랑시-20260308-151443.cslmap'), s118 = saveFile('!w_nweg_21%002E2.crp');
  if (!e118 || !s118) skip('118011 pair'); else { const rr = await sim(s118, city(e118)); check(rr.ok && rr.v.verdict === 'match' && rr.unavailable.length === 0, `118011 pair: ${rr.ok ? rr.v.verdict + (rr.unavailable.length ? ', missing ' + rr.unavailable.join(', ') : '') : rr.code}`); }
  report();
}

function readSd(f: string) { const b = new Uint8Array(readFileSync(f)); const e = readCrp(b).entries.find((x) => x.type === ASSET_DATA)!; return openSaveData(b.subarray(e.offset, e.offset + e.size)); }
const readNetOf = (f: string) => readNet(readSd(f));
const readBldOf = (f: string) => readBuildings(readSd(f));

function report() {
  console.log(`\nsim: ${passed} passed, ${failures} failed, ${skipped} skipped`);
  if (failures) process.exit(1);
}

await main();
