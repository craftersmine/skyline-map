// City Discoveries: records and oddities read straight from the export. Every number here is measured from
// the export's own geometry, terrain or line data (lengths, heights, counts); nothing is estimated from game
// mechanics the export doesn't carry (no traffic, passengers, schedules or building heights). A record that
// can't be established cleanly is left out rather than guessed.
import type { CityData, CSeg } from './parse';
import type { BuiltCity } from './build';
import { makeTerrainSampler, modeOf } from './build';
import { HALF, MAP_SIZE, toLngLat, fromLngLat, polylineLength, type XY } from './geo';

export type DiscoveryCat = 'transit' | 'roads' | 'land' | 'buildings' | 'quirks';
type GeoFeature = { type: 'Feature'; properties: { role: 'line' | 'area' | 'point' | 'pin' }; geometry: { type: string; coordinates: unknown } };

export interface Discovery {
  id: string;
  cat: DiscoveryCat;
  /** icon key (see discover-ui) */
  icon: string;
  /** i18n key */
  title: string;
  /** the headline number, already formatted, and its unit key */
  value: string;
  unit: string;
  /** what holds the record: a name from the city, or an i18n key when `subjectKey` */
  subject: string;
  subjectKey?: boolean;
  /** nearest named district, park or station, for context ("near …"); empty when far from any */
  place?: string;
  /** one-sentence context: i18n key + params (params are names or formatted numbers) */
  note: string;
  params: Record<string, string>;
  /** colour hint (a line's colour) */
  color?: string;
  geom: GeoFeature[];
  /** lng/lat bbox to frame */
  bbox: [number, number, number, number];
}

export interface DiscoveryResult {
  city: string;
  summary: { roadKm: number; railKm: number; lines: number; stations: number; buildings: number; bridges: number; tunnels: number };
  items: Discovery[];
}

// ------------------------------------------------------------------ formatting
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
export function fmtLen(m: number): [string, string] {
  if (m < 1000) return [n0(m), 'm'];
  return [(m / 1000).toFixed(m < 10000 ? 2 : 1), 'km'];
}
const lenText = (m: number) => fmtLen(m).join(' ');

// ------------------------------------------------------------------ geometry helpers
const ll = (p: XY) => toLngLat(p[0], p[1]);
const segXY = (s: CSeg): XY[] => s.pts.map((p) => [p.x, p.z]);
function bboxOf(pts: XY[], pad = 60): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of pts) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
  const sw = toLngLat(a - pad, b - pad), ne = toLngLat(c + pad, d + pad);
  return [sw[0], sw[1], ne[0], ne[1]];
}
const lineF = (pts: XY[]): GeoFeature => ({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: pts.map(ll) } });
const pinF = (p: XY, role: 'pin' | 'point' = 'pin'): GeoFeature => ({ type: 'Feature', properties: { role }, geometry: { type: 'Point', coordinates: ll(p) } });
const areaF = (ring: XY[]): GeoFeature => ({ type: 'Feature', properties: { role: 'area' }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]].map(ll)] } });

/** Leaving direction of a segment at one of its ends, from a point ~25 m along it. */
function leaving(s: CSeg, atStart: boolean): XY {
  const p = atStart ? s.pts : [...s.pts].reverse();
  const a = p[0];
  let b = p[p.length - 1];
  for (const q of p) if (Math.hypot(q.x - a.x, q.z - a.z) >= 25) { b = q; break; }
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
  return [dx / d, dz / d];
}

/**
 * Chains of segments joined end to end. At each node the two segments that continue most nearly straight
 * are paired, if their turn is under `maxTurn` degrees and `ok` agrees; others end there. Returns each
 * chain as ordered segments with their orientation.
 */
function chains(segs: CSeg[], maxTurn: number, ok: (a: CSeg, b: CSeg) => boolean = () => true) {
  const byNode = new Map<number, { s: number; start: boolean }[]>();
  segs.forEach((s, i) => { for (const [n, start] of [[s.sn, true], [s.en, false]] as [number, boolean][]) { const l = byNode.get(n) ?? []; l.push({ s: i, start }); byNode.set(n, l); } });
  const partner = new Map<string, { s: number; start: boolean }>();
  const key = (s: number, start: boolean) => s + (start ? 'a' : 'b');
  const cos = Math.cos(((180 - maxTurn) * Math.PI) / 180);
  for (const ends of byNode.values()) {
    if (ends.length < 2) continue;
    const pairs: { i: number; j: number; c: number }[] = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].s === ends[j].s) continue;
      const a = leaving(segs[ends[i].s], ends[i].start), b = leaving(segs[ends[j].s], ends[j].start);
      const c = a[0] * b[0] + a[1] * b[1]; // -1 = straight on
      if (c <= cos && ok(segs[ends[i].s], segs[ends[j].s])) pairs.push({ i, j, c });
    }
    pairs.sort((p, q) => p.c - q.c);
    const used = new Set<number>();
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue;
      used.add(p.i); used.add(p.j);
      partner.set(key(ends[p.i].s, ends[p.i].start), ends[p.j]);
      partner.set(key(ends[p.j].s, ends[p.j].start), ends[p.i]);
    }
  }
  const seen = new Uint8Array(segs.length);
  const out: { s: CSeg; rev: boolean }[][] = [];
  const walk = (i: number, enterAtStart: boolean) => {
    const chain: { s: CSeg; rev: boolean }[] = [];
    let cur: { s: number; start: boolean } | undefined = { s: i, start: enterAtStart };
    while (cur && !seen[cur.s]) {
      seen[cur.s] = 1;
      chain.push({ s: segs[cur.s], rev: !cur.start });
      cur = partner.get(key(cur.s, !cur.start)); // leave by the other end
    }
    return chain;
  };
  // start at free ends first, then whatever is left (closed loops)
  segs.forEach((_, i) => { if (seen[i]) return; if (!partner.has(key(i, true))) out.push(walk(i, true)); else if (!partner.has(key(i, false))) out.push(walk(i, false)); });
  segs.forEach((_, i) => { if (!seen[i]) out.push(walk(i, true)); });
  return out;
}
const chainPts = (c: { s: CSeg; rev: boolean }[]): XY[] => {
  const out: XY[] = [];
  for (const { s, rev } of c) { const p = segXY(s); if (rev) p.reverse(); out.push(...(out.length ? p.slice(1) : p)); }
  return out;
};

