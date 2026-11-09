// Traffic-aware routing: how much slower a road is at the traffic density a save recorded.
//
// The game keeps only NetSegment.m_trafficDensity (0-100) per segment: vehicle length on the segment over the last
// 256 simulation frames (~5.6 in-game minutes) against 40% of its lane length, moved at most 5 points per update
// (RoadBaseAI.SimulationStep). Neither the game nor TM:PE turns it into a speed; the game only randomises route
// cost with it. So the curve below is measured: the speed of every private car in 19 saves from 4 cities (27,463
// cars), divided by its lane's speed limit, averaged per 10-point density band, made non-increasing, and expressed
// relative to the 0-10 band (free flow). Leave-one-city-out validation and the derivation are in
// docs/research/traffic-model.md. It is an estimate for a road's typical slowdown at that density, not a live speed.

/** [density %, travel-time multiplier] at band mid-points; linear in between, flat outside */
export const TRAFFIC_CURVE: readonly [number, number][] = [
  [5, 1], [15, 1.06], [25, 1.1], [35, 1.11], [45, 1.16], [55, 1.56], [65, 1.85], [75, 2.09], [85, 2.29], [95, 3.57],
];

/** travel-time multiplier (≥ 1) for a segment at `pct` density */
export function trafficFactor(pct: number): number {
  const c = TRAFFIC_CURVE;
  if (!(pct > c[0][0])) return 1; // also NaN
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i];
    if (pct <= x1) { const [x0, y0] = c[i - 1]; return y0 + ((y1 - y0) * (pct - x0)) / (x1 - x0); }
  }
  return c[c.length - 1][1];
}
