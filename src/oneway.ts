// Recovers the driving direction of one-way segments.
//
// The export lists one-way lanes as "Forward" relative to each segment's own
// start→end, but omits the game's per-segment Invert flag, so the raw value is
// only 64–78% right. We rebuild it from evidence that is in the file:
//  1. Junction rules link segments into groups whose directions are locked
//     together (validated 399/399 on transit ground truth):
//     - where exactly two one-way pieces meet, traffic enters one and leaves the other;
//     - at a merge/diverge Y, the two branches share a direction, the trunk is opposite.
//  2. Each group is then oriented by the strongest evidence it contains:
//     transit routes (vehicles really drove it) > keep-right rule on divided
//     roads (~95%/segment, majority per group) > the raw lane value.
// See `npm run check:oneway` for the accuracy test against transit routes.
import type { CityData, CSeg } from './parse';

export type OneWaySource = 'transit' | 'keepright' | 'prior';
export interface OneWayResult {
  /** +1: travel goes start→end node, -1: end→start. Only one-way segments are present. */
  dir: Map<number, 1 | -1>;
  source: Map<number, OneWaySource>;
  /** direction vehicles were seen driving each one-way segment (transit paths) */
  truth: Map<number, 1 | -1>;
  stats: { oneway: number; groups: number; conflicts: number; bySource: Record<OneWaySource, number> };
}

type P = [number, number];
const vehicle = (vType: string) => /Car|Train|Metro|Tram|Monorail/.test(vType);

