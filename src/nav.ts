// Navigation simulation: the timing and geometry behind a virtual drive along a calculated route.
// Everything here comes from the route the router returned: its line, its roads (spans) and its steps.
// The drive speed follows each road's own driving time (limits, town factor, traffic when on), slows for
// bends and junctions by their geometry, and accelerates/brakes smoothly. Nothing is added that the route
// doesn't hold: no lanes, no extra names, no extra turns.
import type { Route, Span } from './router';
import { fromLngLat, type XY } from './geo';

export interface Maneuver { at: number; man: string; text: string; road: string }
/** a road of the route along the line, with the speed the route's driving time counts on it (m/s) */
export interface NavSpan { s0: number; s1: number; name: string; cls: string; brunnel: string; limit?: number; v: number }
export interface NavPlan {
  /** route line in game metres (x east, z north) and the distance along it at each point */
  pts: XY[]; cum: Float64Array; total: number;
  /** speed profile: one sample every `ds` metres, speed in m/s and seconds from the start */
  ds: number; v: Float32Array; tau: Float64Array;
  /** seconds the profile takes, and the route's own estimate it is scaled to (`k` = time / physTime) */
  physTime: number; time: number; k: number;
  /** the route's distance (what the route card shows) */
  dist: number;
  maneuvers: Maneuver[];
  spans: NavSpan[];
}

const A_LAT = 2.5, ACCEL = 1.6, BRAKE = 2.0, V_MIN = 2.5, V_LINK = 6;
const wrap = (d: number) => ((d + 540) % 360) - 180;

/** The plan for a driving route, or null when it has no line to follow. */
export function buildPlan(r: Route): NavPlan | null {
  const leg = r.legs[0];
  if (!leg || r.mode !== 'drive' || leg.coords.length < 2) return null;
  const pts: XY[] = [];
  for (const c of leg.coords) {
    const p = fromLngLat(c[0], c[1]);
    // joins repeat a point; zero-length pieces would break headings
    if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]) > 0.05) pts.push(p);
  }
  if (pts.length < 2) return null;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const total = cum[pts.length - 1];
  if (total < 1) return null;

  // spans index the raw coords (with repeats): place each by its first point instead
  const spans = placeSpans(leg.spans ?? [], leg.coords.map((c) => fromLngLat(c[0], c[1])), pts, cum);
  const plan: NavPlan = { pts, cum, total, ds: 0, v: new Float32Array(0), tau: new Float64Array(0), physTime: 0, time: r.time, k: 1, dist: r.dist, maneuvers: [], spans };
  profile(plan);
  plan.maneuvers = placeManeuvers(plan, leg.steps);
  return plan;
}

function placeSpans(raw: Span[], coords: XY[], pts: XY[], cum: Float64Array): NavSpan[] {
  const out: NavSpan[] = [];
  let j = 0;
  for (let k = 0; k < raw.length; k++) {
    const sp = raw[k], c = coords[Math.min(sp.i, coords.length - 1)];
    while (j < pts.length - 1 && Math.hypot(pts[j][0] - c[0], pts[j][1] - c[1]) > 0.05) j++;
    out.push({ s0: cum[j], s1: 0, name: sp.name, cls: sp.cls, brunnel: sp.brunnel, limit: sp.limit, v: sp.v });
  }
  // a span ends where the next starts; the last one where the line meets the destination link
  for (let k = 0; k < out.length; k++) out[k].s1 = k + 1 < out.length ? out[k + 1].s0 : cum[Math.max(0, pts.length - 2)];
  return out;
}

/** Point and segment index at distance s along the line. */
export function pointAt(p: NavPlan, s: number): { xy: XY; i: number } {
  const { cum, pts } = p;
  if (s <= 0) return { xy: pts[0], i: 0 };
  if (s >= p.total) return { xy: pts[pts.length - 1], i: pts.length - 2 };
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return { xy: [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f], i: lo };
}
/** Compass bearing (degrees clockwise from north) from distance a to distance b along the line. */
export function bearing(p: NavPlan, a: number, b: number): number {
  const P = pointAt(p, Math.max(0, a)).xy, Q = pointAt(p, Math.min(p.total, b)).xy;
  return (Math.atan2(Q[0] - P[0], Q[1] - P[1]) * 180) / Math.PI;
}
export const spanAt = (p: NavPlan, s: number): NavSpan | null => {
  for (const sp of p.spans) if (s >= sp.s0 && s < sp.s1) return sp;
  return null;
};

