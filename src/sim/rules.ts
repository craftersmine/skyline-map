// Routing rules from a save, for matched segments only (see validate.ts). Everything here is a rule the game
// itself enforces, read from the save, never derived from traffic density:
//  - exact one-way directions: lane direction (export) + the segment's Invert flag (save), the game's own rule
//    (PathFind.cs:779: Invert flips the lane's final direction; NetInfo.cs:1103 flips vehicle lanes in left-hand traffic);
//  - TM:PE speed limits: per lane, else TM:PE's default for the road type, else the prefab's own limit
//    (the order TM:PE's speed limit manager uses);
//  - TM:PE vehicle restrictions: a direction where no car lane admits passenger cars is closed to driving;
//  - TM:PE junction restrictions: an explicit "no U-turn" at a segment end.
// Direction-dependent rules need the lane directions; they are only built for right-hand traffic until a
// left-hand save has been checked (docs/research/routing-rules.md).
import type { CityData, CLane } from '../parse';
import { type SaveNet, segmentLanes } from './net';
import type { TmpeData } from './tmpe';
import { TMPE_UNLIMITED_KMH } from './tmpe';
import { M } from './validate';

export interface SimRules {
  /** +1: traffic runs start→end, -1: end→start; matched one-way vehicle segments */
  oneway: Map<number, 1 | -1>;
  /** fastest car-lane limit in km/h per direction [start→end, end→start], only where TM:PE changes it */
  speed: Map<number, [number | null, number | null]>;
  /** [start→end, end→start] closed to private cars by TM:PE vehicle restrictions */
  carBan: Map<number, [boolean, boolean]>;
  /** segment ends where TM:PE forbids U-turns: segment id + node id */
  uturnBan: { seg: number; node: number }[];
  /** per segment, the fastest limit (km/h) by export lane vehicle type token ('Car', 'Metro', 'Train'…) where TM:PE changes it */
  trackLimit: Map<number, Map<string, number>>;
  /** counts for the page */
  summary: { oneway: number; speed: number; carBan: number; uturnBan: number; track: number; leftHand: boolean };
}

const VEH = /Car|Train|Metro|Tram|Monorail/;
const flip = (d: string) => (d === 'Forward' ? 'Backward' : d === 'Backward' ? 'Forward' : d === 'AvoidForward' ? 'AvoidBackward' : d === 'AvoidBackward' ? 'AvoidForward' : d);
const INVERT = 0x10;
const tokens = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

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

  const laneKmh = new Map<number, number>();
  for (const s of tmpe?.speedLimits ?? []) if (s.kmh < TMPE_UNLIMITED_KMH) laneKmh.set(s.lane, s.kmh); // "no limit" keeps the export's limit
  const typeKmh = new Map((tmpe?.customDefaultSpeedLimits ?? []).filter((d) => d.kmh > 0 && d.kmh < TMPE_UNLIMITED_KMH).map((d) => [d.prefab, d.kmh]));
  const allowed = new Map((tmpe?.vehicleRestrictions ?? []).map((v) => [v.lane, v.allowed]));

  const oneway = new Map<number, 1 | -1>(), speed = new Map<number, [number | null, number | null]>(), carBan = new Map<number, [boolean, boolean]>();
  const trackLimit = new Map<number, Map<string, number>>();
  for (const s of city.segs) {
    if (seg[s.id] !== M.Verified) continue;
    const st = city.segTypes.get(s.name);
    if (!st) continue;
    // exact one-way (right-hand traffic only, see above)
    const veh = st.lanes.filter((l) => VEH.test(l.vType));
    if (veh.length && !leftHand) {
      const ds = veh.map((l) => laneDir(s.id, l));
      if (ds.every((d) => d === 'Forward' || d === 'AvoidBackward')) oneway.set(s.id, 1);
      else if (ds.every((d) => d === 'Backward' || d === 'AvoidForward')) oneway.set(s.id, -1);
    }
    if (!tmpe) continue;
    // TM:PE lane rules need the save's lane chain to line up with the export's lane list
    const chain = segmentLanes(net, s.id);
    if (chain.length !== st.lanes.length) continue;
    const kmh = (i: number) => laneKmh.get(chain[i]) ?? typeKmh.get(s.name) ?? null;
    let changed = false;
    const best: [number | null, number | null] = [null, null];
    const carOk: [boolean, boolean] = [false, false], hasCar: [boolean, boolean] = [false, false];
    st.lanes.forEach((l, i) => {
      const own = kmh(i);
      const v = own ?? Math.round(l.speed * 50);
      if (own !== null && own !== Math.round(l.speed * 50)) changed = true;
      for (const tk of tokens(l.vType)) {
        if (own === null || !VEH.test(tk)) continue;
        const m = trackLimit.get(s.id) ?? new Map<string, number>();
        m.set(tk, Math.max(m.get(tk) ?? 0, v)); trackLimit.set(s.id, m);
      }
      if (!tokens(l.vType).includes('Car') || leftHand) return;
      const d = laneDir(s.id, l);
      const ok = !allowed.has(chain[i]) || allowed.get(chain[i])!.includes('PassengerCar');
      for (const [k, on] of [[0, fwd(d)], [1, back(d)]] as const) {
        if (!on) continue;
        best[k] = Math.max(best[k] ?? 0, v);
        hasCar[k] = true; if (ok) carOk[k] = true;
      }
    });
    if (changed && !leftHand && (best[0] !== null || best[1] !== null)) speed.set(s.id, best);
    const ban: [boolean, boolean] = [hasCar[0] && !carOk[0], hasCar[1] && !carOk[1]];
    if (ban[0] || ban[1]) carBan.set(s.id, ban);
    // keep only vehicle types whose limit really changed
    const tl = trackLimit.get(s.id);
    if (tl) {
      for (const [tk, v] of tl) {
        const orig = Math.max(0, ...st.lanes.filter((l) => tokens(l.vType).includes(tk)).map((l) => Math.round(l.speed * 50)));
        if (v === orig) tl.delete(tk);
      }
      if (!tl.size) trackLimit.delete(s.id);
    }
  }
  const segById = new Map(city.segs.map((s) => [s.id, s]));
  const uturnBan: SimRules['uturnBan'] = [];
  for (const j of tmpe?.junctionRestrictions ?? []) {
    const s = segById.get(j.segment);
    if (!s || seg[s.id] !== M.Verified) continue;
    if (j.start?.uturnAllowed === false) uturnBan.push({ seg: s.id, node: s.sn });
    if (j.end?.uturnAllowed === false) uturnBan.push({ seg: s.id, node: s.en });
  }
  return {
    oneway, speed, carBan, uturnBan, trackLimit,
    summary: { oneway: oneway.size, speed: speed.size, carBan: carBan.size, uturnBan: uturnBan.length, track: trackLimit.size, leftHand },
  };
}
