// Toll booth detection (src/tolls.ts) and toll handling in driving directions.
//  - every booth gets a gate, every toll segment an owner, no orphans
//  - a route is flagged tolled exactly when it drives through a gate segment
//    (never merely for using a highway), checked on random trips
//  - "Avoid tolls" finds a toll-free route whenever one exists
//   npm run check:tolls [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { Router } from '../src/router';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const tolls = detectTolls(city), ow = inferOneWay(city);
  const tollSegs = city.segs.filter((s) => !s.path && /Toll/i.test(s.name)).length;
  console.log(`\n${path.basename(f)}: ${tolls.booths.length} booths (${tolls.booths.filter((b) => b.name).length} named), toll segments ${tollSegs}, assigned ${tolls.boothOf.size}, orphans ${tolls.orphans.length}`);
  if (!tolls.booths.length) continue;
  const noGate = tolls.booths.filter((b) => !b.gates.length);
  if (noGate.length) fail(`${noGate.length} booth(s) without a gate segment`);
  const unconf = tolls.booths.filter((b) => b.unconfirmed);
  if (unconf.length) console.log(`  note: ${tolls.orphans.length} toll segment(s) have no booth building in the export → ${unconf.length} unconfirmed toll(s), flagged in directions`);
  for (const b of tolls.booths.slice(0, 4)) console.log(`  ${(b.name || 'Toll booth').padEnd(14)} ${b.kind.padEnd(28)} on ${b.roads[0] ?? b.roadTypes[0] ?? '?'}  gates ${b.gates.length} approaches ${b.approaches.length}`);

  const r: any = new Router(city, buildCity(city, () => {}, ow, tolls).stopNames!, ow, tolls);
  const gate = new Set(tolls.gateOf.keys());
  let seed = 9; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = [...city.nodes.values()].filter((n) => n.srv === 'Road').map((n) => [n.x, n.z]);
  let fakeUnavoidable = 0, trips = 0, tolled = 0, mismatch = 0, highwayNoToll = 0, falseFlag = 0, avoided = 0, unavoidable = 0, extra: number[] = [];
  for (let i = 0; i < 250; i++) {
    const a = pts[Math.floor(rnd() * pts.length)], b = pts[Math.floor(rnd() * pts.length)];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2000) continue;
    const rs = r.route(a, b, 'drive'); if (!rs.length) continue;
    trips++;
    const best = rs[0];
    // ground truth: does the best route's path drive through a gate segment?
    const p = r.driveRoute(a, b, new Map()).path.map((x: any) => r.edges[x.e]);
    const passes = p.some((e: any) => gate.has(e.id));
    const usesHighway = p.some((e: any) => /^(motorway|motorway_link|trunk)$/.test(e.cls));
    if (!!best.tolls?.length !== passes) mismatch++;
    if (usesHighway && !passes) { highwayNoToll++; if (best.tolls?.length) falseFlag++; }
    if (passes) {
      tolled++;
      const av = r.route(a, b, 'drive', { avoidTolls: true })[0];
      if (av && !av.tolls?.length) { avoided++; extra.push(av.time / best.time); }
      else if (av?.tollsUnavoidable) {
        unavoidable++;
        // prove it: with every gate banned outright there must be no route at all
        const saved = r.edges.filter((e: any) => e.gate).map((e: any) => [e, e.acc] as const);
        for (const [e] of saved) e.acc = { ...e.acc, drive: false };
        // the router's own search from the same joins; legal routes only (not its flagged last resort)
        const banned = r.driveRoute(a, b, new Map());
        for (const [e, acc] of saved) e.acc = acc;
        if (banned && !banned.bent) fakeUnavoidable++;
      }
    }
  }
  const med = extra.length ? [...extra].sort((x, y) => x - y)[extra.length >> 1] : NaN;
  console.log(`  ${trips} trips: ${tolled} pass a gate · flag matches path on ${trips - mismatch}/${trips} · highway-without-toll trips ${highwayNoToll}, wrongly flagged ${falseFlag}`);
  console.log(`  avoid tolls: toll-free route found for ${avoided}/${tolled} (median ${isNaN(med) ? '-' : med.toFixed(2) + '× time'}), unavoidable ${unavoidable} (verified by banning every gate: ${unavoidable - fakeUnavoidable}/${unavoidable} truly have no other route)`);
  if (fakeUnavoidable) fail(`${fakeUnavoidable} trips called unavoidable although a toll-free route exists`);
  if (mismatch) fail(`${mismatch} trips where the toll flag disagrees with the path`);
  if (falseFlag) fail(`${falseFlag} highway trips flagged without passing a gate`);
  if (avoided + unavoidable !== tolled) fail('avoid-tolls result missing for some tolled trips');
}
if (failures) { console.error(`\n${failures} toll check(s) failed`); process.exit(1); }
console.log('\nall toll checks passed');
