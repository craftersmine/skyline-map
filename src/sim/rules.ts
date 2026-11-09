// Routing rules from a save, for matched segments only (see validate.ts). Each is a rule the game itself
// enforces, read from the save and applied the way the game applies it; traffic density is never used:
//  - exact one-way directions: lane direction (export) + the segment's Invert flag (save) — PathFind.cs:779,
//    NetInfo.cs:1103 (left-hand traffic also flips vehicle lanes);
//  - U-turns: with TM:PE, its pathfinder's rule (junction restrictions on: JunctionRestrictionsManager.IsUturnAllowed,
//    explicit setting else its default; off: only at End / OneWayOut nodes). Without TM:PE nothing is banned: the
//    vanilla rule also depends on prefab vehicle categories the save lacks;
//  - TM:PE speed limits (SpeedLimitManager): per lane, else TM:PE's default for the road type, else the
//    prefab's limit — only on lanes TM:PE can customise and only while the save has speed limits enabled;
//  - TM:PE vehicle restrictions (CustomPathFind.CanUseLane): a direction whose every car lane bars passenger
//    cars is banned under Strict aggression, otherwise TM:PE's own cost factor (×10/×100/×1000) applies.
// Per-direction rules need lane directions; they are only built for right-hand traffic until a left-hand save
// has been checked (docs/research/routing-rules.md).
import type { CityData, CLane } from '../parse';
import { type SaveNet, segmentLanes } from './net';
import type { TmpeData } from './tmpe';
import { TMPE_UNLIMITED_KMH } from './tmpe';
import { M } from './validate';
import { detectTolls } from '../tolls';

export interface SimRules {
  /** +1: traffic runs start→end, -1: end→start; matched one-way vehicle segments */
  oneway: Map<number, 1 | -1>;
  /** fastest limit (km/h) of the lanes private cars drive, per direction [start→end, end→start], only where TM:PE changes it */
  speed: Map<number, [number | null, number | null]>;
  /** [start→end, end→start]: every car lane in that direction bars passenger cars (TM:PE vehicle restrictions) */
  carRestrict: Map<number, [boolean, boolean]>;
  /** what a restricted direction costs: null = banned (Strict), else TM:PE's path-cost factor */
  restrictFactor: number | null;
  /** segment ends where the game forbids a U-turn back along the same segment: segment id + node id */
  uturnBan: { seg: number; node: number }[];
  /** turns TM:PE's lane arrows and lane connections forbid for cars: from segment, at node, onto segment (U-turns are uturnBan) */
  turnBan: { from: number; node: number; to: number }[];
  /** per segment, the fastest limit (km/h) by export lane vehicle type token ('Car', 'Metro'…) where TM:PE changes it */
  trackLimit: Map<number, Map<string, number>>;
  /** counts and context for the page */
  summary: { oneway: number; speed: number; carRestrict: number; restrictBan: boolean; uturnBan: number; turnBan: number; track: number; leftHand: boolean; tmpe: boolean };
}

const VEH = /Car|Train|Metro|Tram|Monorail/;
const flip = (d: string) => (d === 'Forward' ? 'Backward' : d === 'Backward' ? 'Forward' : d === 'AvoidForward' ? 'AvoidBackward' : d === 'AvoidBackward' ? 'AvoidForward' : d);
const tokens = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
// NetSegment.Flags / NetNode.Flags / Flags2 (acs/NetSegment.cs, NetNode.cs)
const INVERT = 0x10;
const N_END = 0x10, N_BEND = 0x40, N_JUNCTION = 0x80, N_TRANSITION = 0x100000, N_ONEWAY_OUT = 0x400000, N2_PED_TRANSITION = 2;
// SpeedLimitManager.LANE_TYPES / VEHICLE_TYPES: the lanes TM:PE can give a speed limit
const SPEED_LANE = (l: CLane) => tokens(l.type).some((t) => t === 'Vehicle' || t === 'TransportVehicle') && tokens(l.vType).some((t) => /^(Car|Metro|Train|Tram|Monorail|Trolleybus)$/.test(t));
// lanes a private car drives (access.ts: lane type exactly Vehicle with a Car vehicle type)
const CAR_LANE = (l: CLane) => l.type === 'Vehicle' && tokens(l.vType).includes('Car');
/** VehicleRestrictionsManager.PATHFIND_PENALTIES by aggression Low/Medium/High; Strict bans */
const PENALTY = [10, 100, 1000];

