// Self-check for the geometry core. Run: npm run check
import assert from 'node:assert/strict';
import { isolines, assemblePolygons, ringArea, mergeChains, toLngLat, fromLngLat, distToRing, nearestOnLine, type XY } from './geo.ts';

// projection round-trips in metres
for (const [x, z] of [[0, 0], [8640, -8640], [-1234.5, 4321]]) {
  const [lng, lat] = toLngLat(x, z);
  const [bx, bz] = fromLngLat(lng, lat);
  assert.ok(Math.abs(bx - x) < 0.02 && Math.abs(bz - z) < 0.02, `round trip ${x},${z}`);
}

// a 6x6 grid with a filled 4x4 square that has a 1-cell hole → one polygon with one hole
const w = 7, h = 7, g = new Float32Array(w * h);
for (let j = 1; j <= 5; j++) for (let i = 1; i <= 5; i++) g[j * w + i] = 1;
g[3 * w + 3] = 0;
const chains = isolines(g, w, h, 0.5, true);
assert.ok(chains.every((c) => c.closed), 'padded chains are closed');
const polys = assemblePolygons(chains.map((c) => c.pts), 0.01);
assert.equal(polys.length, 1, 'one outer ring');
assert.equal(polys[0].length, 2, 'outer ring + hole');
assert.ok(ringArea(polys[0][0]) > 0 && ringArea(polys[0][1]) < 0, 'outer CCW, hole CW');

// segments a-b, b-c join into one street; a junction (3 parts at d) stops the chain
const P = (x: number): XY => [x, 0];
const merged = mergeChains([
  { a: 1, b: 2, pts: [P(0), P(1)] },
  { a: 3, b: 2, pts: [P(2), P(1)] },
  { a: 3, b: 4, pts: [P(2), P(3)] },
  { a: 4, b: 5, pts: [P(3), P(4)] }, { a: 4, b: 6, pts: [P(3), [3, 1]] },
]);
assert.ok(merged.some((c) => c.length === 4 && c[0][0] === 0 && c[3][0] === 3), 'chain 1-2-3-4 merged in order');
assert.equal(merged.length, 3);

console.log('geo checks passed');
import('./transit-time.ts').then((m) => console.log(m.demo()));

// distance to a footprint: 0 inside, perpendicular to the nearest edge outside
{
  const sq: XY[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(distToRing([5, 5], sq), 0);
  assert.equal(distToRing([15, 5], sq), 5);
  assert.ok(Math.abs(distToRing([13, 14], sq) - 5) < 1e-9, 'corner distance');
}

// nearest point on a polyline: projects onto the right piece and measures along the line
{
  const line: XY[] = [[0, 0], [10, 0], [10, 10]];
  const a = nearestOnLine([4, 3], line);
  assert.deepEqual([a.pt, a.d, a.along, a.i], [[4, 0], 3, 4, 0]);
  const b = nearestOnLine([13, 6], line);
  assert.deepEqual([b.pt, b.d, b.along, b.i], [[10, 6], 3, 16, 1]);
  assert.equal(nearestOnLine([-5, 0], line).along, 0, 'clamped to the start');
}
