// Estimated districts drawn as soft regions instead of sharp polygons. CSLMapView exports no district
// shapes, so a district is shown as a translucent presence that is strongest around its own evidence (its
// label and the transit stops that record it) and fades out with distance from that evidence and toward the
// neighbouring district's evidence: where two districts' samples are about equally near, both are faint.
import type { Map as MLMap } from 'maplibre-gl';
import { HALF, toLngLat, type XY } from './geo';

export interface DistrictField { n: number; cell: number; l1: Int32Array; d1: Float32Array; l2: Int32Array; d2: Float32Array; land: Uint8Array }

const SRC = 'district-glow', LAYER = 'district-glow';
const REACH = 600;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * How strongly a cell belongs to district `id`, 0..1: the margin over the nearest other district (a soft edge
 * about ±80 m wide instead of a line), times a fade with distance from its own evidence, on land only. Then
 * smoothed over neighbouring cells so the 33.75 m grid never shows.
 */
export function membership(f: DistrictField, id: number) {
  const { n, l1, d1, l2, d2, land } = f;
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  for (let k = 0; k < l1.length; k++) if (l1[k] === id || l2[k] === id) { const i = k % n, j = (k / n) | 0; if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
  if (x1 < 0) return null;
  const pad = 3;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(n - 1, x1 + pad); y1 = Math.min(n - 1, y1 + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  let m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y0 + y) * n + (x0 + x);
    let own = Infinity, other = Infinity;
    if (l1[k] === id) { own = d1[k]; other = l2[k] >= 0 ? d2[k] : REACH * 1.5; }
    else if (l2[k] === id) { own = d2[k]; other = d1[k]; }
    if (!Number.isFinite(own) || own > REACH) continue;
    const edge = smooth(-80, 80, other - own);
    const fade = 1 - smooth(120, REACH, own);
    m[y * w + x] = edge * fade * (land[k] ? 1 : 0);
  }
  // two passes of a 3 x 3 blur: soft at the scale of a block, not a smear
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; s += m[yy * w + xx]; c++; }
      o[y * w + x] = s / c;
    }
    m = o;
  }
  return { m, w, h, x0, y0 };
}

const corners = (f: DistrictField, x0: number, y0: number, w: number, h: number): [XY, XY, XY, XY] => {
  const X = (i: number) => i * f.cell - HALF, Z = (j: number) => j * f.cell - HALF;
  // image rows run top to bottom = north to south = high z to low z
  return [toLngLat(X(x0), Z(y0 + h)), toLngLat(X(x0 + w), Z(y0 + h)), toLngLat(X(x0 + w), Z(y0)), toLngLat(X(x0), Z(y0))];
};

export function clearDistrictGlow(map: MLMap) {
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SRC)) map.removeSource(SRC);
}

/**
 * Draw district `id` as a soft region in the given colour (#rrggbb), under water, roads, buildings and transit
 * so it tints the ground without covering anything. (Compared on Sarrant against nested translucent bands, which
 * read as contour lines and so as precise edges, and a glow around the evidence alone, which looked like a
 * heatmap and ignored where the neighbours are.)
 */
export function showDistrictGlow(map: MLMap, f: DistrictField, id: number, color: string, night = false) {
  clearDistrictGlow(map);
  const r = membership(f, id);
  if (!r) return;
  const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const peak = night ? 0.34 : 0.38;
  const small = document.createElement('canvas'); small.width = r.w; small.height = r.h;
  const sc = small.getContext('2d')!, img = sc.createImageData(r.w, r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const o = ((r.h - 1 - y) * r.w + x) * 4; // flip: grid row 0 is the south edge, image row 0 the north
    img.data[o] = cr; img.data[o + 1] = cg; img.data[o + 2] = cb; img.data[o + 3] = Math.round(255 * peak * r.m[y * r.w + x]);
  }
  sc.putImageData(img, 0, 0);
  // upsample 6x with smoothing so the fade stays smooth at street zoom, where a 33.75 m cell is large
  const S = 6, cv = document.createElement('canvas'); cv.width = r.w * S; cv.height = r.h * S;
  const c = cv.getContext('2d')!; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(small, 0, 0, cv.width, cv.height);
  map.addSource(SRC, { type: 'image', url: cv.toDataURL('image/png'), coordinates: corners(f, r.x0, r.y0, r.w, r.h) });
  map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, map.getLayer('water') ? 'water' : undefined);
}
