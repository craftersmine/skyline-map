// "How far can I get": travel times from one point, spread from the network's nodes onto a grid so the page
// can draw them as soft time bands. Times are seconds; Infinity = not reached.
import { HALF, type XY } from './geo';

export const REACH_CELL = 30; // m
const WALK = 1.35; // m/s, for the last stretch off the network
const OFF = 300; // m: how far from the network a place still counts as reached (on foot)

export interface ReachGrid { x0: number; z0: number; w: number; h: number; cell: number; t: Float32Array; max: number }

/**
 * Spread node times onto a grid: a cell is reached at the best node time plus the walk to it, within 300 m of
 * the network. Only the box around reached cells is returned.
 */
export function reachGrid(pos: XY[], times: Float64Array, max: number): ReachGrid | null {
  const n = Math.ceil((2 * HALF) / REACH_CELL);
  const g = new Float32Array(n * n).fill(Infinity);
  let x0 = n, z0 = n, x1 = -1, z1 = -1;
  for (let i = 0; i < pos.length; i++) {
    const t0 = times[i];
    if (!(t0 <= max)) continue;
    const r = Math.min(OFF, (max - t0) * WALK);
    const cx = (pos[i][0] + HALF) / REACH_CELL, cz = (pos[i][1] + HALF) / REACH_CELL;
    const rc = r / REACH_CELL;
    const ia = Math.max(0, Math.floor(cx - rc)), ib = Math.min(n - 1, Math.ceil(cx + rc));
    const ja = Math.max(0, Math.floor(cz - rc)), jb = Math.min(n - 1, Math.ceil(cz + rc));
    for (let j = ja; j <= jb; j++) for (let k = ia; k <= ib; k++) {
      const d = Math.hypot((k + 0.5 - cx) * REACH_CELL, (j + 0.5 - cz) * REACH_CELL);
      if (d > r) continue;
      const v = t0 + d / WALK, o = j * n + k;
      if (v < g[o]) {
        g[o] = v;
        if (k < x0) x0 = k; if (k > x1) x1 = k; if (j < z0) z0 = j; if (j > z1) z1 = j;
      }
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = z1 - z0 + 1, t = new Float32Array(w * h);
  for (let j = 0; j < h; j++) t.set(g.subarray((z0 + j) * n + x0, (z0 + j) * n + x0 + w), j * w);
  return { x0, z0, w, h, cell: REACH_CELL, t, max };
}
