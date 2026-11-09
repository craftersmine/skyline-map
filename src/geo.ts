// Geometry helpers. Game space is metres with x = east, z = north.
// We project it onto Web Mercator at the equator, where one metre in game
// space is exactly one metre of map scale, so fill-extrusion heights, scale
// bars and widths all stay physically correct.

export type XY = [number, number];

const R = 6378137;
const DEG = 180 / Math.PI;

export const HALF = 8640; // 9x9 tiles of 1920 m
export const MAP_SIZE = HALF * 2;

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

export function toLngLat(x: number, z: number): XY {
  return [r7((x / R) * DEG), r7((2 * Math.atan(Math.exp(z / R)) - Math.PI / 2) * DEG)];
}

export function fromLngLat(lng: number, lat: number): XY {
  return [(lng / DEG) * R, R * Math.log(Math.tan(Math.PI / 4 + lat / DEG / 2))];
}

export const ringArea = (r: XY[]): number => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // positive = counter-clockwise
};

export function pointInRing(p: XY, r: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas-Peucker on an open polyline. */
export function simplify(pts: XY[], tol: number): XY[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting. Closed rings stay closed (first == last). */
export function chaikin(pts: XY[], closed: boolean, iterations = 1): XY[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out: XY[] = [];
    const n = closed ? p.length - 1 : p.length;
    if (!closed) out.push(p[0]);
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = p[i], b = p[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (closed) out.push(out[0]); else out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/**
 * Marching squares iso-band extraction. Returns chains in grid coordinates;
 * inside (value >= t) is always on the left, so outer rings are CCW and holes CW.
 * With `pad` the grid is surrounded by -Infinity so every chain is a closed ring.
 */
export function isolines(v: ArrayLike<number>, w: number, h: number, t: number, pad: boolean): { pts: XY[]; closed: boolean }[] {
  const W = pad ? w + 2 : w, H = pad ? h + 2 : h;
  const get = pad
    ? (i: number, j: number) => (i <= 0 || j <= 0 || i >= W - 1 || j >= H - 1 ? -1e9 : v[(j - 1) * w + (i - 1)])
    : (i: number, j: number) => v[j * w + i];
  const off = pad ? 1 : 0;
  // edge ids: horizontal edge (i,j)->(i+1,j) = 2*(j*W+i); vertical (i,j)->(i,j+1) = 2*(j*W+i)+1
  const next = new Map<number, number>();
  const point = (e: number): XY => {
    const k = e >> 1, i = k % W, j = (k / W) | 0;
    const a = get(i, j);
    if (e & 1) { const b = get(i, j + 1); return [i - off, j - off + (t - a) / (b - a)]; }
    const b = get(i + 1, j); return [i - off + (t - a) / (b - a), j - off];
  };
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = get(i, j), b = get(i + 1, j), c = get(i + 1, j + 1), d = get(i, j + 1);
      const code = (a >= t ? 1 : 0) | (b >= t ? 2 : 0) | (c >= t ? 4 : 0) | (d >= t ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const e0 = 2 * (j * W + i), e2 = 2 * ((j + 1) * W + i), e3 = e0 + 1, e1 = 2 * (j * W + i + 1) + 1;
      const seg = (from: number, to: number) => next.set(from, to);
      switch (code) {
        case 1: seg(e0, e3); break;
        case 2: seg(e1, e0); break;
        case 3: seg(e1, e3); break;
        case 4: seg(e2, e1); break;
        case 5: if ((a + b + c + d) / 4 >= t) { seg(e0, e1); seg(e2, e3); } else { seg(e0, e3); seg(e2, e1); } break;
        case 6: seg(e2, e0); break;
        case 7: seg(e2, e3); break;
        case 8: seg(e3, e2); break;
        case 9: seg(e0, e2); break;
        case 10: if ((a + b + c + d) / 4 >= t) { seg(e3, e0); seg(e1, e2); } else { seg(e1, e0); seg(e3, e2); } break;
        case 11: seg(e1, e2); break;
        case 12: seg(e3, e1); break;
        case 13: seg(e0, e1); break;
        case 14: seg(e3, e0); break;
      }
    }
  }
  const out: { pts: XY[]; closed: boolean }[] = [];
  const hasPrev = new Set<number>(next.values());
  const walk = (start: number) => {
    const pts: XY[] = [point(start)];
    let e = start, closed = false;
    for (;;) {
      const n = next.get(e);
      if (n === undefined) break;
      next.delete(e);
      if (n === start) { closed = true; pts.push(pts[0]); break; }
      pts.push(point(n));
      e = n;
    }
    out.push({ pts, closed });
  };
  for (const s of [...next.keys()]) if (!hasPrev.has(s) && next.has(s)) walk(s); // open chains first
  for (const s of [...next.keys()]) if (next.has(s)) walk(s);
  return out;
}

/** Turn CCW outer rings + CW holes into polygons (array of rings). */
export function assemblePolygons(rings: XY[][], minArea: number): XY[][][] {
  const outers: { ring: XY[]; area: number; holes: XY[][]; bbox: number[] }[] = [];
  const holes: XY[][] = [];
  for (const r of rings) {
    if (r.length < 4) continue;
    const a = ringArea(r);
    if (Math.abs(a) < minArea) continue;
    if (a > 0) outers.push({ ring: r, area: a, holes: [], bbox: bbox(r) });
    else holes.push(r);
  }
  outers.sort((x, y) => x.area - y.area);
  for (const hRing of holes) {
    const p = hRing[0];
    for (const o of outers) {
      if (p[0] < o.bbox[0] || p[0] > o.bbox[2] || p[1] < o.bbox[1] || p[1] > o.bbox[3]) continue;
      if (pointInRing(p, o.ring)) { o.holes.push(hRing); break; }
    }
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}

function bbox(r: XY[]) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}

/** Separable box blur, used to soften density grids before contouring. */
export function blur(src: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const x = i + k; if (x >= 0 && x < w) { s += src[j * w + x]; n++; } }
      tmp[j * w + i] = s / n;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const y = j + k; if (y >= 0 && y < h) { s += tmp[y * w + i]; n++; } }
      out[j * w + i] = s / n;
    }
  }
  return out;
}

