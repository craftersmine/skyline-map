// Multi-part assets (`prntb`/`subb`) and the on-ground flag (`og`), checked against the real exports.
//  - every sub-building chain resolves to a head (no dangling ids, no cycles)
//  - stops: which station they belong to, old rule (main-building centre) vs footprint rule
//  - parts: how many are drawn as their asset, skipped as overlays
//  - roads/paths/rails: bridges and tunnels with `og` vs the height test alone
//  - walking to an asset ends at its nearest edge: never slower than aiming at its centre, never unreachable when that was
//   npm run check:groups [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity, type CityData } from '../src/parse';
import { buildCity, buildingGroups } from '../src/build';
import { Router } from '../src/router';
import { fromLngLat } from '../src/geo';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };

/** Station name per stop under the previous rule: the nearest named station building's own centre. */
function oldStopNames(city: CityData) {
  const ns: { name: string; x: number; z: number; rail: boolean; ferry: boolean; mode: string }[] = [];
  for (const b of city.buildings) {
    if (b.parent || !b.myname || b.srv !== 'PublicTransport' || b.pts.length < 3) continue;
    const t = b.subsrv + ' ' + b.icls + ' ' + b.name;
    if (/Taxi|Depot|Hangar|Fuel|Cargo|Lounge|Pit|Pillar|pylon|Entrance Sub/i.test(b.name) || /Cargo/i.test(b.icls)) continue;
    const mode = /Metro|Monorail|Train/i.test(t) ? 'rail' : /Tram/i.test(t) ? 'tram' : /Ship|Ferry/i.test(t) ? 'ferry' : /CableCar/i.test(t) ? 'cablecar' : '';
    if (!mode) continue;
    ns.push({ name: b.myname, x: b.pts.reduce((s, p) => s + p.x, 0) / b.pts.length, z: b.pts.reduce((s, p) => s + p.z, 0) / b.pts.length, rail: mode === 'rail', ferry: mode === 'ferry', mode });
  }
  const out = new Map<number, string>();
  for (const tr of city.transports) {
    const m = tr.type.toLowerCase();
    const fam = /metro|train|monorail/.test(m) ? 'rail' : /tram/.test(m) ? 'tram' : /ship|ferry/.test(m) ? 'ferry' : /cable/.test(m) ? 'cablecar' : '';
    if (!fam) continue;
    for (const sid of tr.stops) {
      const n = city.nodes.get(sid); if (!n) continue;
      let best = '', bd = fam === 'ferry' ? 220 : 150;
      for (const s of ns) { if (s.mode !== fam) continue; const d = Math.hypot(s.x - n.x, s.z - n.z); if (d < bd) { bd = d; best = s.name; } }
      if (best) out.set(sid, best);
    }
  }
  return out;
}

const brunnels = (b: ReturnType<typeof buildCity>) => {
  const c = { bridge: 0, tunnel: 0, ground: 0 };
  for (const f of [...b.sources.roads.features, ...b.sources.rails.features]) c[(f.properties.brunnel || 'ground') as keyof typeof c]++;
  return c;
};

