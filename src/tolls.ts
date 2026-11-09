// Toll booths and the road segments they control.
//
// The export has no booth→road link and no fees, but the geometry is unambiguous
// (validated on every booth in the exports, see `npm run check:tolls`):
//  1. a toll-road segment whose midpoint lies inside a booth's footprint (or its
//     sub-building's) is that booth's GATE — driving through it means paying;
//  2. other toll-road segments chained to a gate are the booth's approach lanes;
//  3. the non-toll roads meeting those segments are the roads the booth sits on.
// A route counts as tolled only when it traverses a gate segment, never merely
// for using a highway or a booth's approach lane.
import type { CityData, CSeg } from './parse';

export interface TollBooth {
  id: number;
  /** the name the player gave the booth, if any */
  name: string;
  /** "One-way" / "Two-way", and the asset size (Medium/Large…) */
  kind: string;
  x: number; z: number;
  gates: number[];
  approaches: number[];
  /** names of the roads it sits on (custom names first), and their network types */
  roads: string[];
  roadTypes: string[];
  /** toll lanes with no booth building in the export: shown and flagged, but may not charge */
  unconfirmed?: boolean;
}
export interface TollData {
  booths: TollBooth[];
  /** gate segment id → booth id */
  gateOf: Map<number, number>;
  /** any toll segment (gate or approach) → booth id */
  boothOf: Map<number, number>;
  /** toll segments no booth building claims (they form 'unconfirmed' booths) */
  orphans: number[];
}

const TOLL_SEG = /Toll/i;

function inside(p: { x: number; z: number }, poly: { x: number; z: number }[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}

export function detectTolls(city: CityData): TollData {
  const parents = city.buildings.filter((b) => /Toll Booth/i.test(b.name) && !b.parent && b.pts.length >= 3);
  const tollSegs = city.segs.filter((s) => !s.path && s.pts.length >= 2 && TOLL_SEG.test(s.name));
  const at = new Map<number, CSeg[]>();
  for (const s of city.segs) if (!s.path) for (const n of [s.sn, s.en]) { const l = at.get(n); if (l) l.push(s); else at.set(n, [s]); }

  const gateOf = new Map<number, number>(), boothOf = new Map<number, number>();
  for (const b of parents) {
    const polys = [b.pts, ...city.buildings.filter((x) => x.parent === b.id).map((x) => x.pts)];
    for (const s of tollSegs) {
      if (gateOf.has(s.id)) continue;
      const m = s.pts[s.pts.length >> 1];
      if (polys.some((p) => inside(m, p))) { gateOf.set(s.id, b.id); boothOf.set(s.id, b.id); }
    }
  }
  // approach lanes: toll segments chained to a claimed one
  for (let changed = true; changed;) {
    changed = false;
    for (const s of tollSegs) {
      if (boothOf.has(s.id)) continue;
      const owner = [s.sn, s.en].flatMap((n) => at.get(n) ?? []).find((o) => boothOf.has(o.id));
      if (owner) { boothOf.set(s.id, boothOf.get(owner.id)!); changed = true; }
    }
  }
  // toll lanes no booth claims: the booth building is missing from the export (removed in game, or
  // not exported). Each connected chain becomes an "unconfirmed" toll: flagged, but it may not charge.
  const orphans: number[] = tollSegs.filter((s) => !boothOf.has(s.id)).map((s) => s.id);
  const orphanSet = new Set(orphans);
  const extra: { id: number; segs: CSeg[] }[] = [];
  for (const s of tollSegs) {
    if (!orphanSet.has(s.id) || boothOf.has(s.id)) continue;
    const id = -(extra.length + 1), chain: CSeg[] = [], stack = [s];
    boothOf.set(s.id, id);
    while (stack.length) {
      const c = stack.pop()!; chain.push(c); gateOf.set(c.id, id);
      for (const o of [c.sn, c.en].flatMap((n) => at.get(n) ?? [])) if (orphanSet.has(o.id) && !boothOf.has(o.id)) { boothOf.set(o.id, id); stack.push(o); }
    }
    extra.push({ id, segs: chain });
  }

  const booths: TollBooth[] = parents.map((b) => {
    const mine = tollSegs.filter((s) => boothOf.get(s.id) === b.id);
    const roads = new Map<string, number>(), types = new Set<string>();
    for (const s of mine) for (const n of [s.sn, s.en]) for (const o of at.get(n) ?? []) {
      if (TOLL_SEG.test(o.name)) continue;
      types.add(o.name);
      if (o.customName) roads.set(o.customName, (roads.get(o.customName) ?? 0) + 1);
    }
    const c = centroid(b.pts);
    const way = /One ?way/i.test(b.name) ? 'One-way' : 'Two-way';
    const size = /Large/i.test(b.name) ? 'large' : /Small/i.test(b.name) ? 'small' : 'medium';
    return {
      id: b.id, name: b.myname || '', kind: `${way} toll booth (${size})`, x: c.x, z: c.z,
      gates: mine.filter((s) => gateOf.get(s.id) === b.id).map((s) => s.id),
      approaches: mine.filter((s) => gateOf.get(s.id) !== b.id).map((s) => s.id),
      roads: [...roads].sort((a, b2) => b2[1] - a[1]).map(([n]) => n), roadTypes: [...types],
    };
  });
  for (const e of extra) {
    const roads = new Map<string, number>(), types = new Set<string>();
    for (const s of e.segs) for (const n of [s.sn, s.en]) for (const o of at.get(n) ?? []) {
      if (TOLL_SEG.test(o.name)) continue;
      types.add(o.name); if (o.customName) roads.set(o.customName, (roads.get(o.customName) ?? 0) + 1);
    }
    const pts = e.segs.flatMap((s) => s.pts), c = centroid(pts);
    booths.push({ id: e.id, name: '', kind: 'Toll lanes (no booth in the export)', x: c.x, z: c.z, gates: e.segs.map((s) => s.id), approaches: [],
      roads: [...roads].sort((a, b) => b[1] - a[1]).map(([n]) => n), roadTypes: [...types], unconfirmed: true });
  }
  return { booths, gateOf, boothOf, orphans };
}

const centroid = (p: { x: number; z: number }[]) => ({ x: p.reduce((t, q) => t + q.x, 0) / p.length, z: p.reduce((t, q) => t + q.z, 0) / p.length });

/** How a booth is called in the UI: the player's name, else a generic label (never an invented name). */
export const boothLabel = (b: Pick<TollBooth, 'name' | 'unconfirmed'>) => b.name || (b.unconfirmed ? 'Toll lanes' : 'Toll booth');