/** Speed cap per sample (road time, bends), then smooth acceleration and braking; times from the speeds. */
function profile(p: NavPlan) {
  const n = Math.max(2, Math.ceil(p.total / (p.total > 80_000 ? 10 : 4)) + 1);
  const ds = p.total / (n - 1);
  // bends are measured over 24 m: wider than the export's point spacing (median ~19 m), so a vertex isn't read as a corner
  const v = new Float32Array(n), W = 24;
  let si = 0;
  const sp = p.spans;
  for (let j = 0; j < n; j++) {
    const s = j * ds;
    while (si < sp.length && s >= sp[si].s1) si++;
    // the drive-up links at both ends have no road of their own: no faster than the road they join
    const road = si < sp.length && s >= sp[si].s0 ? sp[si].v : Math.min(V_LINK, sp[Math.min(si, sp.length - 1)]?.v ?? V_LINK);
    const turn = Math.abs(wrap(bearing(p, s, s + W) - bearing(p, s - W, s))) * Math.PI / 180;
    const bend = turn > 0.01 ? Math.sqrt(A_LAT * (W / turn)) : Infinity;
    v[j] = Math.min(road, Math.max(V_MIN, bend));
  }
  v[0] = 0; v[n - 1] = 0;
  for (let j = 1; j < n; j++) v[j] = Math.min(v[j], Math.sqrt(v[j - 1] ** 2 + 2 * ACCEL * ds));
  for (let j = n - 2; j >= 0; j--) v[j] = Math.min(v[j], Math.sqrt(v[j + 1] ** 2 + 2 * BRAKE * ds));
  const tau = new Float64Array(n);
  for (let j = 1; j < n; j++) tau[j] = tau[j - 1] + (2 * ds) / Math.max(0.2, v[j - 1] + v[j]);
  p.ds = ds; p.v = v; p.tau = tau; p.physTime = tau[n - 1];
  p.k = p.time > 0 ? p.time / p.physTime : 1;
}

/** Distance and speed (profile m/s) at profile time τ, moving with constant acceleration inside each sample. */
export function stateAt(p: NavPlan, t: number): { s: number; v: number } {
  const { tau, v, ds } = p, n = tau.length;
  if (t <= 0) return { s: 0, v: 0 };
  if (t >= tau[n - 1]) return { s: p.total, v: 0 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tau[m] <= t) lo = m; else hi = m; }
  const v0 = v[lo], v1 = v[hi], dt = t - tau[lo], span = tau[hi] - tau[lo];
  const a = (v1 - v0) / (span || 1);
  return { s: Math.min(lo * ds + v0 * dt + 0.5 * a * dt * dt, hi * ds), v: v0 + a * dt };
}
/** Profile time at distance s (inverse of stateAt). */
export function timeAt(p: NavPlan, s: number): number {
  const { tau, v, ds } = p, n = tau.length;
  if (s <= 0) return 0;
  if (s >= p.total) return tau[n - 1];
  const j = Math.min(n - 2, Math.floor(s / ds)), v0 = v[j], v1 = v[j + 1], span = tau[j + 1] - tau[j];
  const a = (v1 - v0) / (span || 1), x = s - j * ds;
  const dt = Math.abs(a) < 1e-6 ? x / Math.max(0.1, v0) : (-v0 + Math.sqrt(Math.max(0, v0 * v0 + 2 * a * x))) / a;
  return tau[j] + Math.min(span, Math.max(0, dt));
}

/** Where along the line each step happens. The step's own point, searched near where its distances put it. */
function placeManeuvers(p: NavPlan, steps: Route['legs'][number]['steps']): Maneuver[] {
  const out: Maneuver[] = [];
  const link = p.cum[1] ?? 0; // the drive-up from the chosen point to the road comes before the first step
  let expect = link, prev = 0;
  steps.forEach((st, i) => {
    const at = fromLngLat(st.at[0], st.at[1]);
    if (st.maneuver === 'depart' || i === 0) { expect += st.dist; return; }
    let s: number;
    if (st.maneuver === 'arrive') s = p.total;
    else {
      // nearest point on the line from the previous maneuver on, preferring the one the step distances predict
      let best = Infinity; s = prev;
      for (let k = 0; k + 1 < p.pts.length; k++) {
        if (p.cum[k + 1] < prev) continue;
        const a = p.pts[k], b = p.pts[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
        const f = l2 ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / l2)) : 0;
        const along = Math.max(prev, p.cum[k] + f * Math.sqrt(l2));
        const d = Math.hypot(at[0] - (a[0] + f * dx), at[1] - (a[1] + f * dz));
        const score = d + 0.05 * Math.abs(along - expect);
        if (score < best) { best = score; s = along; }
      }
    }
    out.push({ at: s, man: st.maneuver, text: st.text, road: st.road ?? '' });
    prev = s; expect = s + st.dist;
  });
  if (!out.length || out[out.length - 1].man !== 'arrive') out.push({ at: p.total, man: 'arrive', text: '', road: '' });
  return out;
}

/** Index of the next maneuver ahead of s (the arrival at the end). A maneuver stays current until just past it. */
export function nextManeuver(p: NavPlan, s: number): number {
  const m = p.maneuvers;
  for (let i = 0; i < m.length; i++) if (m[i].at > s - 3) return i;
  return m.length - 1;
}