export function buildRules(city: CityData, net: SaveNet, seg: Uint8Array, tmpe: TmpeData | null, leftHand: boolean): SimRules {
  /** a lane's travel direction relative to the segment's start→end */
  const laneDir = (id: number, l: CLane) => {
    let d = l.dir;
    if (leftHand && /Vehicle|Parking/.test(l.type)) d = flip(d);
    if (net.segFlags[id] & INVERT) d = flip(d);
    return d;
  };
  const fwd = (d: string) => d === 'Forward' || d === 'Both' || d === 'AvoidBackward';
  const back = (d: string) => d === 'Backward' || d === 'Both' || d === 'AvoidForward';
  const opt = tmpe?.options ?? null; // TM:PE rules only with known feature switches
  const speedOn = !!opt?.customSpeedLimits, restrictOn = !!opt?.vehicleRestrictions;

  const laneKmh = new Map<number, number>();
  if (speedOn) for (const s of tmpe!.speedLimits) if (s.kmh < TMPE_UNLIMITED_KMH) laneKmh.set(s.lane, s.kmh); // "no limit": vehicle top speed, unknown here — keep the export's
  const typeKmh = new Map(speedOn ? tmpe!.customDefaultSpeedLimits.filter((d) => d.kmh > 0 && d.kmh < TMPE_UNLIMITED_KMH).map((d) => [d.prefab, d.kmh]) : []);
  const allowed = new Map(restrictOn ? tmpe!.vehicleRestrictions.map((v) => [v.lane, v.allowed]) : []);

  const oneway = new Map<number, 1 | -1>(), speed = new Map<number, [number | null, number | null]>(), carRestrict = new Map<number, [boolean, boolean]>();
  const trackLimit = new Map<number, Map<string, number>>();
  const carTwoWay = new Set<number>();
  for (const s of city.segs) {
    if (seg[s.id] !== M.Verified) continue;
    const st = city.segTypes.get(s.name);
    if (!st) continue;
    const veh = st.lanes.filter((l) => VEH.test(l.vType));
    if (veh.length && !leftHand) {
      const ds = veh.map((l) => laneDir(s.id, l));
      if (ds.every((d) => d === 'Forward' || d === 'AvoidBackward')) oneway.set(s.id, 1);
      else if (ds.every((d) => d === 'Backward' || d === 'AvoidForward')) oneway.set(s.id, -1);
    }
    if (!leftHand) {
      const cars = st.lanes.filter(CAR_LANE).map((l) => laneDir(s.id, l));
      if (cars.some(fwd) && cars.some(back)) carTwoWay.add(s.id);
    }
    if (!speedOn && !restrictOn) continue;
    // lane rules need the save's lane chain to line up with the export's lane list
    const chain = segmentLanes(net, s.id);
    if (chain.length !== st.lanes.length) continue;
    const def = (l: CLane) => Math.round(l.speed * 50);
    const eff = (l: CLane, i: number) => (SPEED_LANE(l) ? laneKmh.get(chain[i]) ?? typeKmh.get(s.name) ?? def(l) : def(l));
    // car speed per direction, before and after TM:PE
    const was: [number, number] = [0, 0], now: [number, number] = [0, 0];
    const hasCar: [boolean, boolean] = [false, false], carOk: [boolean, boolean] = [false, false];
    st.lanes.forEach((l, i) => {
      if (!CAR_LANE(l) || leftHand) return;
      const d = laneDir(s.id, l);
      const ok = !allowed.has(chain[i]) || allowed.get(chain[i])!.includes('PassengerCar');
      for (const [k, on] of [[0, fwd(d)], [1, back(d)]] as const) {
        if (!on) continue;
        was[k] = Math.max(was[k], def(l)); now[k] = Math.max(now[k], eff(l, i));
        hasCar[k] = true; if (ok) carOk[k] = true;
      }
    });
    if (speedOn && (was[0] !== now[0] || was[1] !== now[1])) speed.set(s.id, [hasCar[0] ? now[0] : null, hasCar[1] ? now[1] : null]);
    const r: [boolean, boolean] = [hasCar[0] && !carOk[0], hasCar[1] && !carOk[1]];
    if (r[0] || r[1]) carRestrict.set(s.id, r);
    // transit pieces: fastest lane per vehicle type, as the router's pieces() takes it, where TM:PE changes it
    if (speedOn) for (const tk of new Set(st.lanes.flatMap((l) => tokens(l.vType)).filter((t) => VEH.test(t)))) {
      const lanes = st.lanes.map((l, i) => [l, i] as const).filter(([l]) => tokens(l.vType).includes(tk));
      const before = Math.max(...lanes.map(([l]) => def(l))), after = Math.max(...lanes.map(([l, i]) => eff(l, i)));
      if (after !== before) { const m = trackLimit.get(s.id) ?? new Map<string, number>(); m.set(tk, after); trackLimit.set(s.id, m); }
    }
  }

  // U-turns back along the same segment, for two-way car segments whose end node is known from the save
  const explicit = new Map<string, boolean>();
  if (opt?.junctionRestrictions) for (const j of tmpe!.junctionRestrictions) {
    const s = city.segs.find((x) => x.id === j.segment);
    if (!s) continue;
    if (j.start?.uturnAllowed != null) explicit.set(s.id + ':' + s.sn, j.start.uturnAllowed);
    if (j.end?.uturnAllowed != null) explicit.set(s.id + ':' + s.en, j.end.uturnAllowed);
  }
  const uturnBan: SimRules['uturnBan'] = [];
  for (const s of city.segs) {
    if (!carTwoWay.has(s.id)) continue;
    for (const n of [s.sn, s.en]) {
      const allowed = uturnAllowed(s.id, n, city.nodes.get(n)?.srv ?? '', net.nodeFlags[n], net.nodeFlags2[n], tmpe ? opt : undefined, explicit.get(s.id + ':' + n));
      if (allowed === false) uturnBan.push({ seg: s.id, node: n });
    }
  }
  const turnBan = opt && !opt.highwayRules && !leftHand ? turnBans(city, net, seg, tmpe!, laneDir, fwd, back) : [];
  const restrictFactor = opt ? (opt.restrictionsAggression === 3 ? null : PENALTY[opt.restrictionsAggression]) : null;
  return {
    oneway, speed, carRestrict, restrictFactor, uturnBan, turnBan, trackLimit,
    summary: { oneway: oneway.size, speed: speed.size, carRestrict: carRestrict.size, restrictBan: restrictFactor === null, uturnBan: uturnBan.length, turnBan: turnBan.length, track: trackLimit.size, leftHand, tmpe: !!opt },
  };
}