/**
 * Merge polylines that share endpoints (keyed by node id) into longer chains.
 * Chains only continue through nodes where exactly two parts meet, so
 * labels follow a street instead of jumping across junctions.
 */
export function mergeChains<T extends { a: number; b: number; pts: XY[] }>(parts: T[]): XY[][] {
  const byNode = new Map<number, number[]>();
  parts.forEach((p, i) => {
    for (const n of [p.a, p.b]) { const l = byNode.get(n); if (l) l.push(i); else byNode.set(n, [i]); }
  });
  const used = new Uint8Array(parts.length);
  // returns parts walked from `node`, each oriented to start at the previous end
  const walk = (node: number): XY[][] => {
    const seq: XY[][] = [];
    for (;;) {
      const all = byNode.get(node)!;
      if (all.length !== 2) break;
      const k = all.find((i) => !used[i]);
      if (k === undefined) break;
      used[k] = 1;
      const q = parts[k];
      seq.push(q.a === node ? q.pts : [...q.pts].reverse());
      node = q.a === node ? q.b : q.a;
    }
    return seq;
  };
  const out: XY[][] = [];
  parts.forEach((p, i) => {
    if (used[i]) return;
    used[i] = 1;
    const chain: XY[] = [...p.pts];
    for (const s of walk(p.b)) chain.push(...s.slice(1));
    for (const s of walk(p.a)) chain.unshift(...[...s].reverse().slice(0, -1));
    out.push(chain);
  });
  return out;
}

export function polylineLength(p: XY[]): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

/** Distance from p to a closed ring: 0 inside, else to its nearest edge. */
export function distToRing(p: XY, r: XY[]): number {
  if (r.length >= 3 && pointInRing(p, r)) return 0;
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[j], [bx, bz] = r[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz));
  }
  return best;
}

/** Nearest point on a polyline to p: the point, its distance, metres along the line, and the piece index it lies on. */
export function nearestOnLine(p: XY, pts: XY[]): { pt: XY; d: number; along: number; i: number } {
  let best = { pt: pts[0], d: Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]), along: 0, i: 0 };
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / l2)) : 0;
    const q: XY = [ax + t * dx, az + t * dz], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) best = { pt: q, d, along: run + t * l, i };
    run += l;
  }
  return best;
}