export function discover(city: CityData, built: BuiltCity): DiscoveryResult {
  const T = makeTerrainSampler(city);
  const sea = city.seaLevel;
  const items: Discovery[] = [];
  const segById = new Map(city.segs.map((s) => [s.id, s]));
  const segLen = new Map<number, number>();
  const lenOf = (id: number) => { let v = segLen.get(id); if (v === undefined) { const s = segById.get(id); v = s ? polylineLength(segXY(s)) : 0; segLen.set(id, v); } return v; };
  type P = Record<string, any>;
  const roadProps = new Map<number, P>();
  for (const f of built.sources.roads.features) roadProps.set(f.properties.id as number, f.properties);
  const railProps = new Map<number, P>();
  for (const f of built.sources.rails.features) if (f.properties.type !== undefined) railProps.set(f.properties.id as number, f.properties);
  const isRoad = (p: P | undefined) => !!p && p.lanes > 0 && !['runway', 'taxiway', 'pedestrian', 'footway', 'trail', 'canal', 'ferry'].includes(p.cls);
  const roadSegs = city.segs.filter((s) => isRoad(roadProps.get(s.id)) && s.pts.length >= 2);
  const railSegs = city.segs.filter((s) => { const p = railProps.get(s.id); return p && ['rail', 'subway', 'monorail', 'tram'].includes(p.cls) && s.pts.length >= 2; });

  // named places, for "near …" context
  const named: { name: string; x: number; z: number; w: number; kind: string }[] = [];
  for (const f of built.sources.places.features) {
    const p = f.properties; if (!p.name || !['district', 'park', 'station'].includes(String(p.kind))) continue;
    const [x, z] = fromLngLat(...((f.geometry as any).coordinates as XY));
    const nm = String(p.name).trim(); if (nm) named.push({ name: nm, x, z, w: p.kind === 'district' ? 1.4 : 1, kind: String(p.kind) });
  }
  const near = (x: number, z: number, max = 1800, areasOnly = false) => {
    let best = '', bd = max;
    for (const q of named) { if (areasOnly && q.kind === 'station') continue; const d = Math.hypot(q.x - x, q.z - z) / q.w; if (d < bd) { bd = d; best = q.name; } }
    return best;
  };
  // every record gets its nearest named area for context, unless that would just repeat the subject
  const push = (d: Omit<Discovery, 'params'> & { params?: Record<string, string> }) => {
    if (d.place === undefined) {
      const f = d.geom.find((g) => g.properties.role === 'pin') ?? d.geom[0];
      const c = f ? (f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.type === 'LineString' ? (f.geometry.coordinates as XY[])[(f.geometry.coordinates as XY[]).length >> 1] : (f.geometry.coordinates as XY[][])[0][0]) as XY : null;
      const p = c ? fromLngLat(c[0], c[1]) : null;
      // only for records at one spot: a 15 km line or 6 crossings around the map aren't "near" anything
      const [w, so, e, n] = d.bbox, sw = fromLngLat(w, so), ne = fromLngLat(e, n);
      const spot = Math.hypot(ne[0] - sw[0], ne[1] - sw[1]) < 3500 && d.geom.filter((g) => g.properties.role === 'point').length <= 2;
      d.place = p && spot ? near(p[0], p[1], 1500, true) : '';
      if (d.place && !d.subjectKey && d.subject.includes(d.place)) d.place = '';
    }
    items.push({ params: {}, ...d });
  };
  const roadName = (s: CSeg) => s.customName || '';

  // ================================================================= transit
  const lineById = new Map(built.meta.lines.map((l) => [l.id, l]));
  const routeSegs = new Map<string, number[]>();
  for (const s of city.segs) if (s.path) routeSegs.set(s.sn + ',' + s.en, s.path);
  const stopName = built.stopNames ?? new Map<number, string>();
  const lineInfo = city.transports.filter((tr) => tr.stops.length >= 2 && lineById.has(tr.id)).map((tr) => {
    const mode = modeOf(tr.type), hops: { a: number; b: number; ids: number[]; len: number }[] = [], all = new Set<number>();
    for (let i = 0; i < tr.stops.length; i++) {
      const a = tr.stops[i], b = tr.stops[(i + 1) % tr.stops.length];
      const ids = [...new Set(routeSegs.get(a + ',' + b) ?? [])];
      ids.forEach((id) => all.add(id));
      hops.push({ a, b, ids, len: ids.reduce((s, id) => s + lenOf(id), 0) });
    }
    const len = [...all].reduce((s, id) => s + lenOf(id), 0);
    return { tr, mode, hops, ids: [...all], len, line: lineById.get(tr.id)! };
  }).filter((l) => l.len > 0);
  const lineGeom = (ids: number[]) => ids.map((id) => segById.get(id)).filter((s): s is CSeg => !!s && s.pts.length >= 2).map((s) => lineF(segXY(s)));
  const lineBox = (ids: number[]) => bboxOf(ids.flatMap((id) => { const s = segById.get(id); return s ? segXY(s) : []; }));
  const MODE_TITLES: Record<string, string> = { train: 'Longest railway line', metro: 'Longest metro line', tram: 'Longest tram line', monorail: 'Longest monorail line', bus: 'Longest bus route', ferry: 'Longest ferry route', cablecar: 'Longest cable car' };
  // i18n-keys
  void ['Longest railway line', 'Longest metro line', 'Longest tram line', 'Longest monorail line', 'Longest bus route', 'Longest ferry route', 'Longest cable car',
    '{n} lines of this kind; this one runs {len} end to end, counting each stretch of track once.', 'The only line of its kind, {len} end to end.'];
  // end i18n-keys
  for (const mode of ['train', 'metro', 'monorail', 'tram', 'bus', 'ferry', 'cablecar']) {
    const ls = lineInfo.filter((l) => l.mode === mode);
    if (!ls.length || (mode === 'bus' && ls.length < 3)) continue;
    const best = ls.reduce((a, b) => (b.len > a.len ? b : a));
    if (best.len < 400) continue;
    const [v, u] = fmtLen(best.len);
    push({ id: 'longest-' + mode, cat: 'transit', icon: mode, title: MODE_TITLES[mode], value: v, unit: u, subject: best.tr.name, color: best.line.color,
      note: ls.length > 1 ? '{n} lines of this kind; this one runs {len} end to end, counting each stretch of track once.' : 'The only line of its kind, {len} end to end.',
      params: { n: String(ls.length), len: lenText(best.len) }, geom: lineGeom(best.ids), bbox: lineBox(best.ids) });
  }

  // busiest interchange: the station the most lines stop at (every line counts once)
  {
    const st = built.sources.places.features.filter((f) => f.properties.kind === 'station' && f.properties.name && Number(f.properties.nlines) >= 3)
      .sort((a, b) => Number(b.properties.nlines) - Number(a.properties.nlines));
    if (st.length) {
      const top = st[0], n = Number(top.properties.nlines), ties = st.filter((f) => Number(f.properties.nlines) === n);
      const names = String(top.properties.lines).split(' · ');
      const modes = [...new Set(names.map((nm) => built.meta.lines.find((l) => l.name === nm)?.type).filter(Boolean))] as string[];
      const p = fromLngLat(...((top.geometry as any).coordinates as XY));
      // i18n-keys
      void ['Busiest interchange', '{n} lines stop here: {lines}.', '{n} lines stop here: {lines}. {others} other stations tie with it.'];
      // end i18n-keys
      push({ id: 'interchange', cat: 'transit', icon: modes[0] ?? 'metro', title: 'Busiest interchange', value: String(n), unit: 'lines', subject: String(top.properties.name), color: String(top.properties.color),
        note: ties.length > 1 ? '{n} lines stop here: {lines}. {others} other stations tie with it.' : '{n} lines stop here: {lines}.',
        params: { n: String(n), lines: names.join(', '), others: String(ties.length - 1) }, geom: [pinF(p)], bbox: bboxOf([p], 500) });
    }
  }

  // longest non-stop run and closest stations, between consecutive stops of rail and ferry lines
  {
    const hops = lineInfo.filter((l) => !['bus', 'tour', 'air', 'other'].includes(l.mode))
      .flatMap((l) => l.hops.filter((h) => h.len > 0 && stopName.get(h.a) && stopName.get(h.b) && stopName.get(h.a) !== stopName.get(h.b)).map((h) => ({ ...h, l })));
    if (hops.length >= 3) {
      const far = hops.reduce((a, b) => (b.len > a.len ? b : a));
      const [v, u] = fmtLen(far.len);
      // i18n-keys
      void ['Longest non-stop run', '{line} runs {len} between {a} and {b} without stopping.'];
      // end i18n-keys
      push({ id: 'nonstop', cat: 'transit', icon: far.l.mode, title: 'Longest non-stop run', value: v, unit: u, subject: far.l.tr.name, color: far.l.line.color,
        note: '{line} runs {len} between {a} and {b} without stopping.', params: { line: far.l.tr.name, len: lenText(far.len), a: stopName.get(far.a)!, b: stopName.get(far.b)! },
        geom: [...lineGeom(far.ids), ...[far.a, far.b].map((n) => city.nodes.get(n)).filter(Boolean).map((n) => pinF([n!.x, n!.z], 'point'))], bbox: lineBox(far.ids) });
      const rail = hops.filter((h) => h.l.mode !== 'ferry' && h.l.mode !== 'cablecar');
      if (rail.length >= 3) {
        const close = rail.reduce((a, b) => (b.len < a.len ? b : a));
        const [cv, cu] = fmtLen(close.len);
        // i18n-keys
        void ['Closest stations', '{a} and {b} are only {len} apart on {line}.'];
        // end i18n-keys
        push({ id: 'closest', cat: 'transit', icon: close.l.mode, title: 'Closest stations', value: cv, unit: cu, subject: `${stopName.get(close.a)} – ${stopName.get(close.b)}`, color: close.l.line.color,
          note: '{a} and {b} are only {len} apart on {line}.', params: { line: close.l.tr.name, len: lenText(close.len), a: stopName.get(close.a)!, b: stopName.get(close.b)! },
          geom: [...lineGeom(close.ids), ...[close.a, close.b].map((n) => city.nodes.get(n)).filter(Boolean).map((n) => pinF([n!.x, n!.z], 'point'))], bbox: lineBox(close.ids) });
      }
    }
  }

  // stations by depth and height (stop nodes on the track, against the terrain)
  {
    const stops: { name: string; x: number; z: number; y: number; depth: number; mode: string; line: string; color: string }[] = [];
    for (const l of lineInfo) {
      if (!['train', 'metro', 'monorail', 'tram'].includes(l.mode)) continue;
      for (const id of l.tr.stops) {
        const n = city.nodes.get(id), name = stopName.get(id);
        if (!n || !name) continue;
        stops.push({ name, x: n.x, z: n.z, y: n.y, depth: T.ground(n.x, n.z) - n.y, mode: l.mode, line: l.tr.name, color: l.line.color });
      }
    }
    const deep = stops.filter((s) => s.depth > 8).sort((a, b) => b.depth - a.depth)[0];
    if (deep) {
      // i18n-keys
      void ['Deepest station', 'Platforms lie {d} below the ground above them, on {line}.'];
      // end i18n-keys
      push({ id: 'deep-station', cat: 'transit', icon: deep.mode, title: 'Deepest station', value: n0(deep.depth), unit: 'm below ground', subject: deep.name, color: deep.color,
        note: 'Platforms lie {d} below the ground above them, on {line}.', params: { d: n0(deep.depth) + ' m', line: deep.line }, geom: [pinF([deep.x, deep.z])], bbox: bboxOf([[deep.x, deep.z]], 400) });
    }
    if (stops.length >= 4) {
      const hi = stops.reduce((a, b) => (b.y > a.y ? b : a)), lo = stops.reduce((a, b) => (b.y < a.y ? b : a));
      if (hi.y - lo.y > 15) {
        // i18n-keys
        void ['Highest station', '{h} above sea level, {d} higher than the lowest station, {low}.'];
        // end i18n-keys
        push({ id: 'high-station', cat: 'transit', icon: hi.mode, title: 'Highest station', value: n0(hi.y - sea), unit: 'm above sea', subject: hi.name, color: hi.color,
          note: '{h} above sea level, {d} higher than the lowest station, {low}.', params: { h: n0(hi.y - sea) + ' m', d: n0(hi.y - lo.y) + ' m', low: lo.name }, geom: [pinF([hi.x, hi.z])], bbox: bboxOf([[hi.x, hi.z]], 400) });
      }
    }
  }

  // biggest climb along one line, between its highest and lowest stops
  {
    let best: { l: (typeof lineInfo)[number]; hi: { x: number; z: number; y: number }; lo: { x: number; z: number; y: number } } | null = null;
    for (const l of lineInfo) {
      if (l.mode === 'tour' || l.mode === 'air') continue;
      const ns = l.tr.stops.map((id) => city.nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
      if (ns.length < 2) continue;
      const hi = ns.reduce((a, b) => (b.y > a.y ? b : a)), lo = ns.reduce((a, b) => (b.y < a.y ? b : a));
      if (!best || hi.y - lo.y > best.hi.y - best.lo.y) best = { l, hi, lo };
    }
    if (best && best.hi.y - best.lo.y >= 40) {
      const d = best.hi.y - best.lo.y;
      // i18n-keys
      void ['Biggest climb', 'Between its lowest and highest stops {line} rises {d}.'];
      // end i18n-keys
      push({ id: 'climb', cat: 'transit', icon: best.l.mode, title: 'Biggest climb', value: n0(d), unit: 'm', subject: best.l.tr.name, color: best.l.line.color,
        note: 'Between its lowest and highest stops {line} rises {d}.', params: { line: best.l.tr.name, d: n0(d) + ' m' },
        geom: [...lineGeom(best.l.ids), pinF([best.hi.x, best.hi.z], 'point'), pinF([best.lo.x, best.lo.z], 'point')], bbox: lineBox(best.l.ids) });
    }
  }

  // busiest corridor: the stretch of road or track the most lines share
  {
    const users = new Map<number, Set<number>>();
    for (const l of lineInfo) for (const id of l.ids) { const s = users.get(id) ?? new Set(); s.add(l.tr.id); users.set(id, s); }
    let max = 0; for (const s of users.values()) max = Math.max(max, s.size);
    if (max >= 4) {
      const top = city.segs.filter((s) => (users.get(s.id)?.size ?? 0) === max && s.pts.length >= 2);
      // the longest connected run of those segments
      const runs = chains(top, 90);
      const run = runs.map((c) => ({ c, len: c.reduce((s, x) => s + lenOf(x.s.id), 0) })).reduce((a, b) => (b.len > a.len ? b : a));
      const lineSet = [...users.get(run.c[0].s.id)!].map((id) => lineById.get(id)!.name);
      const nm = run.c.map((x) => roadName(x.s)).find(Boolean) ?? '';
      // i18n-keys
      void ['Busiest corridor', '{n} lines share this {len} stretch: {lines}.', 'Shared track and road'];
      // end i18n-keys
      push({ id: 'corridor', cat: 'transit', icon: 'corridor', title: 'Busiest corridor', value: String(max), unit: 'lines', subject: nm || 'Shared track and road', subjectKey: !nm,
        note: '{n} lines share this {len} stretch: {lines}.', params: { n: String(max), len: lenText(run.len), lines: lineSet.join(', ') }, geom: run.c.map((x) => lineF(segXY(x.s))), bbox: bboxOf(chainPts(run.c), 200) });
    }
  }

  // ================================================================= bridges & tunnels
  const water = (x: number, z: number) => T.surf(x, z) - T.ground(x, z) > 0.5;
  const overWater = (pts: XY[]) => {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i], d = Math.hypot(bx - ax, bz - az), k = Math.max(1, Math.ceil(d / 8));
      for (let j = 0; j < k; j++) { const t = (j + 0.5) / k; if (water(ax + (bx - ax) * t, az + (bz - az) * t)) m += d / k; }
    }
    return m;
  };
  const brunnelOf = (s: CSeg) => (roadProps.get(s.id) ?? railProps.get(s.id))?.brunnel ?? '';
  const isRail = (s: CSeg) => railProps.has(s.id);
  const structs = (kind: 'bridge' | 'tunnel', set: CSeg[]) => chains(set.filter((s) => brunnelOf(s) === kind), 50, (a, b) => isRail(a) === isRail(b))
    .map((c) => {
      const pts = chainPts(c), rail = isRail(c[0].s);
      // a railway structure takes the name of a line that runs through it
      const name = c.map((x) => roadName(x.s)).find(Boolean) ?? (rail ? lineInfo.find((l) => c.some((x) => l.ids.includes(x.s.id)))?.tr.name : '') ?? '';
      return { c, pts, len: polylineLength(pts), rail, name };
    });
  const both = [...roadSegs, ...railSegs];
  const bridges = structs('bridge', both), tunnels = structs('tunnel', both);
  {
    const wet = bridges.map((b) => ({ ...b, wet: overWater(b.pts) })).filter((b) => b.wet >= 40 && b.wet >= b.len * 0.25);
    // i18n-keys
    void ['Longest bridge', 'A continuous {len} span with {w} of it over water.', 'Road bridge', 'Rail bridge', 'Longest viaduct', 'The longest continuous elevated stretch, {len}, mostly over dry land.'];
    // end i18n-keys
    let longestWet: (typeof wet)[number] | null = null;
    if (wet.length) {
      longestWet = wet.reduce((a, b) => (b.len > a.len ? b : a));
      const [v, u] = fmtLen(longestWet.len);
      push({ id: 'bridge', cat: 'roads', icon: 'bridge', title: 'Longest bridge', value: v, unit: u, subject: longestWet.name || (longestWet.rail ? 'Rail bridge' : 'Road bridge'), subjectKey: !longestWet.name,
        note: 'A continuous {len} span with {w} of it over water.', params: { len: lenText(longestWet.len), w: lenText(longestWet.wet) }, geom: [lineF(longestWet.pts)], bbox: bboxOf(longestWet.pts, 150) });
    }
    const dry = bridges.filter((b) => overWater(b.pts) < b.len * 0.25);
    if (dry.length) {
      const v = dry.reduce((a, b) => (b.len > a.len ? b : a));
      if (v.len >= 400 && (!longestWet || v.len > longestWet.len * 0.5)) {
        const [vv, u] = fmtLen(v.len);
        push({ id: 'viaduct', cat: 'roads', icon: 'viaduct', title: 'Longest viaduct', value: vv, unit: u, subject: v.name || (v.rail ? 'Rail bridge' : 'Road bridge'), subjectKey: !v.name,
          note: 'The longest continuous elevated stretch, {len}, mostly over dry land.', params: { len: lenText(v.len) }, geom: [lineF(v.pts)], bbox: bboxOf(v.pts, 150) });
      }
    }
    // i18n-keys
    void ['Longest road tunnel', 'Longest rail tunnel', 'Unbroken underground for {len}.', 'Unbroken underground for {len}, {w} of it under water.', 'Road tunnel', 'Rail tunnel'];
    // end i18n-keys
    for (const rail of [false, true]) {
      const ts = tunnels.filter((x) => x.rail === rail);
      if (!ts.length) continue;
      const tn = ts.reduce((a, b) => (b.len > a.len ? b : a));
      if (tn.len < 300) continue;
      const w = overWater(tn.pts), [v, u] = fmtLen(tn.len);
      const nm = tn.name;
      push({ id: rail ? 'tunnel-rail' : 'tunnel-road', cat: rail ? 'transit' : 'roads', icon: 'tunnel', title: rail ? 'Longest rail tunnel' : 'Longest road tunnel', value: v, unit: u,
        subject: nm || (rail ? 'Rail tunnel' : 'Road tunnel'), subjectKey: !nm, note: w >= 60 ? 'Unbroken underground for {len}, {w} of it under water.' : 'Unbroken underground for {len}.', params: { len: lenText(tn.len), w: lenText(w) },
        geom: [lineF(tn.pts)], bbox: bboxOf(tn.pts, 150) });
    }
  }

  // ================================================================= roads
  // longest street: the longest end-to-end run of one road name
  {
    const byName = new Map<string, CSeg[]>();
    for (const s of roadSegs) if (s.customName) { const l = byName.get(s.customName) ?? []; l.push(s); byName.set(s.customName, l); }
    let best: { name: string; pts: XY[]; len: number } | null = null;
    for (const [name, ss] of byName) for (const c of chains(ss, 75)) { const pts = chainPts(c), len = polylineLength(pts); if (!best || len > best.len) best = { name, pts, len }; }
    if (best && best.len >= 800) {
      const [v, u] = fmtLen(best.len);
      // i18n-keys
      void ['Longest named road', '{name} runs {len} end to end under one name.'];
      // end i18n-keys
      push({ id: 'street', cat: 'roads', icon: 'road', title: 'Longest named road', value: v, unit: u, subject: best.name, note: '{name} runs {len} end to end under one name.', params: { name: best.name, len: lenText(best.len) }, geom: [lineF(best.pts)], bbox: bboxOf(best.pts, 150) });
    }
  }

  // longest straight: a run of road that never bends more than a few metres off its line
  {
    const flat = roadSegs.filter((s) => { const p = segXY(s), a = p[0], b = p[p.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return p.every((q) => Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) / L < 1.5); });
    let best: { pts: XY[]; len: number; name: string } | null = null;
    for (const c of chains(flat, 3)) {
      const pts = chainPts(c);
      // longest window whose points all stay within 4 m of the line between its ends
      let i = 0;
      for (let j = 1; j < pts.length; j++) {
        const within = (a: number, b: number) => { const [ax, az] = pts[a], [bx, bz] = pts[b], L = Math.hypot(bx - ax, bz - az) || 1; for (let k = a + 1; k < b; k++) if (Math.abs((pts[k][0] - ax) * (bz - az) - (pts[k][1] - az) * (bx - ax)) / L > 4) return false; return true; };
        while (i < j - 1 && !within(i, j)) i++;
        const len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
        if (!best || len > best.len) best = { pts: pts.slice(i, j + 1), len, name: c.map((x) => roadName(x.s)).find(Boolean) ?? '' };
      }
    }
    if (best && best.len >= 600) {
      const [v, u] = fmtLen(best.len);
      // i18n-keys
      void ['Longest straight', 'Dead straight for {len}: it never strays more than 4 m off a ruler line.', 'Unnamed road'];
      // end i18n-keys
      push({ id: 'straight', cat: 'roads', icon: 'straight', title: 'Longest straight', value: v, unit: u, subject: best.name || 'Unnamed road', subjectKey: !best.name,
        note: 'Dead straight for {len}: it never strays more than 4 m off a ruler line.', params: { len: lenText(best.len) }, geom: [lineF(best.pts)], bbox: bboxOf(best.pts, 150) });
    }
  }

  // steepest road: grade over runs of at least 60 m on the surface (from the exact node heights)
  {
    let best: { s: CSeg; g: number; len: number } | null = null;
    for (const s of roadSegs) {
      // surface streets only: both ends on the ground, not a slope/elevated variant
      const a = city.nodes.get(s.sn), b = city.nodes.get(s.en);
      if (brunnelOf(s) !== '' || a?.og === false || b?.og === false || /Slope|Elevated|Bridge|Tunnel/i.test(s.name)) continue;
      const len = lenOf(s.id); if (len < 60) continue;
      const g = Math.abs(s.pts[s.pts.length - 1].y - s.pts[0].y) / len;
      if (!best || g > best.g) best = { s, g, len };
    }
    if (best && best.g >= 0.06) {
      const p = segXY(best.s), rise = Math.abs(best.s.pts[best.s.pts.length - 1].y - best.s.pts[0].y);
      // i18n-keys
      void ['Steepest road', 'Climbs {rise} over {len}.'];
      // end i18n-keys
      push({ id: 'steep', cat: 'roads', icon: 'steep', title: 'Steepest road', value: (best.g * 100).toFixed(1), unit: '%', subject: roadName(best.s) || 'Unnamed road', subjectKey: !roadName(best.s),
        note: 'Climbs {rise} over {len}.', params: { rise: n0(rise) + ' m', len: lenText(best.len) }, geom: [lineF(p)], bbox: bboxOf(p, 200) });
    }
  }

  // highest road and the lowest point of the road network
  {
    let hi: { s: CSeg; y: number; p: XY } | null = null, lo: { s: CSeg; y: number; p: XY } | null = null;
    for (const s of roadSegs) for (const q of s.pts) {
      if (!hi || q.y > hi.y) hi = { s, y: q.y, p: [q.x, q.z] };
      if (!lo || q.y < lo.y) lo = { s, y: q.y, p: [q.x, q.z] };
    }
    if (hi && hi.y - sea > 60) {
      // i18n-keys
      void ['Highest road', 'The road network tops out {h} above sea level.'];
      // end i18n-keys
      push({ id: 'high-road', cat: 'roads', icon: 'summit', title: 'Highest road', value: n0(hi.y - sea), unit: 'm above sea', subject: roadName(hi.s) || 'Unnamed road', subjectKey: !roadName(hi.s),
        note: 'The road network tops out {h} above sea level.', params: { h: n0(hi.y - sea) + ' m' }, geom: [lineF(segXY(hi.s)), pinF(hi.p)], bbox: bboxOf([hi.p], 400) });
    }
    if (lo && lo.y < sea - 3) {
      // i18n-keys
      void ['Below the sea', 'This road dips to {d} below sea level.'];
      // end i18n-keys
      push({ id: 'low-road', cat: 'roads', icon: 'tunnel', title: 'Below the sea', value: n0(sea - lo.y), unit: 'm below sea', subject: roadName(lo.s) || 'Unnamed road', subjectKey: !roadName(lo.s),
        note: 'This road dips to {d} below sea level.', params: { d: n0(sea - lo.y) + ' m' }, geom: [lineF(segXY(lo.s)), pinF(lo.p)], bbox: bboxOf([lo.p], 400) });
    }
  }

  // busiest junction: the node where the most roads meet
  {
    const deg = new Map<number, CSeg[]>();
    for (const s of roadSegs) for (const n of [s.sn, s.en]) { const l = deg.get(n) ?? []; l.push(s); deg.set(n, l); }
    let best: [number, CSeg[]] | null = null;
    for (const e of deg) if (!best || e[1].length > best[1].length) best = e;
    const ties = best ? [...deg.values()].filter((l) => l.length === best![1].length).length : 0;
    if (best && (best[1].length >= 6 || (best[1].length === 5 && ties <= 2))) {
      const n = city.nodes.get(best[0])!;
      const names = [...new Set(best[1].map(roadName).filter(Boolean))];
      // i18n-keys
      void ['Busiest junction', '{n} roads meet at one point.', '{n} roads meet at one point: {list}.'];
      // end i18n-keys
      push({ id: 'junction', cat: 'roads', icon: 'junction', title: 'Busiest junction', value: String(best[1].length), unit: 'roads', subject: names[0] ?? near(n.x, n.z, 1200),
        note: names.length ? '{n} roads meet at one point: {list}.' : '{n} roads meet at one point.', params: { n: String(best[1].length), list: names.join(', ') },
        geom: [...best[1].map((s) => lineF(segXY(s))), pinF([n.x, n.z])], bbox: bboxOf([[n.x, n.z]], 160) });
    }
  }

  // widest road: most car and tram lanes across both directions
  {
    // driving lanes only (the game also lists parking lanes as car lanes); toll plazas fan out briefly, skip them
    const drive = (s: CSeg) => (city.segTypes.get(s.name)?.lanes ?? []).filter((l) => /Vehicle/.test(l.type) && /Car|Tram|Bus|Trolley/.test(l.vType)).length;
    let best: CSeg | null = null, bl = 0;
    for (const s of roadSegs) {
      if (roadProps.get(s.id)!.toll || /Toll/i.test(s.name)) continue;
      const l = drive(s); if (l > bl || (l === bl && best && lenOf(s.id) > lenOf(best.id))) { bl = l; best = s; }
    }
    if (best && bl >= 6) {
      const type = best.name;
      const run = chains(roadSegs.filter((s) => s.name === type), 40).find((c) => c.some((x) => x.s.id === best!.id))!;
      const pts = chainPts(run), len = polylineLength(pts);
      // i18n-keys
      void ['Widest road', '{n} lanes side by side, for {len}.'];
      // end i18n-keys
      push({ id: 'wide', cat: 'roads', icon: 'wide', title: 'Widest road', value: String(bl), unit: 'lanes', subject: roadName(best) || type.replace(/_Data$/, '').replace(/^\d+\./, ''),
        note: '{n} lanes side by side, for {len}.', params: { n: String(bl), len: lenText(len) }, geom: [lineF(pts)], bbox: bboxOf(pts, 200) });
    }
  }

  // longest runway
  {
    const rw = city.segs.filter((s) => roadProps.get(s.id)?.cls === 'runway' && s.pts.length >= 2);
    if (rw.length) {
      const c = chains(rw, 5).map((c) => chainPts(c)).reduce((a, b) => (polylineLength(b) > polylineLength(a) ? b : a));
      const len = polylineLength(c);
      if (len >= 300) {
        const [v, u] = fmtLen(len);
        const mid = c[c.length >> 1];
        const ap = city.parks.filter((p) => p.type === 'Airport' && p.name.trim()).map((p) => ({ p, d: Math.hypot(p.x - mid[0], p.z - mid[1]) })).sort((a, b) => a.d - b.d)[0];
        const pl = ap && ap.d < 3000 ? ap.p.name.trim() : '';
        // i18n-keys
        void ['Longest runway', '{len} of runway from end to end.', 'Runway'];
        // end i18n-keys
        push({ id: 'runway', cat: 'roads', icon: 'plane', title: 'Longest runway', value: v, unit: u, subject: pl || 'Runway', subjectKey: !pl, note: '{len} of runway from end to end.', params: { len: lenText(len) }, geom: [lineF(c)], bbox: bboxOf(c, 300) });
      }
    }
  }

  // ================================================================= land & water
  {
    const n = city.terrainSize, cell = MAP_SIZE / (n - 1);
    let hi = -Infinity, hk = 0, lo = Infinity, deep = 0, dk = 0, wet = 0;
    for (let k = 0; k < city.height.length; k++) { const h = city.height[k]; if (h > hi) { hi = h; hk = k; } if (h < lo) lo = h; }
    for (let k = 0; k < city.height.length; k++) {
      // some exports carry saturated water values (~1,020 m) whose surface would float above every mountain: not water
      const h = city.height[k], w = city.water[k];
      if (w > 0.5 && h + w <= hi + 2) { wet++; if (w > deep) { deep = w; dk = k; } }
    }
    const at = (k: number): XY => [(k % n) * cell - HALF, Math.floor(k / n) * cell - HALF];
    const p = at(hk);
    if (hi - sea > 30) {
      const pl = near(p[0], p[1], 3000, true);
      // i18n-keys
      void ['Highest point', 'The summit stands {h} above sea level; {relief} above the lowest ground on the map.', 'Summit'];
      // end i18n-keys
      push({ id: 'summit', cat: 'land', icon: 'summit', title: 'Highest point', value: n0(hi - sea), unit: 'm above sea', subject: 'Summit', subjectKey: true, place: pl,
        note: 'The summit stands {h} above sea level; {relief} above the lowest ground on the map.', params: { h: n0(hi - sea) + ' m', relief: n0(hi - lo) + ' m' }, geom: [pinF(p)], bbox: bboxOf([p], 1200) });
    }
    if (deep > 3) {
      const q = at(dk), pl = near(q[0], q[1], 3000, true);
      // i18n-keys
      void ['Deepest water', 'The water here is {d} deep.', 'Open water'];
      // end i18n-keys
      push({ id: 'deep-water', cat: 'land', icon: 'water', title: 'Deepest water', value: n0(deep), unit: 'm deep', subject: 'Open water', subjectKey: true, place: pl,
        note: 'The water here is {d} deep.', params: { d: n0(deep) + ' m' }, geom: [pinF(q)], bbox: bboxOf([q], 1500) });
    }
    const share = wet / city.height.length;
    if (share >= 0.02) {
      // i18n-keys
      void ['Water world', 'Water coverage', '{p} of the map is under water.', 'The whole map'];
      // end i18n-keys
      push({ id: 'water-share', cat: 'land', icon: 'wave', title: share >= 0.5 ? 'Water world' : 'Water coverage', place: '', value: String(Math.round(share * 100)), unit: '%', subject: 'The whole map', subjectKey: true,
        note: '{p} of the map is under water.', params: { p: Math.round(share * 100) + '%' }, geom: [], bbox: [...toLngLat(-HALF, -HALF), ...toLngLat(HALF, HALF)] as [number, number, number, number] });
    }
  }

  // ================================================================= buildings
  {
    type Lot = { id: number; grp: number; name: string; asset: string; cat: string; area: number; part: number; named: number; ring: XY[]; cx: number; cz: number; y: number };
    const byId = new Map(city.buildings.map((b) => [b.id, b]));
    const lots: Lot[] = [];
    for (const f of built.sources.lots.features) {
      const p = f.properties, b = byId.get(p.id as number);
      if (!b || b.pts.length < 3) continue;
      const ring: XY[] = b.pts.map((q) => [q.x, q.z]);
      lots.push({ id: b.id, grp: (p.grp as number) ?? b.id, name: String(p.name), asset: String(p.asset), cat: String(p.cat), area: Number(p.area), part: Number(p.part), named: Number(p.named), ring,
        cx: ring.reduce((s, q) => s + q[0], 0) / ring.length, cz: ring.reduce((s, q) => s + q[1], 0) / ring.length, y: b.pts[0].y });
    }
    const FLAT = new Set(['apron', 'plaza', 'utility_open']);
    const solid = lots.filter((l) => !FLAT.has(l.cat));
    // biggest footprint: a whole asset (all its parts)
    const groups = new Map<number, Lot[]>();
    for (const l of solid) { const g = groups.get(l.grp) ?? []; g.push(l); groups.set(l.grp, g); }
    if (groups.size) {
      const [, big] = [...groups].map(([g, ls]) => [g, ls] as const).reduce((a, b) => (b[1].reduce((s, l) => s + l.area, 0) > a[1].reduce((s, l) => s + l.area, 0) ? b : a));
      const area = big.reduce((s, l) => s + l.area, 0), head = big.find((l) => !l.part) ?? big[0];
      // i18n-keys
      void ['Biggest footprint', 'Covers {a} of ground, about {f} football pitches.'];
      // end i18n-keys
      push({ id: 'footprint', cat: 'buildings', icon: 'building', title: 'Biggest footprint', value: area >= 1e5 ? (area / 1e4).toFixed(1) : n0(area), unit: area >= 1e5 ? 'ha' : 'm²', subject: head.name,
        note: 'Covers {a} of ground, about {f} football pitches.', params: { a: n0(area) + ' m²', f: (area / 7140).toFixed(1) }, geom: big.map((l) => areaF(l.ring)), bbox: bboxOf(big.flatMap((l) => l.ring), 120) });
      const [, most] = [...groups].reduce((a, b) => (b[1].length > a[1].length ? b : a));
      if (most.length >= 8) {
        const h = most.find((l) => !l.part) ?? most[0];
        // i18n-keys
        void ['Most complex building', '{n} separate pieces in the export, linked as one asset.'];
        // end i18n-keys
        push({ id: 'parts', cat: 'buildings', icon: 'parts', title: 'Most complex building', value: String(most.length), unit: 'parts', subject: h.name,
          note: '{n} separate pieces in the export, linked as one asset.', params: { n: String(most.length) }, geom: most.map((l) => areaF(l.ring)), bbox: bboxOf(most.flatMap((l) => l.ring), 120) });
      }
    }
    // most-built asset among the growable zones
    {
      const ZONED = /^(residential|residential_high|commercial|office|industrial)$/;
      const count = new Map<string, Lot[]>();
      for (const l of solid) if (!l.part && ZONED.test(l.cat) && l.asset.length > 2) { const c = count.get(l.asset) ?? []; c.push(l); count.set(l.asset, c); }
      const top = [...count].sort((a, b) => b[1].length - a[1].length)[0];
      if (top && top[1].length >= 12) {
        const all = solid.filter((l) => !l.part).length;
        // i18n-keys
        void ['Most-built asset', '{n} copies across the city: 1 in every {k} buildings.'];
        // end i18n-keys
        push({ id: 'common', cat: 'buildings', icon: 'copies', title: 'Most-built asset', value: n0(top[1].length), unit: 'copies', subject: top[0].replace(/^[HL]\d+ \d+x\d+ /, ''),
          note: '{n} copies across the city: 1 in every {k} buildings.', params: { n: n0(top[1].length), k: String(Math.round(all / top[1].length)) }, geom: top[1].map((l) => areaF(l.ring)), bbox: bboxOf(top[1].flatMap((l) => l.ring), 200) });
      }
    }
    // highest-lying and loneliest buildings (whole assets, not their parts)
    const heads = solid.filter((l) => !l.part && l.area >= 40);
    const lonelyOk = (l: Lot) => l.cat !== 'utility' && !/Toll Booth/i.test(l.asset);
    if (heads.length) {
      const hi = heads.reduce((a, b) => (b.y > a.y ? b : a));
      if (hi.y - sea > 60) {
        // i18n-keys
        void ['Highest building', 'Built {h} above sea level, higher than any other building in the city.'];
        // end i18n-keys
        push({ id: 'high-building', cat: 'buildings', icon: 'summit', title: 'Highest building', value: n0(hi.y - sea), unit: 'm above sea', subject: hi.name,
          note: 'Built {h} above sea level, higher than any other building in the city.', params: { h: n0(hi.y - sea) + ' m' }, geom: [areaF(hi.ring), pinF([hi.cx, hi.cz])], bbox: bboxOf(hi.ring, 300) });
      }
      // loneliest: farthest from its nearest neighbouring building (grid hash, 500 m cells)
      if (heads.length >= 20) {
        const C = 500, grid = new Map<string, Lot[]>();
        for (const l of solid) { const k = Math.floor(l.cx / C) + ',' + Math.floor(l.cz / C); const g = grid.get(k) ?? []; g.push(l); grid.set(k, g); }
        let best: { l: Lot; d: number; o: Lot } | null = null;
        for (const l of heads.filter(lonelyOk)) {
          let d = Infinity, o: Lot | null = null;
          const gi = Math.floor(l.cx / C), gj = Math.floor(l.cz / C);
          // rings of cells outward; stop once the next ring can't hold anything closer
          for (let r = 0; r <= 8 && !(d <= r * C - C); r++) for (let i = gi - r; i <= gi + r; i++) for (let j = gj - r; j <= gj + r; j++) {
            if (Math.max(Math.abs(i - gi), Math.abs(j - gj)) !== r) continue;
            for (const q of grid.get(i + ',' + j) ?? []) { if (q.grp === l.grp) continue; const dd = Math.hypot(q.cx - l.cx, q.cz - l.cz); if (dd < d) { d = dd; o = q; } }
          }
          if (o && (!best || d > best.d)) best = { l, d, o };
        }
        if (best && best.d >= 400) {
          const [v, u] = fmtLen(best.d);
          // i18n-keys
          void ['Loneliest building', 'Its nearest neighbour, {other}, is {d} away.'];
          // end i18n-keys
          push({ id: 'lonely', cat: 'buildings', icon: 'lonely', title: 'Loneliest building', value: v, unit: u, subject: best.l.name,
            note: 'Its nearest neighbour, {other}, is {d} away.', params: { other: best.o.name, d: lenText(best.d) }, geom: [areaF(best.l.ring), pinF([best.l.cx, best.l.cz]), lineF([[best.l.cx, best.l.cz], [best.o.cx, best.o.cz]])], bbox: bboxOf([[best.l.cx, best.l.cz], [best.o.cx, best.o.cz]], 250) });
        }
      }
    }
  }

  // ================================================================= quirks
  // level crossings: a railway and a road meeting at one node, both on the ground
  {
    const railAt = new Set<number>(), roadAt = new Set<number>();
    for (const s of railSegs) if (railProps.get(s.id)!.cls === 'rail' && brunnelOf(s) === '') { railAt.add(s.sn); railAt.add(s.en); }
    for (const s of roadSegs) if (brunnelOf(s) === '') { roadAt.add(s.sn); roadAt.add(s.en); }
    const xs = [...railAt].filter((n) => roadAt.has(n)).map((n) => city.nodes.get(n)!).filter(Boolean);
    if (xs.length) {
      // i18n-keys
      void ['Across the city', 'Level crossings', 'Road and railway cross on the level at {n} places: no bridge, no tunnel.', 'Road and railway cross on the level here: no bridge, no tunnel.'];
      // end i18n-keys
      const pts = xs.map((n): XY => [n.x, n.z]);
      push({ id: 'crossings', cat: 'quirks', icon: 'crossing', title: 'Level crossings', value: String(xs.length), unit: xs.length === 1 ? 'place' : 'places', subject: xs.length === 1 ? near(xs[0].x, xs[0].z) || 'Across the city' : 'Across the city', subjectKey: xs.length > 1 || !near(xs[0].x, xs[0].z),
        note: xs.length === 1 ? 'Road and railway cross on the level here: no bridge, no tunnel.' : 'Road and railway cross on the level at {n} places: no bridge, no tunnel.', params: { n: String(xs.length) },
        geom: pts.map((p) => pinF(p, 'point')), bbox: bboxOf(pts, 300) });
    }
  }

  // road islands: stretches of road with no connection to the main network
  {
    const parent = new Map<number, number>();
    const find = (a: number): number => { let r = a; while (parent.get(r)! !== r) r = parent.get(r)!; let x = a; while (x !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; } return r; };
    const net = city.segs.filter((s) => roadProps.has(s.id) && (roadProps.get(s.id)!.lanes > 0) && s.pts.length >= 2);
    for (const s of net) for (const n of [s.sn, s.en]) if (!parent.has(n)) parent.set(n, n);
    for (const s of net) { const a = find(s.sn), b = find(s.en); if (a !== b) parent.set(a, b); }
    const comp = new Map<number, CSeg[]>();
    for (const s of net) { const r = find(s.sn); const l = comp.get(r) ?? []; l.push(s); comp.set(r, l); }
    const sized = [...comp.values()].map((ss) => ({ ss, len: ss.reduce((a, s) => a + lenOf(s.id), 0) })).sort((a, b) => b.len - a.len);
    // only islands with real roads (not a stub inside an asset): at least 300 m of road
    const islands = sized.slice(1).filter((c) => c.len >= 300);
    if (sized.length > 1 && islands.length) {
      const top = islands[0];
      const pts = top.ss.flatMap(segXY);
      // i18n-keys
      void ['Road islands', '{n} stretches of road ({len} in all) have no road link to the rest of the city.', 'This {len} stretch of road has no road link to the rest of the city.'];
      // end i18n-keys
      push({ id: 'islands', cat: 'quirks', icon: 'island', title: 'Road islands', value: String(islands.length), unit: islands.length === 1 ? 'island' : 'islands', subject: islands.length > 1 ? 'Across the city' : top.ss.map(roadName).find(Boolean) || near(pts[0][0], pts[0][1]) || 'Across the city', subjectKey: islands.length > 1 || !(top.ss.map(roadName).find(Boolean) || near(pts[0][0], pts[0][1])),
        note: islands.length === 1 ? 'This {len} stretch of road has no road link to the rest of the city.' : '{n} stretches of road ({len} in all) have no road link to the rest of the city.',
        params: { n: String(islands.length), len: lenText(islands.length === 1 ? top.len : islands.reduce((s, c) => s + c.len, 0)) },
        geom: islands.flatMap((c) => c.ss.map((s) => lineF(segXY(s)))), bbox: bboxOf(islands.flatMap((c) => c.ss.flatMap(segXY)), 200) });
    }
  }

  // ghost stations: a named station building no line stops near
  {
    const stops: XY[] = [];
    for (const tr of city.transports) { const m = modeOf(tr.type); if (m === 'bus' || m === 'tour' || m === 'air') continue; for (const id of tr.stops) { const n = city.nodes.get(id); if (n) stops.push([n.x, n.z]); } }
    const ghosts = built.sources.places.features.filter((f) => f.properties.kind === 'station' && f.properties.name && !Number(f.properties.nlines)).map((f) => ({ name: String(f.properties.name), p: fromLngLat(...((f.geometry as any).coordinates as XY)) as XY }))
      .filter((g) => stops.every((s) => Math.hypot(s[0] - g.p[0], s[1] - g.p[1]) > 350));
    if (ghosts.length) {
      // i18n-keys
      void ['Ghost stations', 'Named and built, but no line stops here: {list}.', 'Named and built, but no line stops here.'];
      // end i18n-keys
      push({ id: 'ghost', cat: 'quirks', icon: 'ghost', title: 'Ghost stations', value: String(ghosts.length), unit: ghosts.length === 1 ? 'station' : 'stations', subject: ghosts[0].name,
        note: ghosts.length === 1 ? 'Named and built, but no line stops here.' : 'Named and built, but no line stops here: {list}.', params: { list: ghosts.map((g) => g.name).join(', ') },
        geom: ghosts.map((g) => pinF(g.p, 'point')), bbox: bboxOf(ghosts.map((g) => g.p), 400) });
    }
  }

  // longest name anywhere on the map
  {
    const names = new Set<string>();
    for (const f of built.sources.places.features) if (f.properties.name && ['district', 'park', 'station'].includes(String(f.properties.kind))) names.add(String(f.properties.name).trim());
    // buildings only when the player named them (asset names like "District Cultural Center" aren't the city's)
    for (const b of city.buildings) if (b.myname) names.add(b.myname);
    for (const s of city.segs) if (s.customName) names.add(s.customName);
    for (const tr of city.transports) if (tr.name) names.add(tr.name);
    const len = (s: string) => [...s].length;
    const top = [...names].sort((a, b) => len(b) - len(a))[0];
    if (top && len(top) >= 12) {
      const s = built.search.find((e) => e.name === top);
      if (s) {
        const [x, z] = fromLngLat(...s.center);
        // i18n-keys
        void ['Longest name', '{n} characters long. Good luck fitting it on a sign.'];
        // end i18n-keys
        push({ id: 'name', cat: 'quirks', icon: 'sign', title: 'Longest name', value: String(len(top)), unit: 'characters', subject: top, note: '{n} characters long. Good luck fitting it on a sign.', params: { n: String(len(top)) },
          geom: [pinF([x, z])], bbox: s.bbox ?? bboxOf([[x, z]], 500) });
      }
    }
  }

  // ================================================================= summary
  const km = (segs: CSeg[]) => segs.reduce((s, x) => s + lenOf(x.id), 0) / 1000;
  return {
    city: city.name,
    summary: {
      roadKm: Math.round(km(roadSegs)), railKm: Math.round(km(railSegs.filter((s) => railProps.get(s.id)!.cls !== 'tram'))),
      lines: lineInfo.length, stations: built.sources.places.features.filter((f) => f.properties.kind === 'station').length,
      buildings: built.sources.lots.features.filter((f) => !f.properties.part).length,
      bridges: bridges.filter((b) => b.len >= 50).length, tunnels: tunnels.filter((b) => b.len >= 50).length,
    },
    items,
  };
}