/**
 * May a car turn back along segment `seg` at node `n`? true / false, or null when it can't be decided from the save
 * (then the router keeps its own behaviour). `opt`: undefined = no TM:PE in the save (vanilla rule), null = TM:PE
 * present with unknown options (undecided).
 */
export function uturnAllowed(seg: number, n: number, nodeService: string, flags: number, flags2: number, opt: TmpeData['options'] | undefined, explicit: boolean | undefined): boolean | null {
  void seg; void n;
  if (!flags) return null;
  const endish = (flags & (N_END | N_ONEWAY_OUT)) !== 0;
  // vanilla PathFind also turns back where the other segments lack this road's vehicle categories (prefab data,
  // not in the save) or are blocked: only the End / OneWayOut part can be decided
  if (opt === undefined) return endish ? true : null;
  // TM:PE's pathfinder with junction restrictions off: only at End / OneWayOut nodes (CustomPathFind)
  if (opt && !opt.junctionRestrictions) return endish;
  if (opt === null) return null;
  // TM:PE JunctionRestrictionsManager: configurable ends take the explicit setting, else the default
  const configurable = (flags & (N_END | N_BEND | N_JUNCTION | N_TRANSITION | N_ONEWAY_OUT)) !== 0 && nodeService !== 'Beautification';
  if (configurable && explicit !== undefined) return explicit;
  if (endish) return true;
  if (flags2 & N2_PED_TRANSITION) return null; // depends on the other segments' vehicle categories (prefab data)
  if (!configurable) return false;
  return opt.allowUTurns && (flags & (N_JUNCTION | N_TRANSITION)) !== 0;
}

