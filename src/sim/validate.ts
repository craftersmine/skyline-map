// Does this save show the same city state as the open map? Compares the save with the export object by
// object, recomputing each object's export geometry from the save exactly as CSLMapView does (float32,
// bit for bit). Identical ids are never trusted on their own: an object counts as matched only when its
// prefab, connections and geometry all agree. Simulation values are attached only to matched objects.
import type { CityData } from '../parse';
import { type SaveNet, segmentPoints } from './net';
import { type SaveBuildings, buildingCorners } from './buildings';

/** per-object outcome */
export const enum M { Verified = 1, Changed = 2, Replaced = 3, Missing = 4 }

export interface Tally { exported: number; verified: number; changed: number; replaced: number; missing: number }
export interface Validation {
  nodes: Tally & { extraInSave: number };
  segments: Tally;
  buildings: Tally;
  lines: Tally;
  verdict: 'match' | 'near' | 'incompatible';
  /**
   * same: every object matches; differs: a few objects were built, removed or changed between the two files;
   * too-different: the same city, but far apart in time; different-city: practically nothing matches.
   * (Which file is older can't be told reliably from the contents, so it isn't claimed.)
   */
  reason: 'same' | 'differs' | 'too-different' | 'different-city' | 'empty';
  /** fraction of exported nodes, segments and buildings whose ids, prefabs and geometry match exactly */
  share: { nodes: number; segments: number; buildings: number };
  /** save nodes that the map lacks / all save nodes (the export lists every created node) */
  saveOnlyShare: number;
}

export interface Matches {
  seg: Uint8Array;   // by segment id: M
  bld: Uint8Array;   // by building id: M
  line: Uint8Array;  // by line id: M
}

const f = Math.fround;
const CREATED = 1;

function tally(): Tally { return { exported: 0, verified: 0, changed: 0, replaced: 0, missing: 0 }; }
function count(t: Tally, m: M) { t.exported++; if (m === M.Verified) t.verified++; else if (m === M.Changed) t.changed++; else if (m === M.Replaced) t.replaced++; else t.missing++; }