export function inferOneWay(city: CityData, opts: { hideTruth?: Set<number> } = {}): OneWayResult {
  const { nodes, segs } = city;
  const byId = new Map(segs.map((s) => [s.id, s]));
  // vehicle segments and their one-way kind (+1 lanes Forward, -1 lanes Backward)
  const veh = new Map<number, CSeg>();
  const kind = new Map<number, 1 | -1>();
  for (const s of segs) {
    if (s.path || s.pts.length < 2 || !nodes.has(s.sn) || !nodes.has(s.en)) continue;
    const lanes = (city.segTypes.get(s.name)?.lanes ?? []).filter((l) => vehicle(l.vType));
    if (!lanes.length) continue;
    veh.set(s.id, s);
    const dirs = new Set(lanes.map((l) => l.dir));
    if ([...dirs].every((d) => d === 'Forward' || d === 'AvoidBackward')) kind.set(s.id, 1);
    else if ([...dirs].every((d) => d === 'Backward' || d === 'AvoidForward')) kind.set(s.id, -1);
  }
  const ow = [...kind.keys()];

  // ---- ground truth from transit paths (ordered segment lists vehicles drove)
  const votes = new Map<number, number>();
  for (const p of segs) {
    if (!p.path) continue;
    const seq = p.path.filter((id, i) => (i === 0 || id !== p.path![i - 1]) && byId.has(id));
    const stop = nodes.get(p.sn);
    seq.forEach((id, k) => {
      const s = byId.get(id)!;
      let end: number | undefined;
      const shared = (o: CSeg) => [s.sn, s.en].filter((n) => n === o.sn || n === o.en);
      if (k + 1 < seq.length) { const sh = shared(byId.get(seq[k + 1])!); if (sh.length === 1) end = sh[0]; }
      else if (k > 0) { const sh = shared(byId.get(seq[k - 1])!); if (sh.length === 1) end = sh[0] === s.sn ? s.en : s.sn; }
      else if (stop) { const a = nodes.get(s.sn)!, b = nodes.get(s.en)!; end = Math.hypot(a.x - stop.x, a.z - stop.z) < Math.hypot(b.x - stop.x, b.z - stop.z) ? s.en : s.sn; }
      if (end !== undefined && kind.has(id)) votes.set(id, (votes.get(id) ?? 0) + (end === s.en ? 1 : -1));
    });
  }
  const truth = new Map<number, 1 | -1>();
  for (const [id, v] of votes) if (v !== 0) truth.set(id, v > 0 ? 1 : -1);

  // ---- junction constraints
  const at = new Map<number, number[]>();
  for (const s of veh.values()) for (const n of [s.sn, s.en]) { const l = at.get(n); if (l) l.push(s.id); else at.set(n, [s.id]); }
  const A = (id: number, n: number) => (byId.get(id)!.sn === n ? 1 : -1); // dir*A = +1 ⇔ traffic leaves node n
  const leave = (id: number, n: number) => {
    const s = byId.get(id)!; const p = s.sn === n ? s.pts : [...s.pts].reverse();
    let q = p[p.length - 1];
    for (const r of p.slice(1)) if (Math.hypot(r.x - p[0].x, r.z - p[0].z) > 12) { q = r; break; }
    return Math.atan2(q.z - p[0].z, q.x - p[0].x);
  };
  const ang = (a: number, b: number) => { const d = Math.abs(a - b) % (2 * Math.PI); return (Math.min(d, 2 * Math.PI - d) * 180) / Math.PI; };
  // parity union-find: dir[i] = rel[i] * dir[root]
  const parent = new Map<number, number>(), rel = new Map<number, number>();
  for (const id of ow) { parent.set(id, id); rel.set(id, 1); }
  const find = (i: number): [number, number] => {
    let r = i, k = 1;
    const chain: number[] = [];
    while (parent.get(r) !== r) { chain.push(r); k *= rel.get(r)!; r = parent.get(r)!; }
    // path compression
    let acc = k;
    for (const c of chain) { const ck = rel.get(c)!; parent.set(c, r); rel.set(c, acc); acc *= ck; }
    return [r, k];
  };
  let conflicts = 0;
  const link = (s1: number, n1: number, s2: number, n2: number, same: boolean) => {
    const need = A(s1, n1) * A(s2, n2) * (same ? 1 : -1); // dir1 = need * dir2
    const [r1, k1] = find(s1), [r2, k2] = find(s2);
    if (r1 === r2) { if (k1 !== need * k2) conflicts++; return; }
    parent.set(r1, r2); rel.set(r1, need * k2 * k1);
  };
  for (const [n, inc] of at) {
    if (!inc.every((i) => kind.has(i))) continue;
    if (inc.length === 2 && inc[0] !== inc[1]) link(inc[0], n, inc[1], n, false);
    else if (inc.length === 3) {
      const h = new Map(inc.map((i) => [i, leave(i, n)]));
      const pairs = ([[0, 1], [0, 2], [1, 2]] as const).map(([x, y]) => ({ a: inc[x], b: inc[y], d: ang(h.get(inc[x])!, h.get(inc[y])!) })).sort((p, q) => p.d - q.d);
      const { a, b, d } = pairs[0];
      const lone = inc.find((x) => x !== a && x !== b)!;
      if (d < 50 && ang(h.get(lone)!, h.get(a)!) > 120 && ang(h.get(lone)!, h.get(b)!) > 120) { link(a, n, b, n, true); link(lone, n, a, n, false); }
    }
  }

  // ---- keep-right votes: an antiparallel carriageway beside you is on your left (right-hand traffic)
  const keepRight = new Map<number, 1 | -1>();
  const info = ow.map((id) => {
    const s = byId.get(id)!; const a = s.pts[0], b = s.pts[s.pts.length - 1];
    return { id, mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2, dx: b.x - a.x, dz: b.z - a.z, y: s.pts.reduce((t, p) => t + p.y, 0) / s.pts.length, len: Math.hypot(b.x - a.x, b.z - a.z) };
  }).filter((o) => o.len > 15);
  const cell = 80, grid = new Map<string, typeof info>();
  for (const o of info) { const k = `${Math.floor(o.mx / cell)},${Math.floor(o.mz / cell)}`; const l = grid.get(k); if (l) l.push(o); else grid.set(k, [o]); }
  for (const o of info) {
    let best: { d: number; cross: number; cos: number } | null = null;
    const gx = Math.floor(o.mx / cell), gz = Math.floor(o.mz / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const t of grid.get(`${gx + i},${gz + j}`) ?? []) {
      if (t.id === o.id || Math.abs(t.y - o.y) > 4) continue; // stacked roads (e.g. terminal levels) are not carriageway pairs
      const d = Math.hypot(t.mx - o.mx, t.mz - o.mz);
      if (d > 70) continue;
      const cos = (o.dx * t.dx + o.dz * t.dz) / o.len / t.len;
      if (Math.abs(cos) < 0.94) continue;
      const cross = (o.dx * (t.mz - o.mz) - o.dz * (t.mx - o.mx)) / o.len;
      if (Math.abs(cross) < 6) continue;
      if (!best || d < best.d) best = { d, cross, cos };
    }
    if (best && best.cos < 0) keepRight.set(o.id, best.cross > 0 ? 1 : -1);
  }

  // ---- orient each group
  const groups = new Map<number, [number, number][]>();
  for (const id of ow) { const [r, k] = find(id); const g = groups.get(r); if (g) g.push([id, k]); else groups.set(r, [[id, k]]); }
  const dir = new Map<number, 1 | -1>(), source = new Map<number, OneWaySource>();
  const bySource: Record<OneWaySource, number> = { transit: 0, keepright: 0, prior: 0 };
  for (const members of groups.values()) {
    let tv = 0, kr = 0, pr = 0;
    for (const [id, k] of members) {
      const t = truth.get(id);
      if (t && !opts.hideTruth?.has(id)) tv += t * k;
      const v = keepRight.get(id); if (v) kr += v * k;
      pr += kind.get(id)! * k;
    }
    const [rootDir, src]: [number, OneWaySource] = tv !== 0 ? [Math.sign(tv), 'transit'] : kr !== 0 ? [Math.sign(kr), 'keepright'] : [pr >= 0 ? 1 : -1, 'prior'];
    for (const [id, k] of members) { dir.set(id, (rootDir * k) as 1 | -1); source.set(id, src); bySource[src]++; }
  }
  return { dir, source, truth, stats: { oneway: ow.length, groups: groups.size, conflicts, bySource } };
}

export type { P };
