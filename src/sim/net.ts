// NetManager section: nodes, segments, lanes. Mirrors NetManager.Data.Serialize (write path, format 121034);
// older formats follow the version branches of NetManager.Data.Deserialize (acs/NetManager.cs:424).
import { SaveError, section, endSection, type SaveData } from './reader';

// Buffer sizes = NetManager.MAX_LANE_COUNT / MAX_NODE_COUNT / MAX_SEGMENT_COUNT (vanilla).
const NL = 262144, NNODE = 32768, NSEG = 36864;

export interface SaveNet {
  nodeCount: number;              // buffer size
  nodeFlags: Uint32Array;         // NetNode.m_flags per node id (0 = not in use); Created bit = 1
  nodeFlags2: Uint32Array;        // NetNode.m_flags2 (PedestrianStreetTransition = 2, ...)
  nodeX: Float32Array; nodeY: Float32Array; nodeZ: Float32Array; // m_position (exact float32)
  segCount: number;
  segFlags: Uint32Array;          // NetSegment.m_flags (Created bit = 1)
  segStart: Uint16Array; segEnd: Uint16Array;   // node ids
  segPrefab: Uint16Array;         // index into prefabNames (NetInfo prefab table)
  segStartDir: Float32Array; segEndDir: Float32Array; // 3 floats per segment (m_startDirection/m_endDirection)
  segTraffic: Uint8Array;         // m_trafficDensity (0-100, the % the game's Traffic info view colours by)
  segFirstLane: Uint32Array;      // m_lanes
  laneNext: Uint32Array;          // NetLane.m_nextLane
  laneFlags: Uint16Array;         // NetLane.m_flags by lane id (Forward 0x10, Left 0x20, Right 0x40: the effective lane arrows)
  prefabNames: (string | null)[]; // PrefabCollection<NetInfo> name table
}

