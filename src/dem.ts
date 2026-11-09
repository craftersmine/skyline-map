import * as maplibregl from 'maplibre-gl';
import { HALF, MAP_SIZE } from './geo';

// Serves the game heightmap as Terrarium-encoded raster-dem tiles through a
// custom protocol, so MapLibre's native hillshade, color-relief and 3D
// terrain work directly on game data.

let dem: { surface: Float32Array; size: number } | null = null;
const EARTH = 40075016.68557849;

// tile requests wait for the heightmap instead of caching flat placeholder tiles
let resolveReady: () => void = () => {};
let ready = new Promise<void>((r) => (resolveReady = r));
export function setDem(d: { surface: Float32Array; size: number }) { dem = d; resolveReady(); }

// Catmull-Rom bicubic sample: avoids the diamond artefacts bilinear
// interpolation leaves in hillshading when the 16 m grid is overzoomed.
function cubic(p0: number, p1: number, p2: number, p3: number, t: number) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function sample(x: number, z: number): number {
  const { surface, size } = dem!;
  const cell = MAP_SIZE / (size - 1);
  const gx = Math.max(0, Math.min(size - 1, (x + HALF) / cell));
  const gz = Math.max(0, Math.min(size - 1, (z + HALF) / cell));
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  const at = (a: number, b: number) => surface[Math.max(0, Math.min(size - 1, b)) * size + Math.max(0, Math.min(size - 1, a))];
  const row = (b: number) => cubic(at(i - 1, b), at(i, b), at(i + 1, b), at(i + 2, b), fx);
  return cubic(row(j - 1), row(j), row(j + 1), row(j + 2), fz);
}

/** Ground/water-surface height in metres at a game position, or null before a map is loaded. */
export function elevationAt(x: number, z: number): number | null { return dem ? sample(x, z) : null; }

let registered = false;
export function registerDemProtocol() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('csldem', async (params) => {
    const m = /csldem:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error('bad dem url');
    await ready;
    const z = +m[1], tx = +m[2], ty = +m[3];
    const N = 512, size = EARTH / 2 ** z; // must match the source tileSize
    const x0 = -EARTH / 2 + tx * size, y0 = EARTH / 2 - ty * size;
    const canvas = new OffscreenCanvas(N, N);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    const d = img.data;
    for (let py = 0; py < N; py++) {
      const wz = y0 - ((py + 0.5) / N) * size;
      for (let px = 0; px < N; px++) {
        const wx = x0 + ((px + 0.5) / N) * size;
        const v = sample(wx, wz) + 32768;
        const o = (py * N + px) * 4;
        d[o] = Math.floor(v / 256); d[o + 1] = Math.floor(v) % 256; d[o + 2] = Math.floor((v - Math.floor(v)) * 256); d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}
