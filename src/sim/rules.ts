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
  /** per segment, the fastest limit (km/h) by export lane vehicle type token ('Car', 'Metro'…) where TM:PE changes it */
  trackLimit: Map<number, Map<string, number>>;
  /** counts and context for the page */
  summary: { oneway: number; speed: number; carRestrict: number; restrictBan: boolean; uturnBan: number; track: number; leftHand: boolean; tmpe: boolean };
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
  const restrictFactor = opt ? (opt.restrictionsAggression === 3 ? null : PENALTY[opt.restrictionsAggression]) : null;
  return {
    oneway, speed, carRestrict, restrictFactor, uturnBan, trackLimit,
    summary: { oneway: oneway.size, speed: speed.size, carRestrict: carRestrict.size, restrictBan: restrictFactor === null, uturnBan: uturnBan.length, track: trackLimit.size, leftHand, tmpe: !!opt },
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