for (const f of files) {
  const name = path.basename(f).normalize('NFC');
  const city = parseCity(readFileSync(f, 'utf8'));
  // chains
  const ids = new Set(city.buildings.map((b) => b.id));
  const dangling = city.buildings.filter((b) => (b.parent && !ids.has(b.parent)) || (b.sub && !ids.has(b.sub))).length;
  const groups = buildingGroups(city.buildings);
  const linked = city.buildings.filter((b) => b.parent).length;
  const byId = new Map(city.buildings.map((b) => [b.id, b]));
  let depth = 0;
  for (const b of city.buildings) { let d = 0, r = b; while (r.parent && byId.has(r.parent) && d < 1000) { r = byId.get(r.parent)!; d++; } depth = Math.max(depth, d); }
  const ogKnown = [...city.nodes.values()].some((n) => n.og !== null);
  console.log(`\n${name}: ${linked} parts in ${new Set(groups.values()).size} assets (deepest chain ${depth}), og ${ogKnown ? 'present' : 'absent'}`);
  if (dangling) fail(`${dangling} sub-building links point at missing buildings`);
  if (groups.size !== linked) fail(`${linked - groups.size} parts did not resolve to a head (cycle?)`);
  // a head never resolves to something else, a part never to itself
  for (const [p, h] of groups) if (groups.has(h) || p === h) { fail(`part ${p} resolves to non-head ${h}`); break; }

  const built = buildCity(city);
  const st = built.meta.stats;
  console.log(`  parts drawn ${st['bld:part'] ?? 0}; buildings skipped ${st['bld:skipped'] ?? 0}`);
  // stations
  const oldN = oldStopNames(city), newN = built.stopNames ?? new Map();
  let gained = 0, lost = 0, moved = 0;
  const notes: string[] = [];
  for (const sid of new Set([...oldN.keys(), ...newN.keys()])) {
    const a = oldN.get(sid), b = newN.get(sid);
    if (a === b) continue;
    if (!a) { gained++; notes.push(`+ stop ${sid}: ${b}`); } else if (!b) { lost++; notes.push(`- stop ${sid}: was ${a}`); } else { moved++; notes.push(`~ stop ${sid}: ${a} → ${b}`); }
  }
  console.log(`  stops named: ${oldN.size} → ${newN.size} (${gained} gained, ${lost} lost, ${moved} renamed)`);
  for (const n of notes.slice(0, 12)) console.log('    ' + n);
  if (lost > Math.max(2, oldN.size * 0.02)) fail(`${lost} stops lost their station name`);
  // walking to assets: from 4 sides, 400 m out, edge-aware ends vs the asset's centre point
  {
    const r = new Router(city, built.stopNames ?? new Map());
    const assets = (r as any).assets.slice();
    let n = 0, faster = 0, slower = 0, lostRoute = 0;
    for (const h of [...new Set(groups.values())].slice(0, 60)) {
      const hb = byId.get(h)!; if (hb.pts.length < 3) continue;
      const c: [number, number] = [hb.pts.reduce((s, p) => s + p.x, 0) / hb.pts.length, hb.pts.reduce((s, p) => s + p.z, 0) / hb.pts.length];
      for (let k = 0; k < 4; k++) {
        const from: [number, number] = [c[0] + Math.cos(k * Math.PI / 2 + 0.4) * 400, c[1] + Math.sin(k * Math.PI / 2 + 0.4) * 400];
        (r as any).assets = []; const o = r.route(from, c, 'walk')[0];
        (r as any).assets = assets; const w = r.route(from, c, 'walk')[0];
        if (o && !w) lostRoute++;
        if (!o || !w) continue;
        // a centre-aimed route may end with a long straight line across the asset (the shortcut the edge
        // rule removes, or start with one from open ground); only compare against ones whose links are is a real step off the path
        const link = (c: number[][]) => { const [p, q] = c.map(([lng, lat]) => fromLngLat(lng, lat)); return q ? Math.hypot(q[0] - p[0], q[1] - p[1]) : 0; };
        const cutAcross = link(o.legs.at(-1)!.coords.slice(-2)) > 60 || link(o.legs[0].coords.slice(0, 2)) > 60;
        n++; if (w.time < o.time - 5) faster++; else if (w.time > o.time + 5 && !cutAcross) { slower++; if (process.env.DBG) console.log('    slower', hb.id, hb.name.slice(0, 30), from.map(Math.round), c.map(Math.round), 'old', o.time.toFixed(0), 'new', w.time.toFixed(0)); }
      }
    }
    console.log(`  walks to assets: ${n}, ${faster} quicker at the nearest edge, ${slower} slower, ${lostRoute} lost`);
    if (slower || lostRoute) fail(`asset-edge walking: ${slower} slower, ${lostRoute} lost`);
  }
  // grade separation
  const withOg = brunnels(built);
  if (ogKnown) {
    for (const n of city.nodes.values()) n.og = null;
    const without = brunnels(buildCity(city));
    console.log(`  bridges ${without.bridge} → ${withOg.bridge}, tunnels ${without.tunnel} → ${withOg.tunnel} with og (at grade ${without.ground} → ${withOg.ground})`);
    if (withOg.bridge > without.bridge || withOg.tunnel > without.tunnel) fail('og should only ever return pieces to grade');
  }
}
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall group/og checks passed');
