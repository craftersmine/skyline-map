// Transit travel-time model. The export has speed limits for every road and track
// but no timetables, so in-vehicle time is modelled from physics and the network,
// and waiting is an explicitly labelled estimate.
//
// Per hop (one stop to the next):
//  - each piece of road/track runs at an operating speed: the posted limit, capped
//    at a realistic vehicle top speed, times a traffic factor for street running;
//  - buses (and trams in the street) lose time at junctions (signals, yielding)
//    and slow down to turn;
//  - the vehicle accelerates out of the stop and brakes into the next one
//    (a triangle profile when the stops are too close to reach cruise speed);
//  - a dwell time is spent at each intermediate stop.
// Validated by `npm run check:transit` against plausible real-world speeds.

export interface ModeParams {
  /** realistic top operating speed, km/h */ cap: number;
  /** acceleration / braking, m/s² */ accel: number; brake: number;
  /** seconds stopped at each intermediate stop */ dwell: number;
  /** estimated average wait at the first stop, seconds (no timetable in the export) */ wait: number;
  /** share of the speed limit kept on ordinary streets / on highways (traffic, signals) */ street: number; highway: number;
  /** delays at junctions: true for road vehicles */ junctions: boolean;
  /** lane vehicle type in the export whose speed limit applies */ vType: string;
}

export const MODES: Record<string, ModeParams> = {
  bus: { cap: 80, accel: 1.0, brake: 1.3, dwell: 20, wait: 180, street: 0.8, highway: 0.95, junctions: true, vType: 'Car' },
  tram: { cap: 60, accel: 1.0, brake: 1.2, dwell: 20, wait: 150, street: 0.85, highway: 0.85, junctions: true, vType: 'Tram' },
  metro: { cap: 90, accel: 1.0, brake: 1.1, dwell: 25, wait: 120, street: 1, highway: 1, junctions: false, vType: 'Metro' },
  train: { cap: 140, accel: 0.6, brake: 0.8, dwell: 40, wait: 240, street: 1, highway: 1, junctions: false, vType: 'Train' },
  monorail: { cap: 80, accel: 0.9, brake: 1.0, dwell: 20, wait: 120, street: 1, highway: 1, junctions: false, vType: 'Monorail' },
  ferry: { cap: 30, accel: 0.25, brake: 0.3, dwell: 60, wait: 300, street: 1, highway: 1, junctions: false, vType: 'Ferry' },
  cablecar: { cap: 22, accel: 0.5, brake: 0.5, dwell: 30, wait: 90, street: 1, highway: 1, junctions: false, vType: 'CableCar' },
};
export const modeParams = (mode: string) => MODES[mode] ?? MODES.bus;

export interface Piece {
  len: number;
  /** posted limit for this vehicle type, km/h (0 = unknown) */ limit: number;
  highway: boolean;
  /** junction at the END of this piece (not the last piece of a hop): degree and turn angle in degrees */
  junction?: { degree: number; turn: number };
}

/** In-vehicle seconds for one hop between consecutive stops (dwell not included). */
export function hopTime(pieces: Piece[], mode: string): number {
  const p = modeParams(mode);
  let L = 0, cruise = 0, junction = 0;
  for (const s of pieces) {
    const limit = s.limit > 0 ? s.limit : 50;
    const v = (Math.min(limit, p.cap) * (s.highway ? p.highway : p.street)) / 3.6;
    L += s.len; cruise += s.len / v;
    if (p.junctions && s.junction && s.junction.degree >= 3) {
      const t = Math.abs(s.junction.turn);
      junction += 4 + (t < 30 ? 0 : t < 150 ? (s.junction.turn < 0 ? 5 : 9) : 20); // signals/yield + slowing to turn (right < left)
    }
  }
  if (L <= 0) return 0;
  const v = L / cruise; // effective cruise speed over the hop
  const accelDist = (v * v) / (2 * p.accel) + (v * v) / (2 * p.brake);
  const run = L >= accelDist
    ? cruise + v / (2 * p.accel) + v / (2 * p.brake)        // time lost speeding up and slowing down
    : Math.sqrt((2 * L * (p.accel + p.brake)) / (p.accel * p.brake)); // never reaches cruise speed
  return run + junction;
}

/** Ride time for a leg of `hops` consecutive hops: hop times plus dwell at the stops in between. */
export function legRideTime(hopTimes: number[], mode: string): number {
  return hopTimes.reduce((a, b) => a + b, 0) + modeParams(mode).dwell * Math.max(0, hopTimes.length - 1);
}

export function demo() {
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  // 1 km of 50 km/h street, bus: cruise 1000/(40/3.6)=90 s + accel/brake loss ≈ 5.6+4.3 s
  const t = hopTime([{ len: 1000, limit: 50, highway: false }], 'bus');
  if (!near(t, 99.8, 1)) throw new Error('bus hop ' + t);
  // very short hop never reaches cruise speed: triangle profile
  const s = hopTime([{ len: 40, limit: 150, highway: false }], 'metro');
  if (!near(s, Math.sqrt((2 * 40 * 2.1) / 1.1), 0.01)) throw new Error('triangle ' + s);
  // the vehicle cap applies: 2 km of 150 km/h track for a metro runs at 90 km/h
  const m = hopTime([{ len: 2000, limit: 150, highway: false }], 'metro');
  if (!near(m, 2000 / 25 + 25 / 2 + 25 / 2.2, 0.5)) throw new Error('cap ' + m);
  // junctions only slow road vehicles
  const j = { len: 500, limit: 50, highway: false, junction: { degree: 4, turn: 90 } };
  if (hopTime([j, { len: 500, limit: 50, highway: false }], 'bus') - hopTime([{ ...j, junction: undefined }, { len: 500, limit: 50, highway: false }], 'bus') !== 13) throw new Error('junction');
  return 'transit-time checks passed';
}
