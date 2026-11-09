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
import { readCrp, openSaveData, ASSET_DATA, section, type SaveData } from '../src/sim/reader';
import { readNet } from '../src/sim/net';
import { readBuildings } from '../src/sim/buildings';
import { readGrids } from '../src/sim/grids';
import { validate } from '../src/sim/validate';
import { buildRules } from '../src/sim/rules';
import { readTmpe } from '../src/sim/tmpe';
import { Router } from '../src/router';
import { trafficFactor } from '../src/sim/traffic';
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
    // Phase 2: lane arrows / connections. Bans must agree with the game: no citizen car trip the game routed makes one
    // (except as its first turn, where TM:PE relaxes arrows), and they must never make a reachable trip unreachable.
    const trips = carTripPaths(sd), segOf = new Map(c.segs.map((x) => [x.id, x]));
    const banSet = new Set(rules.turnBan.map((b) => b.from + ':' + b.node + ':' + b.to));
    let moves = 0, against = 0;
    for (const { segs: t } of trips) for (let i = 2; i < t.length; i++) {
      const a = segOf.get(t[i - 1]), b = segOf.get(t[i]); if (!a || !b) continue;
      const n = [a.sn, a.en].find((x) => x === b.sn || x === b.en); if (n === undefined) continue;
      moves++; if (banSet.has(a.id + ':' + n + ':' + b.id)) against++;
    }
    check(rules.turnBan.length > 0 && against === 0 && moves > 100000, `lane-arrow/connection turn bans (${rules.turnBan.length}) agree with ${trips.length} car trips the game routed (${moves} turns, ${against} against a ban)`);
    // U-turns: a trip that turns back along a segment shows two positions on it in lanes of opposite direction. At a
    // trip's start and end the game places the car on a lane beside the building, so only mid-trip turns count.
    const uBan = new Set(rules.uturnBan.map((u) => u.seg + ':' + u.node));
    const arrive = (sid: number, lane: number) => {
      const x = segOf.get(sid), l = x && c.segTypes.get(x.name)?.lanes[lane]; if (!x || !l || l.type !== 'Vehicle') return null;
      const d = (net.segFlags[sid] & 16) ? (l.dir === 'Forward' ? 'Backward' : l.dir === 'Backward' ? 'Forward' : l.dir) : l.dir;
      return d === 'Forward' ? x.en : d === 'Backward' ? x.sn : null;
    };
    let uturns = 0, uAgainst = 0;
    for (const { pos } of trips) {
      const veh = pos.map(([sg, l]) => arrive(sg, l) !== null), first = veh.indexOf(true), last = veh.lastIndexOf(true);
      for (let i = first + 2; i < last; i++) {
        const [s1, l1] = pos[i - 1], [s2, l2] = pos[i]; if (s1 !== s2 || l1 === l2) continue;
        const n1 = arrive(s1, l1), n2 = arrive(s2, l2); if (n1 === null || n2 === null || n1 === n2) continue;
        uturns++; if (uBan.has(s1 + ':' + n1)) uAgainst++;
      }
    }
    check(uturns > 20 && uAgainst === 0, `U-turn bans agree with car trips: ${uturns} mid-trip U-turns the game routed, ${uAgainst} at a banned segment end`);
    const noTurns = new Router(c, built.stopNames ?? new Map(), ow, tolls); noTurns.applyRules({ ...rules, turnBan: [] });
    let lost = 0, turnChanged = 0;
    for (const [p, q] of ends) {
      const a = noTurns.route(p, q, 'drive')[0], b = ruled.route(p, q, 'drive')[0];
      if (a && !b) lost++;
      if (a && b && a.dist !== b.dist) turnChanged++;
    }
    check(lost === 0, `turn bans never make a reachable trip unreachable (${ends.length} drives; ${turnChanged} take another way)`);
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

  console.log('\n3c. Traffic-aware routing (estimate from the save\'s densities)');
  {
    const f = Array.from({ length: 101 }, (_, d) => trafficFactor(d));
    check(f[0] === 1 && f.every((v, i) => v >= 1 && v <= 3.57 && (i === 0 || v >= f[i - 1])) && trafficFactor(NaN) === 1, `density → time factor is ≥ 1, capped, non-decreasing (1 at 0–5 %, ${f[50].toFixed(2)} at 50 %, ${f[80].toFixed(2)} at 80 %, ${f[100].toFixed(2)} at 100 %)`);
    const rules = buildRules(c, net, validate(c, net, bld, null).m.seg, readTmpe(sd.modData), sd.leftHandTraffic);
    const ow = inferOneWay(c), tolls = detectTolls(c), built = buildCity(c, undefined, ow, tolls);
    const mk = () => { const x = new Router(c, built.stopNames ?? new Map(), ow, tolls); x.applyRules(rules); return x; };
    const base = mk(), tr = mk();
    tr.applyTraffic(r.traffic!.ids, r.traffic!.pct);
    const edges = (tr as any).edges as { id: number; tf?: number; acc: { drive: boolean }; pts: [number, number][] }[];
    const verified = new Set(r.traffic!.ids);
    check(edges.every((e) => e.tf === undefined || (verified.has(e.id) && e.acc.drive)), `traffic factors only on matched drivable roads (${edges.filter((e) => e.tf !== undefined).length} roads)`);
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const drivable = edges.filter((e) => e.acc.drive);
    const ends: [number, number][][] = [];
    for (let k = 0; k < 120; k++) { const a = drivable[Math.floor(rnd() * drivable.length)], b = drivable[Math.floor(rnd() * drivable.length)]; ends.push([a.pts[a.pts.length >> 1], b.pts[b.pts.length >> 1]]); }
    // switched off (the default), nothing changes
    let offSame = 0;
    for (const [p, q] of ends.slice(0, 40)) if (JSON.stringify(base.route(p, q, 'drive')) === JSON.stringify(tr.route(p, q, 'drive'))) offSame++;
    check(offSame === 40, `traffic loaded but switched off: drive routes identical (${offSame}/40)`);
    tr.setTraffic(true);
    // switched on: never faster than without; the comparison time is the same route without traffic; rules still hold
    let found = 0, slower = 0, pathChanged = 0, badCmp = 0, faster = 0, illegal = 0;
    const nodeOf = (tr as any).nodeIdx as Map<number, number>;
    const uBan = new Set(rules.uturnBan.map((u) => u.seg + ':' + nodeOf.get(u.node))), tBan = new Set(rules.turnBan.map((b) => b.from + ':' + nodeOf.get(b.node) + ':' + b.to));
    for (const [p, q] of ends) {
      const a = base.route(p, q, 'drive')[0], b = tr.route(p, q, 'drive')[0];
      if (!a || !b) { if (!!a !== !!b) illegal++; continue; }
      found++;
      if (b.baseTime === undefined || b.trafficShare === undefined || b.time < b.baseTime - 1e-6) badCmp++;
      // the traffic route can't beat the best route without traffic, up to the search's own access costing (joining
      // a road farther out counts double while searching, once in the shown time)
      if (b.baseTime! < a.time - Math.max(15, 0.03 * a.time)) faster++;
      if (b.time > a.time + 30) slower++;
      const same = JSON.stringify(a.legs.map((l) => l.coords)) === JSON.stringify(b.legs.map((l) => l.coords));
      if (!same) pathChanged++;
      else if (Math.abs(b.baseTime! - a.time) > 1e-6) badCmp++;
      const path = ((tr as any).driveRoute(p, q, new Map()) as { path: { e: number; fwd: boolean }[] } | null)?.path ?? [];
      path.forEach((st, i) => {
        const e = (tr as any).edges[st.e], o = rules.oneway.get(e.id), prev = path[i - 1];
        if (o !== undefined && (st.fwd ? 1 : -1) !== o) illegal++;
        if (prev && prev.e === st.e && uBan.has(e.id + ':' + (prev.fwd ? e.b : e.a))) illegal++;
        if (prev && i > 1 && prev.e !== st.e && tBan.has((tr as any).edges[prev.e].id + ':' + (prev.fwd ? (tr as any).edges[prev.e].b : (tr as any).edges[prev.e].a) + ':' + e.id)) illegal++;
      });
    }
    check(found > 100 && badCmp === 0 && faster === 0, `traffic on: ${found} drives; the without-traffic time is the same route's, never better than the best route without traffic`);
    check(illegal === 0, 'traffic never overrides a rule: no one-way, U-turn or lane-arrow ban broken, no trip lost or gained');
    check(slower > 0 && pathChanged > 0, `traffic changes ETAs and paths: ${slower} drives at least 30 s slower, ${pathChanged} take another way`);
    // other modes are untouched
    let other = 0;
    for (const [p, q] of ends.slice(0, 12)) for (const m of ['walk', 'bike', 'transit'] as const) if (JSON.stringify(base.route(p, q, m)) === JSON.stringify(tr.route(p, q, m))) other++;
    check(other === 36, `walking, cycling and transit unchanged with traffic on (${other}/36)`);
    // reach follows the same switch: every node is reached no sooner than without traffic
    let early = 0, reachCmp = 0;
    for (const [p] of ends.slice(0, 8)) {
      const a = base.reachTimes(p, 'drive', 1800), b = tr.reachTimes(p, 'drive', 1800);
      for (let i = 0; i < a.length; i++) { if (b[i] < a[i] - 1e-6) early++; if (Number.isFinite(b[i])) reachCmp++; }
    }
    check(early === 0 && reachCmp > 1000, `reach with traffic: no node reached sooner than without (${reachCmp} node times)`);
    tr.setTraffic(false);
    let restored = 0;
    for (const [p, q] of ends.slice(0, 30)) if (JSON.stringify(base.route(p, q, 'drive')) === JSON.stringify(tr.route(p, q, 'drive'))) restored++;
    tr.setTraffic(true); tr.clearTraffic();
    for (const [p, q] of ends.slice(30, 45)) if (JSON.stringify(base.route(p, q, 'drive')) === JSON.stringify(tr.route(p, q, 'drive'))) restored++;
    check(restored === 45, `switching traffic off, or removing it, restores the routes exactly (${restored}/45)`);
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

/** Citizens' car trips from the save's PathManager (lane types Vehicle+Pedestrian, vehicle type Car): segment sequences.
 *  These paths come from TM:PE's own pathfinder, which makes private cars obey lane arrows (CustomPathFind). */
function carTripPaths(sd: SaveData): { segs: number[]; pos: [number, number][] }[] {
  const sec = section(sd, 'PathManager')!; const s = sec.s;
  const N = 262144, sim = s.eaU16(N - 1);
  const units = new Map<number, { lt: number; vt: number; next: number; pos: [number, number][] }>();
  for (let i = 1; i < N; i++) {
    if (!sim[i - 1]) continue;
    s.u8(); const lt = s.u8(), vt = s.u32(), pc = s.u8(), next = s.u24(); s.u32(); s.f32(); s.u8();
    const pos: [number, number][] = []; for (let k = 0; k < pc; k++) { const seg = s.u16(); s.u8(); pos.push([seg, s.u8()]); }
    units.set(i, { lt, vt, next, pos });
  }
  const isNext = new Set([...units.values()].map((u) => u.next));
  const out: { segs: number[]; pos: [number, number][] }[] = [];
  for (const [id, u] of units) {
    if (isNext.has(id) || (u.lt & 3) !== 3 || !(u.vt & 1)) continue; // trip heads only
    const pos: [number, number][] = []; const seen = new Set<number>();
    for (let x: number | undefined = id; x && !seen.has(x); x = units.get(x)?.next) { seen.add(x); pos.push(...(units.get(x)?.pos ?? [])); }
    const segs = pos.map((p) => p[0]);
    out.push({ segs: segs.filter((v, k) => k === 0 || v !== segs[k - 1]), pos });
  }
  return out;
}

function readSd(f: string) { const b = new Uint8Array(readFileSync(f)); const e = readCrp(b).entries.find((x) => x.type === ASSET_DATA)!; return openSaveData(b.subarray(e.offset, e.offset + e.size)); }
const readNetOf = (f: string) => readNet(readSd(f));
const readBldOf = (f: string) => readBuildings(readSd(f));

function report() {
  console.log(`\nsim: ${passed} passed, ${failures} failed, ${skipped} skipped`);
  if (failures) process.exit(1);
}

await main();