export function validate(city: CityData, net: SaveNet, bld: SaveBuildings, lines: { id: number; created: boolean; firstStop: number }[] | null): { v: Validation; m: Matches } {
  // ---- nodes: the export writes every created node, so this comparison is complete in both directions
  const nodes = { ...tally(), extraInSave: 0 };
  const nodeOk = new Uint8Array(net.nodeCount);
  for (const n of city.nodes.values()) {
    let m: M;
    if (n.id >= net.nodeCount || !(net.nodeFlags[n.id] & CREATED)) m = M.Missing;
    else if (f(n.x) === net.nodeX[n.id] && f(n.y) === net.nodeY[n.id] && f(n.z) === net.nodeZ[n.id]) m = M.Verified;
    else m = M.Changed;
    count(nodes, m);
    if (m === M.Verified) nodeOk[n.id] = 1;
  }
  let saveNodes = 0;
  for (let i = 0; i < net.nodeCount; i++) if (net.nodeFlags[i] & CREATED) { saveNodes++; if (!city.nodes.has(i)) nodes.extraInSave++; }

  // ---- segments: prefab, endpoints and the recomputed curve must all match
  const segments = tally();
  const seg = new Uint8Array(net.segCount);
  for (const s of city.segs) {
    let m: M;
    if (s.id >= net.segCount || !(net.segFlags[s.id] & CREATED)) m = M.Missing;
    else {
      const sameType = net.prefabNames[net.segPrefab[s.id]] === s.name;
      const sameEnds = net.segStart[s.id] === s.sn && net.segEnd[s.id] === s.en && nodeOk[s.sn] === 1 && nodeOk[s.en] === 1;
      if (!sameType && !sameEnds) m = M.Replaced;
      else if (!sameType || !sameEnds) m = M.Changed;
      else {
        const p = segmentPoints(net, s.id);
        let same = p.length === s.pts.length * 3;
        for (let i = 0; same && i < s.pts.length; i++) same = f(s.pts[i].x) === p[i * 3] && f(s.pts[i].y) === p[i * 3 + 1] && f(s.pts[i].z) === p[i * 3 + 2];
        m = same ? M.Verified : M.Changed;
      }
    }
    count(segments, m);
    if (s.id < seg.length) seg[s.id] = m;
  }

  // ---- buildings: prefab and the recomputed footprint must match
  const buildings = tally();
  const bm = new Uint8Array(bld.flags.length);
  for (const b of city.buildings) {
    let m: M;
    if (b.id >= bld.flags.length || !(bld.flags[b.id] & CREATED)) m = M.Missing;
    else {
      const sameType = bld.prefabNames[bld.prefab[b.id]] === b.name;
      const c = buildingCorners(bld, b.id);
      let same = b.pts.length === 4;
      for (let i = 0; same && i < 4; i++) same = f(b.pts[i].x) === c[i * 2] && f(b.pts[i].z) === c[i * 2 + 1];
      m = sameType && same ? M.Verified : !sameType && !same ? M.Replaced : M.Changed;
    }
    count(buildings, m);
    if (b.id < bm.length) bm[b.id] = m;
  }

  // ---- transit lines: same first stop, and every hop between consecutive stops is a matched segment
  const lt = tally();
  const line = new Uint8Array(256);
  const hop = new Map<string, number>();
  for (const s of city.segs) if (s.path) hop.set(s.sn + ',' + s.en, s.id);
  for (const tr of city.transports) {
    let m: M;
    const sl = lines?.find((l) => l.id === tr.id);
    if (!sl || !sl.created) m = M.Missing;
    else if (!tr.stops.length) m = sl.firstStop === 0 ? M.Verified : M.Changed;
    else if (sl.firstStop !== tr.stops[0]) m = M.Replaced;
    else {
      let ok = true;
      for (let i = 0; ok && i < tr.stops.length; i++) {
        const id = hop.get(tr.stops[i] + ',' + tr.stops[(i + 1) % tr.stops.length]);
        ok = tr.stops.length < 2 || (id !== undefined && seg[id] === M.Verified);
      }
      m = ok ? M.Verified : M.Changed;
    }
    count(lt, m);
    if (tr.id < 256) line[tr.id] = m;
  }

  const share = {
    nodes: nodes.exported ? nodes.verified / nodes.exported : 0,
    segments: segments.exported ? segments.verified / segments.exported : 0,
    buildings: buildings.exported ? buildings.verified / buildings.exported : 0,
  };
  const saveOnlyShare = saveNodes ? nodes.extraInSave / saveNodes : 0;
  const { verdict, reason } = judge(share, saveOnlyShare, nodes);
  return { v: { nodes, segments, buildings, lines: lt, verdict, reason, share, saveOnlyShare }, m: { seg, bld: bm, line } };
}

/**
 * Verdict from the measured shares, calibrated on real save/export pairs (docs/sim-data.md, "Calibration"):
 *  - 19/19 pairs written together by CSLMapView's "Auto export on saving game" score exactly 1 everywhere
 *    with no save-only nodes; the closest non-identical pair scored 0.9975.  -> match needs >= 0.999.
 *  - consecutive saves of one city (hours to days apart) scored >= 0.929 (worst share), months apart
 *    0.81-0.95 with up to 18% save-only nodes.  -> near needs >= 0.9 on both sides.
 *  - other cities scored exactly 0 (coordinates never coincide bit for bit); same-city pairs never
 *    fell below 0.83 on nodes.  -> below 0.5 means a different city.
 */
export function judge(share: Validation['share'], saveOnlyShare: number, nodes: Tally): { verdict: Validation['verdict']; reason: Validation['reason'] } {
  if (!nodes.exported) return { verdict: 'incompatible', reason: 'empty' };
  const exportSide = Math.min(share.nodes, share.segments, share.buildings);
  if (share.nodes < CAL.differentCity) return { verdict: 'incompatible', reason: 'different-city' };
  if (exportSide >= CAL.same && saveOnlyShare <= 1 - CAL.same) return { verdict: 'match', reason: 'same' };
  if (exportSide >= CAL.near && saveOnlyShare <= 1 - CAL.near) return { verdict: 'near', reason: 'differs' };
  return { verdict: 'incompatible', reason: 'too-different' };
}

/** calibration constants (see judge) */
export const CAL = { same: 0.999, near: 0.9, differentCity: 0.5 };