// ---------------------------------------------------------------- lane arrows and lane connections
export const enum Arrow { None = 0, Left = 1, Forward = 2, Right = 3, Turn = 4 }
const L_FWD = 0x10, L_LEFT = 0x20, L_RIGHT = 0x40;
const N_UNTOUCHABLE = 0x200;

/** TM:PE ExtSegmentEndManager.CalculateArrowDirection: where `target` leaves the node, seen from `source` (both are
 *  segment directions pointing away from the node: m_startDirection / m_endDirection) */
export function arrowDirection(sx: number, sz: number, tx: number, tz: number): Arrow {
  const f = Math.fround;
  const norm = (x: number, z: number): [number, number] => { const m = f(Math.sqrt(f(f(x * x) + f(z * z)))); return m > 1e-5 ? [f(x / m), f(z / m)] : [0, 0]; };
  [sx, sz] = norm(sx, sz); [tx, tz] = norm(tx, tz);
  const y = f(f(sz * tx) - f(sx * tz)); // Vector3.Cross(source, target).y
  if (y >= 0.5) return Arrow.Left;
  if (y <= -0.5) return Arrow.Right;
  if (f(f(sx * tx) + f(sz * tz)) > 0) return y > 0 ? Arrow.Left : y < 0 ? Arrow.Right : Arrow.Turn;
  return Arrow.Forward;
}

/**
 * A car arriving on segment A at a junction may continue onto segment B when at least one of A's car lanes arriving
 * there allows it (TM:PE RoutingManager.RecalculateLaneEndRoutingData, read the way its backward search uses it):
 *  - a lane with outgoing lane connections at that node: only its connections count;
 *  - otherwise its final lane arrows (TM:PE custom, else the game's own, stored in NetLane.m_flags), matched against
 *    TM:PE's direction of A seen from B (B on the right ⇔ the lane needs a Left arrow…); a lane without arrows goes forward.
 * TM:PE's relaxed transitions that ignore arrows are not used by spawned private cars except on their starting lane;
 * the router exempts a trip's first turn. Undecidable cases ban nothing.
 */