export function readNet(sd: SaveData): SaveNet {
  const sec = section(sd, 'NetManager');
  if (!sec) throw new SaveError('corrupt', 'no NetManager section');
  const { s, end } = sec;
  const v = sd.version;

  // lanes
  const lf = s.eaU16(NL - 1);
  const laneFlags = new Uint16Array(NL); laneFlags.set(lf, 1);
  const laneNext = new Uint32Array(NL);
  let nl = 0;
  for (let i = 1; i < NL; i++) if (laneFlags[i]) { laneNext[i] = s.u24(); nl++; }
  s.eaU8(nl); s.eaU8(nl); s.eaU8(nl); s.eaU16(nl); // reservedPrev/Next/Frame, lastReserveID

  // nodes: flags interleaved with flags2
  const nf = s.eaU32(2 * (NNODE - 1));
  const nodeFlags = new Uint32Array(NNODE), nodeFlags2 = new Uint32Array(NNODE);
  let nn = 0;
  for (let i = 1; i < NNODE; i++) { nodeFlags2[i] = nf[2 * (i - 1) + 1]; if ((nodeFlags[i] = nf[2 * (i - 1)])) nn++; }
  s.eaI64(2 * nn); s.eaU8(nn); s.eaU16(2 * nn); // problems, maxWaitTime, temp/finalCounter
  const nodeX = new Float32Array(NNODE), nodeY = new Float32Array(NNODE), nodeZ = new Float32Array(NNODE);
  for (let i = 1; i < NNODE; i++) {
    if (!nodeFlags[i]) continue;
    nodeX[i] = s.f32(); nodeY[i] = s.f32(); nodeZ[i] = s.f32();
    s.skip(2 * s.u8()); // segment ids
    s.skip(4 + 2 + 2 + 3 + 1 + 1 + 1 + 1); // buildIndex .. connectCount
    if (v >= 121007) s.skip(2); // eventRoute (Deserialize:807)
  }

  // segments
  const sf = new Uint32Array(NSEG); // m_flags by segment id
  s.eaU32(NSEG - 1, sf.subarray(1));
  s.eaU32(NSEG - 1); // flags2
  let ns = 0;
  for (let i = 1; i < NSEG; i++) if (sf[i]) ns++;
  s.eaI64(2 * ns); s.eaI32(2 * ns); // problems, traffic light states
  s.eaU8(ns); s.eaU8(ns); s.eaU8(ns); s.eaU16(ns); s.eaU8(ns); // fire, wet, condition, noise buf/density
  if (v >= 121030) s.eaU8(ns); // attractiveness (Deserialize:1060)
  const segStart = new Uint16Array(NSEG), segEnd = new Uint16Array(NSEG);
  const segStartDir = new Float32Array(3 * NSEG), segEndDir = new Float32Array(3 * NSEG);
  const segTraffic = new Uint8Array(NSEG), segFirstLane = new Uint32Array(NSEG);
  let nTree = 0, nLeft = 0, nRight = 0;
  for (let i = 1; i < NSEG; i++) {
    if (!sf[i]) continue;
    s.skip(8); // buildIndex, modifiedIndex
    segFirstLane[i] = s.u24();
    s.skip(3); // path
    for (let k = 0; k < 3; k++) segStartDir[3 * i + k] = s.f32();
    for (let k = 0; k < 3; k++) segEndDir[3 * i + k] = s.f32();
    segStart[i] = s.u16(); segEnd[i] = s.u16();
    s.skip(8 + 2); // blocks, trafficBuffer
    segTraffic[i] = s.u8();
    s.skip(2 + 1); // nameSeed, overridePathFindDirectionLimit
    if (s.bool()) nTree++;
    if (v >= 120003) { if (s.bool()) nLeft++; if (s.bool()) nRight++; } // fences (Deserialize:1167)
    if (v >= 121005) s.skip(4); // eventRoute, nextEventRouteSegment (Deserialize:1177)
  }
  const nGuide = s.u16(), nUnlock = s.u16();

  // PrefabCollection<NetInfo>: indices (nodes, segments, guides, unlocks) then the name table
  const pidx = s.eaU16(nn + ns + nGuide + nUnlock);
  const prefabNames: (string | null)[] = [];
  for (let k = s.u16(); k > 0; k--) prefabNames.push(s.ustr());
  const segPrefab = new Uint16Array(NSEG);
  for (let i = 1, k = nn; i < NSEG; i++) if (sf[i]) segPrefab[i] = pidx[k++];
  for (const n of v >= 120003 ? [nTree, nLeft, nRight] : [nTree]) { s.eaU16(n); for (let k = s.u16(); k > 0; k--) s.ustr(); } // tree, left/right fence prefabs (Deserialize:1274)
  for (let k = nGuide + nUnlock + 18; k > 0; k--) s.obj(); // guides, unlock milestones, 18 manager objects
  s.skip(1 + 1 + 3); // last/currentMaxWetness, nameModifiedCount
  s.eaI64(s.u24()); // adjustedSegments
  endSection(s, end, 'NetManager');

  return { nodeCount: NNODE, nodeFlags, nodeFlags2, nodeX, nodeY, nodeZ, segCount: NSEG, segFlags: sf, segStart, segEnd, segPrefab,
    segStartDir, segEndDir, segTraffic, segFirstLane, laneNext, laneFlags, prefabNames };
}

// ---------------------------------------------------------------- export geometry
// Port of MapInfoExporter.ExportSegments: start, Bezier3 at t=.25/.5/.75 of NetSegment.CalculateMiddlePoints
// (smoothStart/End false), end; 2 points when startDir == -endDir (Unity approximate ==).
// The game's Mono evaluates float math in double and rounds to float32 at stores/locals: f() marks those.
const f = Math.fround;
const K015 = f(0.15), K03 = f(0.3), K01 = f(0.1), K0999 = f(0.999), EPS = f(9.9999994e-11);
type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const sub = (a: V3, b: V3): V3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const mul = (a: V3, k: number): V3 => [f(a[0] * k), f(a[1] * k), f(a[2] * k)];

