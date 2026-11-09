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
import { buildRules } from '../src/sim/rules';
import { readTmpe } from '../src/sim/tmpe';
import { Router } from '../src/router';
import { buildCity } from '../src/build';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';

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

  console.log('\n3b. Routing rules from the save');
  {
    const rules = buildRules(c, net, validate(c, net, bld, null).m.seg, readTmpe(sd.modData), sd.leftHandTraffic);
    check(rules.summary.oneway > 1000 && rules.summary.speed > 50 && rules.summary.carRestrict > 0 && rules.summary.track > 0, `rules built: ${JSON.stringify(rules.summary)}`);
    const ow = inferOneWay(c), tolls = detectTolls(c), built = buildCity(c, undefined, ow, tolls);
    const plain = new Router(c, built.stopNames ?? new Map(), ow, tolls);
    const ruled = new Router(c, built.stopNames ?? new Map(), ow, tolls);
    ruled.applyRules(rules);
    const edges = (ruled as any).edges as { id: number; a: number; b: number; ow: number; confirmed: boolean; pts: [number, number][]; acc: { drive: boolean }; noCar?: [boolean, boolean] }[];
    check(edges.every((e) => !rules.oneway.has(e.id) || (e.ow === rules.oneway.get(e.id) && e.confirmed)), `every matched one-way edge follows the save's exact direction (${rules.oneway.size})`);
    // export-only inference: evidence from transit vehicles must agree with the save (walking tours aren't evidence)
    const truthBad = [...ow.truth].filter(([id, d]) => rules.oneway.has(id) && rules.oneway.get(id) !== d).length;
    const confirmedBad = [...ow.dir].filter(([id, d]) => ow.source.get(id) === 'transit' && rules.oneway.has(id) && rules.oneway.get(id) !== d).length;
    check(truthBad === 0 && confirmedBad === 0, `export-only one-ways: every transit-backed direction agrees with the save (${ow.truth.size} votes, ${truthBad} wrong; ${confirmedBad} wrong "confirmed" segments)`);
    let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const drivable = edges.filter((e) => e.acc.drive);
    const ends: [number, number][][] = [];
    for (let k = 0; k < 150; k++) { const a = drivable[Math.floor(rnd() * drivable.length)], b = drivable[Math.floor(rnd() * drivable.length)]; ends.push([a.pts[a.pts.length >> 1], b.pts[b.pts.length >> 1]]); }
    // legality: no edge against the exact direction, no car-banned direction, no banned U-turn
    let illegal = 0, changed = 0, found = 0;
    const nodeOf = (ruled as any).nodeIdx as Map<number, number>;
    const bans = new Set(rules.uturnBan.map((u) => u.seg + ':' + nodeOf.get(u.node)));
    for (const [p, q] of ends) {
      const r = (ruled as any).driveRoute(p, q, new Map()) as { path: { e: number; fwd: boolean }[]; bent?: boolean } | null;
      if (!r) continue;
      found++;
      r.path.forEach((st, i) => {
        const e = edges[st.e], o = rules.oneway.get(e.id);
        if (o !== undefined && (st.fwd ? 1 : -1) !== o) illegal++;
        if (e.noCar?.[st.fwd ? 0 : 1]) illegal++;
        const prev = r.path[i - 1];
        if (prev && prev.e === st.e && bans.has(e.id + ':' + (prev.fwd ? e.b : e.a))) illegal++;
      });
      const a = plain.route(p, q, 'drive')[0], b = ruled.route(p, q, 'drive')[0];
      if (a && b && (Math.abs(a.time - b.time) > 0.5 || a.dist !== b.dist)) changed++;
    }
    check(illegal === 0 && found > 100, `${found} drives with the save's rules break none of them (${changed} differ from the export-only router)`);
    // the toggle and clearing restore today's behaviour exactly
    let same = 0, sameOff = 0;
    const ruled2 = new Router(c, built.stopNames ?? new Map(), ow, tolls); ruled2.applyRules(rules);
    for (const [p, q] of ends.slice(0, 40)) {
      const a = JSON.stringify(plain.route(p, q, 'drive'));
      if (a === JSON.stringify(ruled2.route(p, q, 'drive', { rules: false }))) sameOff++;
    }
    ruled2.clearRules();
    for (const [p, q] of ends.slice(0, 40)) if (JSON.stringify(plain.route(p, q, 'drive')) === JSON.stringify(ruled2.route(p, q, 'drive'))) same++;
    check(sameOff === 40, `"rules off" gives exactly the export-only routes (${sameOff}/40)`);
    check(same === 40, `clearing the rules restores exactly the export-only routes (${same}/40)`);
    const metro = ((ruled as any).lines as { mode: string; hops: { time: number }[] }[]).filter((l) => l.mode === 'metro');
    const metroPlain = ((plain as any).lines as { mode: string; hops: { time: number }[] }[]).filter((l) => l.mode === 'metro');
    const tR = metro.reduce((s, l) => s + l.hops.reduce((a, h) => a + h.time, 0), 0), tP = metroPlain.reduce((s, l) => s + l.hops.reduce((a, h) => a + h.time, 0), 0);
    check(rules.summary.track > 0 ? tR > tP : true, `metro ride times follow TM:PE's track limits: ${Math.round(tP)} s → ${Math.round(tR)} s over all metro hops`);
    // TM:PE options decide what applies (this save: speed limits, restrictions and junction rules on; U-turns off; aggression High)
    const tm = readTmpe(sd.modData)!;
    check(!!tm.options && tm.options.customSpeedLimits && tm.options.vehicleRestrictions && tm.options.junctionRestrictions && !tm.options.allowUTurns && tm.options.restrictionsAggression === 2, `TM:PE options read from the save: ${JSON.stringify(tm.options)}`);
    check(rules.restrictFactor === 1000 && !rules.summary.restrictBan, 'High aggression: restricted car lanes cost ×1000 (TM:PE PATHFIND_PENALTIES), not a ban');
    const noSpeed = buildRules(c, net, validate(c, net, bld, null).m.seg, { ...tm, options: { ...tm.options!, customSpeedLimits: false, vehicleRestrictions: false } }, false);
    check(noSpeed.speed.size === 0 && noSpeed.trackLimit.size === 0 && noSpeed.carRestrict.size === 0, 'with TM:PE speed limits and restrictions switched off in the save, none are applied');
    const noOpts = buildRules(c, net, validate(c, net, bld, null).m.seg, { ...tm, options: null }, false);
    check(noOpts.speed.size === 0 && noOpts.uturnBan.length === 0 && noOpts.carRestrict.size === 0 && noOpts.oneway.size === rules.oneway.size, 'unknown TM:PE options: no TM:PE rule applied (exact one-ways still are)');
    // reported drive times never include the restriction penalty
    let inflated = 0;
    for (const [p, q] of ends.slice(0, 60)) {
      const r = (ruled as any).driveRoute(p, q, new Map()) as { path: { e: number; fwd: boolean }[]; time: number } | null;
      if (r && r.path.some((st) => edges[st.e].noCar?.[st.fwd ? 0 : 1]) && r.time > 1e5) inflated++;
    }
    check(inflated === 0, 'reported times never include the ×1000 restriction penalty');
    check(rules.summary.uturnBan > 0, `U-turns banned where TM:PE forbids them: ${rules.summary.uturnBan} segment ends`);
    // clearing restores reach and transit exactly too
    const ruled3 = new Router(c, built.stopNames ?? new Map(), ow, tolls); ruled3.applyRules(rules); ruled3.clearRules();
    let reachSame = 0, transitSame = 0;
    for (const [p, q] of ends.slice(0, 15)) {
      const a = plain.reachTimes(p, 'drive', 1800), b = ruled3.reachTimes(p, 'drive', 1800);
      if (a.length === b.length && a.every((v, i) => v === b[i])) reachSame++;
      if (JSON.stringify(plain.route(p, q, 'transit')) === JSON.stringify(ruled3.route(p, q, 'transit'))) transitSame++;
    }
    check(reachSame === 15 && transitSame === 15, `after clearing, reach (${reachSame}/15) and transit routes (${transitSame}/15) equal the export-only router`);
  }

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
      // per-object guard: everything attached is individually verified, rules included
      const { m } = validate(city(ef), readNetOf(sf), readBldOf(sf), null);
      const sdx = readSd(sf), rl = buildRules(city(ef), readNet(sdx), m.seg, readTmpe(sdx.modData), sdx.leftHandTraffic);
      const ruleSegs = [...rl.oneway.keys(), ...rl.speed.keys(), ...rl.carRestrict.keys(), ...rl.trackLimit.keys(), ...rl.uturnBan.map((u) => u.seg)];
      check(ruleSegs.every((id) => m.seg[id] === 1), `${label}: routing rules only on matched segments (${new Set(ruleSegs).size} segments)`);
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