function turnBans(city: CityData, net: SaveNet, seg: Uint8Array, tmpe: TmpeData, laneDir: (id: number, l: CLane) => string, fwd: (d: string) => boolean, back: (d: string) => boolean) {
  const opt = tmpe.options!;
  const byId = new Map(city.segs.map((s) => [s.id, s]));
  const lanesOf = new Map<number, number[]>();
  const laneSeg = new Map<number, number>();
  for (const s of city.segs) {
    if (seg[s.id] !== M.Verified) continue;
    const st = city.segTypes.get(s.name), chain = segmentLanes(net, s.id);
    if (!st || chain.length !== st.lanes.length) continue;
    lanesOf.set(s.id, chain); for (const l of chain) laneSeg.set(l, s.id);
  }
  const custom = new Map(tmpe.laneArrows.map((a) => [a.lane, (a.forward ? L_FWD : 0) | (a.left ? L_LEFT : 0) | (a.right ? L_RIGHT : 0)]));
  // outgoing road connections per lane end: lane + ':' + node → target lanes
  const conn = new Map<string, number[]>();
  if (opt.laneConnector) for (const c of tmpe.laneConnections) {
    if (c.group !== 1 && c.group !== 3) continue; // road connections only
    // keyed by the node the connection sits at: the source lane's end (sourceStartNode); a bidirectional connection
    // also lets the target lane continue into the source lane at that same node
    const sId = laneSeg.get(c.source), s = sId !== undefined ? byId.get(sId) : undefined;
    const add = (from: number, node: number, to: number) => { const k = from + ':' + node; (conn.get(k) ?? conn.set(k, []).get(k)!).push(to); };
    if (!s) {
      // source lane not placed, so the shared node is unknown: a bidirectional connection leaves the target lane
      // undecided at both of its ends (-1 is a target that never resolves)
      const tId = laneSeg.get(c.target), t = tId !== undefined ? byId.get(tId) : undefined;
      if (c.bidirectional && t) { add(c.target, t.sn, -1); add(c.target, t.en, -1); }
      continue;
    }
    const node = c.sourceStartNode ? s.sn : s.en;
    add(c.source, node, c.target);
    if (c.bidirectional) add(c.target, node, c.source);
  }
  // toll booth nodes route lane by lane (RoutingManager flag7): left alone
  const tollNodes = new Set<number>();
  try { const tl = detectTolls(city); for (const id of [...tl.gateOf.keys(), ...tl.boothOf.keys()]) { const s = byId.get(id); if (s) { tollNodes.add(s.sn); tollNodes.add(s.en); } } } catch { /* no tolls */ }
  const at = new Map<number, number[]>();
  for (const s of city.segs) if (!s.path) for (const n of [s.sn, s.en]) (at.get(n) ?? at.set(n, []).get(n)!).push(s.id);
  const dirAt = (id: number, n: number): [number, number] => { const a = net.segStart[id] === n ? net.segStartDir : net.segEndDir; return [a[id * 3], a[id * 3 + 2]]; };
  // lanes a car may be in at a junction: ordinary car lanes and bus lanes. Live paths in the reference save show private
  // cars turning from bus lanes (the turn only a bus lane's arrows allow), as TM:PE routes over every road lane
  // (MatchesRoutedRoad) and leaves bus lanes to vehicle restrictions.
  const carLanes = (id: number) => (city.segTypes.get(byId.get(id)!.name)?.lanes ?? []).map((l, i) => [l, i] as const).filter(([l]) => (l.type === 'Vehicle' || l.type === 'TransportVehicle') && tokens(l.vType).includes('Car'));
  const arrives = (id: number, n: number, l: CLane) => { const d = laneDir(id, l), s = byId.get(id)!; return (n === s.en && fwd(d)) || (n === s.sn && back(d)); };
  const leaves = (id: number, n: number, l: CLane) => { const d = laneDir(id, l), s = byId.get(id)!; return (n === s.sn && fwd(d)) || (n === s.en && back(d)); };

  const out: { from: number; node: number; to: number }[] = [];
  for (const [n, ids] of at) {
    const flags = net.nodeFlags[n];
    if (!(flags & N_JUNCTION) || (flags & N_UNTOUCHABLE) || city.nodes.get(n)?.srv === 'Beautification' || tollNodes.has(n)) continue;
    for (const a of ids) {
      const chain = lanesOf.get(a);
      if (!chain) continue; // unmatched, or lanes we can't map
      const inLanes = carLanes(a).filter(([l]) => arrives(a, n, l));
      if (!inLanes.length) continue;
      for (const b of ids) {
        if (b === a || seg[b] !== M.Verified || !carLanes(b).some(([l]) => leaves(b, n, l))) continue;
        const [bx, bz] = dirAt(b, n), [ax, az] = dirAt(a, n);
        const d = arrowDirection(bx, bz, ax, az); // direction of A seen from B, as TM:PE evaluates it
        if (d === Arrow.None || d === Arrow.Turn) continue; // degenerate geometry: undecided
        // turns sharper than 90° (both roads leave the node on the same side): in the reference save live car paths
        // make such turns against what this reading of TM:PE predicts, for a reason not found in its code: undecided
        if (ax * bx + az * bz > 0) continue;
        let allowed = false, unknown = false;
        for (const [, i] of inLanes) {
          const lane = chain[i];
          const targets = conn.get(lane + ':' + n);
          if (targets) {
            if (targets.some((t) => laneSeg.get(t) === undefined)) unknown = true;
            if (targets.some((t) => laneSeg.get(t) === b)) allowed = true;
            continue;
          }
          const ar = custom.get(lane) ?? (net.laneFlags[lane] & (L_FWD | L_LEFT | L_RIGHT));
          if ((d === Arrow.Right && ar & L_LEFT) || (d === Arrow.Left && ar & L_RIGHT) || (d === Arrow.Forward && (ar & L_FWD || !ar))) allowed = true;
        }
        if (!allowed && !unknown) out.push({ from: a, node: n, to: b });
      }
    }
  }
  return out;
}