function middlePoints(sp: V3, sd: V3, ep: V3, ed: V3): [V3, V3] {
  const v = sub(ep, sp);
  const dist = f(Math.sqrt(f(v[0] * v[0] + v[2] * v[2])));
  const dir: V3 = dist !== 0 ? [f(v[0] / dist), f(v[1] / dist), f(v[2] / dist)] : v;
  const dot = f(sd[0] * ed[0] + sd[2] * ed[2]);
  const dot2 = f(sd[0] * dir[0] + sd[2] * dir[2]);
  if (dot < -K0999 && dot2 > K0999) {
    const k = f(dist * K015);
    return [add(sp, mul(sd, k)), add(ep, mul(ed, k))];
  }
  if (dot >= -K0999) {
    // Line2.Intersect(sp.xz, (sp+sd).xz, ep.xz, (ep+ed).xz)
    const b = add(sp, sd), q = add(ep, ed);
    const v1x = f(b[0] - sp[0]), v1y = f(b[2] - sp[2]), v2x = f(q[0] - ep[0]), v2y = f(q[2] - ep[2]);
    const v3x = f(sp[0] - ep[0]), v3y = f(sp[2] - ep[2]);
    const den = f(v1x * v2y - v1y * v2x);
    if (den !== 0) {
      let u = f((v3y * v2x - v3x * v2y) / den), w = f((v1x * v3y - v1y * v3x) / den);
      const lo = f(dist * K01);
      u = u < lo ? lo : u > dist ? dist : u;
      w = w < lo ? lo : w > dist ? dist : w;
      const m = f(f(u + w) * K03);
      return [add(sp, mul(sd, u < m ? u : m)), add(ep, mul(ed, w < m ? w : m))];
    }
  }
  const k = f(dist * K03);
  return [add(sp, mul(sd, k)), add(ep, mul(ed, k))];
}

function bezier(a: V3, b: V3, c: V3, d: V3, t: number, out: number[]) {
  const n = f(1 - t), n2 = f(t * t * t), n3 = f(3 * t * t * n), n4 = f(3 * t * n * n), n5 = f(n * n * n);
  for (let k = 0; k < 3; k++) out.push(f(a[k] * n5 + b[k] * n4 + c[k] * n3 + d[k] * n2));
}

/** CSLMapView's segment points (MapInfoExporter.ExportSegments): [x,y,z, x,y,z, ...] float32-exact, 2 or 5 points. */
export function segmentPoints(net: SaveNet, seg: number): number[] {
  const a = net.segStart[seg], b = net.segEnd[seg];
  const sp: V3 = [net.nodeX[a], net.nodeY[a], net.nodeZ[a]], ep: V3 = [net.nodeX[b], net.nodeY[b], net.nodeZ[b]];
  const D = net.segStartDir, E = net.segEndDir, o = 3 * seg;
  const sd: V3 = [D[o], D[o + 1], D[o + 2]], ed: V3 = [E[o], E[o + 1], E[o + 2]];
  // sd != -ed  <=>  !(sqrMagnitude(sd - (-ed)) < 9.9999994e-11f)
  const dv = sub(sd, [f(0 - ed[0]), f(0 - ed[1]), f(0 - ed[2])]);
  if (f(dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]) < EPS) return [...sp, ...ep];
  const [m1, m2] = middlePoints(sp, sd, ep, ed);
  const out: number[] = [...sp];
  for (const t of [0.25, 0.5, 0.75]) bezier(sp, m1, m2, ep, t, out);
  out.push(...ep);
  return out;
}

/** lane ids of a segment in NetInfo.m_lanes order (follow m_lanes -> m_nextLane) */
export function segmentLanes(net: SaveNet, seg: number): number[] {
  const out: number[] = [];
  for (let l = net.segFirstLane[seg]; l && out.length < 256; l = net.laneNext[l]) out.push(l); // cap guards a corrupt cycle
  return out;
}
