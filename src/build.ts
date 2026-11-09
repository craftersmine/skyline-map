import type { SchemInput } from './schematic';
import type { CityData, CSeg, CSegType, CBuilding, Vec3 } from './parse';
import type { OneWayResult } from './oneway';
import { boothLabel, type TollData } from './tolls';
import { HALF, MAP_SIZE, XY, pointInRing, distToRing, toLngLat, isolines, assemblePolygons, chaikin, simplify, blur, mergeChains, polylineLength } from './geo';

type Props = Record<string, string | number | boolean | null>;
interface Feature { type: 'Feature'; id?: number; properties: Props; geometry: { type: string; coordinates: unknown } }
export interface FC { type: 'FeatureCollection'; features: Feature[] }
const fc = (features: Feature[]): FC => ({ type: 'FeatureCollection', features });

export interface SearchEntry { name: string; kind: string; sub: string; center: XY; zoom: number; bbox?: [number, number, number, number] }

export interface BuiltCity {
  meta: {
    name: string; generated: string; bounds: [XY, XY];
    stats: Record<string, number>;
    elevation: { min: number; max: number };
    lines: { id: number; name: string; type: string; color: string; stops: number; bbox: [number, number, number, number] | null; stopNames?: string[]; shape?: 'both' | 'loop' }[];
  };
  sources: Record<string, FC>;
  dem: { surface: Float32Array; size: number };
  search: SearchEntry[];
  /** station name per stop node (kept in the worker for routing) */
  stopNames?: Map<number, string>;
  /** network for the schematic map (worker only, not sent to the page) */
  schem?: SchemInput;
}

const ll = (p: { x: number; z: number }) => toLngLat(p.x, p.z);
const llxy = (p: XY) => toLngLat(p[0], p[1]);
const hex = (c: number[]) => '#' + c.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');

/** cheap deterministic hash → [0,1) */
const rnd = (n: number) => { let x = (n * 2654435761) >>> 0; x ^= x >>> 13; x = Math.imul(x, 1274126177) >>> 0; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

export function makeTerrainSampler(city: CityData) {
  const n = city.terrainSize, cell = MAP_SIZE / (n - 1);
  const surface = new Float32Array(n * n);
  for (let i = 0; i < surface.length; i++) surface[i] = city.height[i] + city.water[i];
  const sample = (grid: Float32Array, x: number, z: number) => {
    const gx = Math.max(0, Math.min(n - 1.001, (x + HALF) / cell));
    const gz = Math.max(0, Math.min(n - 1.001, (z + HALF) / cell));
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j;
    const a = grid[j * n + i], b = grid[j * n + i + 1], c = grid[(j + 1) * n + i], d = grid[(j + 1) * n + i + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  };
  return { surface, cell, n, ground: (x: number, z: number) => sample(city.height, x, z), surf: (x: number, z: number) => sample(surface, x, z) };
}

// ---------------------------------------------------------------- roads ----

export interface RoadClass { cls: string; group: 'road' | 'path' | 'rail' | 'aero' | 'water' | 'ferry' | 'skip' | 'route'; rank: number }

/** Transit mode of a game line type. */
export const modeOf = (t: string) => (/Metro|Subway/i.test(t) ? 'metro' : /Train/i.test(t) ? 'train' : /Tram/i.test(t) ? 'tram' : /Monorail/i.test(t) ? 'monorail' : /Ship|Ferry/i.test(t) ? 'ferry' : /Cable/i.test(t) ? 'cablecar' : /Bus|Trolley|Evacuation|Taxi/i.test(t) ? 'bus' : /Pedestrian|Tour|Walking/i.test(t) ? 'tour' : /Plane|Blimp|Helicopter/i.test(t) ? 'air' : 'other');

export function laneInfo(st: CSegType | undefined) {
  if (!st) return { vehicle: 0, span: 0, tram: false, bike: false, oneway: false, center: 0, speed: 0 };
  let lo = Infinity, hi = -Infinity, vehicle = 0, tram = false, bike = false, fwd = 0, back = 0, speed = 0;
  for (const l of st.lanes) {
    if (l.type.includes('Vehicle') || l.type.includes('TransportVehicle') || l.vType.includes('Car') || l.vType.includes('Tram') || l.vType.includes('Bicycle') || l.vType.includes('Train') || l.vType.includes('Metro')) {
      const car = l.vType.split(',').some((v) => v.trim() === 'Car'); // not "CableCar"
      if (car || l.vType.includes('Tram')) { vehicle++; if (car) speed = Math.max(speed, l.speed); }
      if (l.vType.includes('Tram')) tram = true;
      if (l.vType.includes('Bicycle')) bike = true;
      if (l.dir === 'Forward' || l.dir === 'AvoidBackward') fwd++;
      if (l.dir === 'Backward' || l.dir === 'AvoidForward') back++;
      if (l.dir === 'Both') { fwd++; back++; }
      lo = Math.min(lo, l.pos - l.width / 2); hi = Math.max(hi, l.pos + l.width / 2);
    }
  }
  return { vehicle, span: hi > lo ? hi - lo : 0, tram, bike, oneway: vehicle > 0 && (fwd === 0 || back === 0), center: hi > lo ? (hi + lo) / 2 : 0, speed: Math.round(speed * 50) };
}

export function classify(seg: CSeg, st: CSegType | undefined, lanes: ReturnType<typeof laneInfo>): RoadClass {
  const n = seg.name, ic = seg.icls, both = n + ' ' + ic;
  if (seg.path) return { cls: 'route', group: 'route', rank: 0 };
  if (/ Line$|Line$/.test(ic) && !/Pipe/.test(ic)) return { cls: 'route', group: 'route', rank: 0 };
  if (/Runway/i.test(n)) return { cls: 'runway', group: 'aero', rank: 0 };
  if (/Airplane|Taxiway|Airport Area/i.test(both)) return { cls: 'taxiway', group: 'aero', rank: 0 };
  if (/Canal|River|Stream/i.test(both) && !/Road/.test(n)) return { cls: 'canal', group: 'water', rank: 0 };
  // a dam carries a road (car lanes + sidewalks): draw it as the road it connects
  if (/\bDam\b/.test(n) && lanes.vehicle > 0) return { cls: 'inherit', group: 'road', rank: 4 };
  // airport concourses are drawn as buildings (see buildCity), not as paths
  if (/Concourse/i.test(ic)) return { cls: 'concourse', group: 'skip', rank: 0 };
  // \bDam\b: a plain 'Dam' match also caught 'Damaged Road'
  if (/Quay|\bDam\b|Wall|Fence|Ruins|Rumble|stands|Pipe|Power ?Line|Electricity|Water Pipe|Heating|Flood/i.test(both)) return { cls: 'skip', group: 'skip', rank: 0 };
  if (/Ferry|Ship/i.test(both)) return { cls: /Path/.test(n) ? 'ferry' : 'skip', group: /Path/.test(n) ? 'ferry' : 'skip', rank: 0 };
  if (/CableCar|Cable Car/i.test(both)) return { cls: 'cablecar', group: 'rail', rank: 0 };
  // roads with a monorail in the median are roads (they carry car lanes); only bare track is rail
  if (/Monorail/i.test(both) && lanes.vehicle === 0) return { cls: 'monorail', group: 'rail', rank: 0 };
  if (/Metro/i.test(both) && lanes.vehicle === 0) return { cls: 'subway', group: 'rail', rank: 0 };
  if (/Tram Track|Tram Line/i.test(both) && lanes.vehicle <= 2 && !/Road|Avenue/i.test(n)) return { cls: 'tram', group: 'rail', rank: 0 };
  if (/Train|Rail(?!ing)|Railway|Track/i.test(both) && !/Race/i.test(both) && lanes.vehicle === 0) return { cls: 'rail', group: 'rail', rank: 0 }; // 'Monorail' roads also match /Rail/
  if (/Racetrack|Race ?Track/i.test(both)) return /Pavement|Highway|_Data/.test(both) && seg.width >= 6 ? { cls: 'raceway', group: 'road', rank: 2 } : { cls: 'skip', group: 'skip', rank: 0 };
  if (/Pedestrian Street|Promenade|PedRoad|Plaza/i.test(both)) return { cls: 'pedestrian', group: 'path', rank: 1 };
  if (/Pedestrian|Footpath|Path|Bicycle Path|Trail|Bridge/i.test(both) && lanes.vehicle === 0) return { cls: /Gravel|Trail/i.test(n) ? 'trail' : 'footway', group: 'path', rank: 0 };
  if (/Beautification/i.test(ic)) return seg.width >= 6 && /Pavement|Path/i.test(n) ? { cls: 'footway', group: 'path', rank: 0 } : { cls: 'skip', group: 'skip', rank: 0 };
  if (/Gravel/i.test(both)) return { cls: 'track', group: 'road', rank: 1 };
  if (st?.highway || /Highway/i.test(ic)) {
    if (/Ramp|Connection|Link/i.test(n)) return { cls: 'motorway_link', group: 'road', rank: 7 };
    if (/Two Lane Highway|Rural|1L|Highway1L|NExtHighway/i.test(both) && !/Four|2L2W/.test(both)) return { cls: 'trunk', group: 'road', rank: 7 };
    return { cls: 'motorway', group: 'road', rank: 9 };
  }
  if (lanes.vehicle === 0 && st && st.lanes.some((l) => l.type.includes('Pedestrian'))) return { cls: 'footway', group: 'path', rank: 0 };
  if (/Large Road|Large Avenue|Six Lane|6L|Boulevard/i.test(both) || lanes.vehicle >= 6) return { cls: 'primary', group: 'road', rank: 6 };
  if (/Medium Road|Avenue Large|Medium Avenue|Four Lane Road/i.test(both)) return { cls: 'secondary', group: 'road', rank: 5 };
  if (/Small 4 Lane|Small Avenue|4LRoad|Small4L|Busway|Asymmetrical|3 lane|Oneway3L/i.test(both) || lanes.vehicle >= 4) return { cls: 'tertiary', group: 'road', rank: 4 };
  if (/Alley|Bus Station|Bus Stop|Depot Road|Service|Parking|1LOneway|One-Lane|Harbor Road|Damaged/i.test(both)) return { cls: 'service', group: 'road', rank: 2 };
  if (/Road|Street|Oneway|Lane/i.test(both) || lanes.vehicle > 0) return { cls: 'minor', group: 'road', rank: 3 };
  return { cls: 'skip', group: 'skip', rank: 0 };
}

// ------------------------------------------------------------ buildings ----

interface BCat { cat: string; poi: string | null; height: number; inset: number }

function buildingCategory(b: CBuilding, area: number): BCat | null {
  const nm = b.name, srv = b.srv, sub = b.subsrv, ic = b.icls;
  if (/(?<!Concourse )Node Building|invisible|Underground Cable|cable_Data|powerpole|Pillar|pylon|Connection|Boulder|Rock |Ruins|Fence|_anim|Decoration|Taxi Stand|Pole|Marker|Spawn|Dummy|Placeholder|Track$/i.test(nm)) return null;
  if (/Airplane Path|Ship Path|Metro Track|Train Track/i.test(ic)) return null;
  if (/Concourse Node/i.test(nm)) return { cat: 'transport', poi: null, height: 14, inset: 0.99 }; // airport concourse junction
  if (/Apron/i.test(nm)) return { cat: 'apron', poi: null, height: 0, inset: 1 };                      // aircraft parking: flat tarmac
  const lvl = +(/Level ?(\d)/.exec(ic)?.[1] ?? 1);
  switch (srv) {
    case 'Residential':
      return sub.includes('High') ? { cat: 'residential_high', poi: null, height: 16 + lvl * 9, inset: 0.84 } : { cat: 'residential', poi: null, height: 6 + lvl * 0.8, inset: sub.includes('Eco') ? 0.6 : 0.64 };
    case 'Commercial':
      if (sub.includes('High')) return { cat: 'commercial', poi: null, height: 18 + lvl * 10, inset: 0.86 };
      if (sub.includes('Tourist') || sub.includes('Leisure')) return { cat: 'commercial', poi: null, height: 12, inset: 0.78 };
      return { cat: 'commercial', poi: null, height: 7 + lvl * 1.5, inset: 0.8 };
    case 'Office': return { cat: 'office', poi: null, height: 22 + lvl * 16, inset: 0.82 };
    case 'Industrial': return { cat: 'industrial', poi: null, height: 9 + lvl * 2, inset: 0.82 };
    case 'Education': return { cat: 'education', poi: 'school', height: /University|College/i.test(nm + ic) ? 18 : 12, inset: area > 3000 ? 0.55 : 0.68 };
    case 'HealthCare':
      if (/Cemetery|Crematory|DeathCare/i.test(nm + ic)) return { cat: 'cemetery', poi: 'cemetery', height: 4, inset: 0.3 };
      if (/Sport|Pool|Gym|Yoga|Spa|Sauna|Fitness/i.test(nm)) return { cat: 'sports', poi: 'sports', height: 9, inset: 0.6 };
      if (/Childcare|Eldercare/i.test(ic)) return { cat: 'health', poi: null, height: 8, inset: 0.6 };
      return { cat: 'health', poi: 'hospital', height: /Hospital|Medical Center/i.test(nm) ? 32 : 10, inset: 0.7 };
    case 'PoliceDepartment': return { cat: 'civic', poi: /Prison/i.test(ic + nm) ? 'prison' : 'police', height: 12, inset: 0.7 };
    case 'FireDepartment': return { cat: 'civic', poi: 'fire', height: 10, inset: 0.72 };
    case 'Monument': return { cat: 'landmark', poi: /\bsub\b|sub[_ ]|fence|glass|light|corner|wing|ground_|deco/i.test(nm) ? null : 'landmark', height: 30, inset: 0.82 };
    case 'PublicTransport':
      if (/Taxi|Pit|Hangar|Fuel|Lounge|Depot/i.test(nm)) return { cat: 'transport', poi: null, height: 9, inset: 0.82 };
      if (/Plane|Airport|Terminal/i.test(ic + nm) && area > 2000) return { cat: 'transport', poi: null, height: 18, inset: 0.86 };
      return { cat: 'transport', poi: null, height: 12, inset: 0.82 };
    case 'Beautification':
      if (sub.includes('Parks')) return { cat: 'park_building', poi: null, height: 4, inset: 0.8 };
      if (/Plaza|Square|Park|Garden|Fountain|Pavilion|Lawn/i.test(nm) && area > 200) return { cat: 'plaza', poi: null, height: 0, inset: 1 };
      return null;
    case 'Electricity':
      if (/Wind Turbine/i.test(nm)) return null;
      if (/Solar/i.test(nm)) return { cat: 'utility_open', poi: null, height: 2, inset: 0.9 };
      return { cat: 'utility', poi: null, height: 14, inset: 0.78 };
    case 'Water': case 'Garbage': case 'Road': case 'Disaster': case 'Fishing': case 'Natural':
      return { cat: 'utility', poi: null, height: 10, inset: 0.78 };
    case 'Tourism': case 'Museums': case 'Hotel':
      return { cat: 'commercial', poi: 'landmark', height: 24, inset: 0.82 };
    default:
      return area > 30 ? { cat: 'other', poi: null, height: 10, inset: 0.8 } : null;
  }
}

/** Asset sub-parts and placeholder names that make poor labels. */
const JUNK_NAME = /\bsub\s?[a-z0-9]*\b|fixed|window\d|carpark|parking|\bpart\b|piece|deco|prop|\bmale\b|\bfemale\b|test/i;
const isJunkName = (n: string) => JUNK_NAME.test(n) || /^[a-z]/.test(n) || /\d{2,}/.test(n);

/** Transit mode of a station building, or null if it is not a passenger station. */
function modeOfService(subsrv: string, icls: string, name: string): string | null {
  const t = subsrv + ' ' + icls + ' ' + name;
  if (/Taxi|Depot|Hangar|Fuel|Cargo|Lounge|Pit|Pillar|pylon|Entrance Sub/i.test(name) || /Cargo/i.test(icls)) return null;
  if (/Metro/i.test(t)) return 'metro';
  if (/Monorail/i.test(t)) return 'monorail';
  if (/Tram/i.test(t)) return 'tram';
  if (/Ship|Ferry/i.test(t)) return 'ferry';
  if (/CableCar/i.test(t)) return 'cablecar';
  if (/Train/i.test(t)) return 'train';
  return null;
}

function cleanName(nm: string): string {
  return nm.replace(/^\d{6,}\./, '').replace(/_Data$/, '').replace(/["“”]/g, '').replace(/\s+(by|from|made by)\s+\S.*$/i, '')
    .replace(/^(jp|BTB|DC|EU|US|NA|UK)\s+/i, '').replace(/[_]+/g, ' ').replace(/\s+(0?\d{1,2}|[A-Z]|v\d+(\.\d+)?)$/i, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Multi-part assets. The game links an asset's sub-buildings (station halls and
 * platforms, stadium stands, a mall's wings, balcony/glass overlays) into a
 * chain: the main building's `subb` names the first part, each part's `prntb`
 * the one before it and its `subb` the next. Every chain in the real exports
 * resolves cleanly (no dangling ids, no cycles), but chains run 10+ deep, so
 * `prntb` is *not* the main building: walk it back to the head. Returns
 * part id → head id (heads and single buildings are not in the map).
 */
export function buildingGroups(buildings: CBuilding[]): Map<number, number> {
  const parent = new Map<number, number>();
  for (const b of buildings) if (b.parent) parent.set(b.id, b.parent);
  const ids = new Set(buildings.map((b) => b.id));
  const head = new Map<number, number>();
  for (const id of parent.keys()) {
    const seen = new Set<number>([id]);
    let r = id;
    for (let p = parent.get(r); p !== undefined && ids.has(p) && !seen.has(p); p = parent.get(r)) { seen.add(p); r = p; }
    if (r !== id) head.set(id, r);
  }
  return head;
}

// ------------------------------------------------------------- districts ----

/**
 * Trustworthy district samples. The export has no district shapes, and only
 * public-transport nodes carry a real district id (road, path and water nodes
 * always say 0, even inside districts). Those transit nodes — inside a district
 * or explicitly outside (0) — plus each district's label point, which the game
 * places in the middle of the district, are the samples.
 */
export interface DistrictSample { x: number; z: number; dist: number }
export function districtSamples(city: CityData) {
  const out: DistrictSample[] = [];
  for (const n of city.nodes.values()) if (n.srv === 'PublicTransport') out.push(n);
  for (const d of city.districts) if (d.id && !(Math.abs(d.x) >= HALF - 1 && Math.abs(d.z) >= HALF - 1)) out.push({ x: d.x, z: d.z, dist: d.id });
  return out;
}
export function districtGrid(nodes: DistrictSample[], reach = 600, noneBias = 20) {
  const cell = MAP_SIZE / 512, n = 512;
  // distances in full precision: compared against the heap's own values, a Float32 copy rounds below them
  // about half the time and the cell is then skipped, never growing (patchy, broken-up districts)
  const label = new Int32Array(n * n), dist = new Float64Array(n * n).fill(Infinity);
  const h: [number, number][] = []; // simple binary heap of [distance, cell]
  const push = (d: number, k: number) => { h.push([d, k]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
  const pop = () => { const top = h[0], last = h.pop()!; if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } } return top; };
  for (const nd of nodes) {
    const gx = (nd.x + HALF) / cell - 0.5, gz = (nd.z + HALF) / cell - 0.5;
    const i = Math.round(gx), j = Math.round(gz);
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const k = j * n + i, d = Math.hypot(gx - i, gz - j) * cell + (nd.dist ? 0 : noneBias); // `noneBias` m handicap for 'no district' samples
    if (d < dist[k]) { dist[k] = d; label[k] = nd.dist; push(d, k); }
  }
  const steps: [number, number, number][] = [[1, 0, cell], [-1, 0, cell], [0, 1, cell], [0, -1, cell], [1, 1, cell * Math.SQRT2], [1, -1, cell * Math.SQRT2], [-1, 1, cell * Math.SQRT2], [-1, -1, cell * Math.SQRT2]];
  while (h.length) {
    const [d, k] = pop();
    if (d > dist[k]) continue;
    const i = k % n, j = (k / n) | 0;
    for (const [di, dj, c] of steps) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const q = b * n + a, nd = d + c;
      if (nd < dist[q] && nd <= reach) { dist[q] = nd; label[q] = label[k]; push(nd, q); }
    }
  }
  const at = (x: number, z: number) => { const i = Math.floor((x + HALF) / cell), j = Math.floor((z + HALF) / cell); return i >= 0 && j >= 0 && i < n && j < n ? label[j * n + i] : 0; };
  return { grid: label, n, cell, at };
}

// ------------------------------------------------------------------ main ----

export function buildCity(city: CityData, progress: (msg: string) => void = () => {}, oneway?: OneWayResult, tolls?: TollData): BuiltCity {
  const T = makeTerrainSampler(city);
  const stats: Record<string, number> = {};
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);

  // --------------------------------------------------------- districts
  progress('Mapping districts');
  const { grid: dgrid, n: dn, cell: DC } = districtGrid(districtSamples(city));
  const distName = new Map(city.districts.map((d) => [d.id, d.name]));
  const districtAt = (x: number, z: number) => {
    const i = Math.floor((x + HALF) / DC), j = Math.floor((z + HALF) / DC);
    return i >= 0 && j >= 0 && i < dn && j < dn ? distName.get(dgrid[j * dn + i]) ?? '' : '';
  };

  // ------------------------------------------------------------- roads
  progress('Classifying roads');
  const roads: Feature[] = [];
  const rails: Feature[] = [];
  const waterLines: Feature[] = [];
  const named = new Map<string, { a: number; b: number; pts: XY[]; rank: number }[]>();
  const segById = new Map<number, CSeg>();
  const urbanMarks: XY[] = [];
  const aeroMarks: XY[] = [];
  const concourses: CSeg[] = [];
  const nodeClass = new Map<number, { rank: number; cls: string }>();
  const inherit: Props[] = [];

  for (const seg of city.segs) {
    segById.set(seg.id, seg);
    if (seg.pts.length < 2) continue;
    const st = city.segTypes.get(seg.name);
    const lanes = laneInfo(st);
    const c = classify(seg, st, lanes);
    if (c.cls === 'concourse') { concourses.push(seg); continue; }
    if (c.group === 'skip' || c.group === 'route') continue;

    // elevation relative to terrain/water surface
    const dys: number[] = [];
    const inner = seg.pts.length > 2 ? seg.pts.slice(1, -1) : seg.pts;
    for (const p of inner) dys.push(p.y - T.surf(p.x, p.z));
    dys.sort((a, b) => a - b);
    const dy = dys[dys.length >> 1];
    const sn = city.nodes.get(seg.sn), en = city.nodes.get(seg.en);
    const both = seg.name + ' ' + seg.icls;
    let brunnel = '';
    // the game swaps in a road's Elevated/Bridge/Tunnel/Slope variant whenever it leaves the ground, so a plain
    // variant between two on-ground (`og`) nodes is at grade. That overrules the height test, which misreads
    // steep slopes where the coarse heightmap runs 20–45 m off (exports without `og` keep the height test)
    const atGrade = sn?.og === true && en?.og === true && !/Elevated|Bridge|Tunnel|Slope|\bDam\b/i.test(both);
    // a named elevated/bridge type wins over the height test (next to a dam the reservoir surface sits far above the road)
    if (/Tunnel/i.test(both) || (sn?.ug && en?.ug) || (dy < -6 && !atGrade && !/Elevated|Bridge/i.test(both))) brunnel = 'tunnel';
    else if (/Elevated|Bridge/i.test(both) || (dy > 4.5 && !atGrade)) brunnel = 'bridge';
    const avgY = seg.pts.reduce((s, p) => s + p.y, 0) / seg.pts.length;

    const coords = seg.pts.map(ll);
    const pts2: XY[] = seg.pts.map((p) => [p.x, p.z]);
    let w = lanes.span > 0 ? Math.min(seg.width, lanes.span + 0.6) : seg.width * 0.62;
    if (c.group === 'path') w = c.cls === 'pedestrian' ? Math.max(6, seg.width * 0.7) : Math.min(4, Math.max(2, seg.width * 0.45));
    if (c.cls === 'track') w = Math.min(seg.width * 0.6, 6);
    if (c.group === 'rail') w = Math.max(2, seg.width * 0.35);
    if (c.group === 'aero') w = c.cls === 'runway' ? seg.width * 0.9 : seg.width * 0.6;
    if (c.group === 'water') w = seg.width * 0.62;
    w = Math.round(w * 10) / 10;

    const name = seg.customName || '';
    const props: Props = { id: seg.id, cls: c.cls, w, brunnel, rank: c.rank, z: Math.round(avgY * 10) / 10, name, type: seg.name, lanes: lanes.vehicle, oneway: lanes.oneway ? 1 : 0, len: Math.round(polylineLength(pts2)), toll: tolls?.gateOf.has(seg.id) ? 2 : tolls?.boothOf.has(seg.id) ? 1 : 0, ow: oneway?.dir.get(seg.id) ?? 0, owSure: oneway && oneway.source.get(seg.id) !== 'prior' ? 1 : 0, speed: lanes.speed, bike: lanes.bike || /Bicycle|Bike/i.test(seg.name) ? 1 : 0, district: districtAt(seg.pts[seg.pts.length >> 1].x, seg.pts[seg.pts.length >> 1].z) };
    const f: Feature = { type: 'Feature', id: seg.id, properties: props, geometry: { type: 'LineString', coordinates: coords } };
    bump('seg:' + c.cls);

    if (c.cls === 'inherit') inherit.push(props);
    else if (c.group === 'road') for (const nd of [seg.sn, seg.en]) { const b = nodeClass.get(nd); if (!b || c.rank > b.rank) nodeClass.set(nd, { rank: c.rank, cls: c.cls }); }
    (props as any)._n = [seg.sn, seg.en];
    if (c.group === 'rail') rails.push(f);
    else if (c.group === 'water') waterLines.push(f);
    else roads.push(f);

    if (c.group === 'road' && st?.lanes.some((l) => /Monorail/.test(l.vType))) {
      rails.push({ type: 'Feature', properties: { cls: 'monorail', w: 2, brunnel, z: props.z, id: seg.id }, geometry: { type: 'LineString', coordinates: coords } });
    }
    if (lanes.tram && c.group === 'road') {
      rails.push({ type: 'Feature', properties: { cls: 'tram', w: 2, brunnel, z: props.z, id: seg.id }, geometry: { type: 'LineString', coordinates: coords } });
    }

    if (name && (c.group === 'road' || c.group === 'path')) {
      const key = name + '|' + brunnel;
      const l = named.get(key) ?? [];
      l.push({ a: seg.sn, b: seg.en, pts: pts2, rank: c.rank });
      named.set(key, l);
    }

    if (c.group === 'aero') {
      for (let i = 1; i < pts2.length; i++) {
        const [ax, az] = pts2[i - 1], [bx, bz] = pts2[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 12));
        for (let k = 0; k <= steps; k++) aeroMarks.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
      }
    }
    if (c.group === 'road' && c.cls !== 'motorway' && c.cls !== 'motorway_link' && c.cls !== 'trunk' && brunnel === '') {
      for (let i = 1; i < pts2.length; i++) {
        const [ax, az] = pts2[i - 1], [bx, bz] = pts2[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 12));
        for (let k = 0; k <= steps; k++) urbanMarks.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
      }
    }
  }

  // a dam (often several segments) takes the class of the most important road it connects
  {
    const group = new Map<number, number>(); // node -> chain id
    const find = (i: number): number => (group.get(i) === i || group.get(i) === undefined ? i : find(group.get(i)!));
    for (const pr of inherit) { const [a, b] = (pr as any)._n as number[]; group.set(find(a), find(b)); if (!group.has(b)) group.set(b, b); }
    const best = new Map<number, { rank: number; cls: string }>();
    for (const pr of inherit) for (const nd of (pr as any)._n as number[]) {
      const c = nodeClass.get(nd), r = find(nd), cur = best.get(r);
      if (c && (!cur || c.rank > cur.rank)) best.set(r, c);
    }
    for (const pr of inherit) { const b = best.get(find(((pr as any)._n as number[])[0])); pr.cls = b?.cls ?? 'minor'; pr.rank = b?.rank ?? 3; }
  }
  for (const f of [...roads, ...rails, ...waterLines]) delete (f.properties as any)._n;

  // ------------------------------------------------------ road labels
  const roadLabels: Feature[] = [];
  const search: SearchEntry[] = [];
  const seenRoad = new Map<string, { bbox: number[]; rank: number; len: number }>();
  for (const [key, parts] of named) {
    const name = key.split('|')[0];
    const rank = Math.max(...parts.map((p) => p.rank));
    for (const chain of mergeChains(parts)) {
      const len = polylineLength(chain);
      roadLabels.push({ type: 'Feature', properties: { name, rank, len: Math.round(len) }, geometry: { type: 'LineString', coordinates: chain.map(llxy) } });
      const e = seenRoad.get(name) ?? { bbox: [Infinity, Infinity, -Infinity, -Infinity], rank, len: 0 };
      for (const [x, z] of chain) { e.bbox[0] = Math.min(e.bbox[0], x); e.bbox[1] = Math.min(e.bbox[1], z); e.bbox[2] = Math.max(e.bbox[2], x); e.bbox[3] = Math.max(e.bbox[3], z); }
      e.len += len;
      seenRoad.set(name, e);
    }
  }
  for (const [name, e] of seenRoad) {
    const sw = toLngLat(e.bbox[0], e.bbox[1]), ne = toLngLat(e.bbox[2], e.bbox[3]);
    search.push({ name, kind: 'road', sub: e.rank >= 7 ? 'Highway' : 'Road', center: toLngLat((e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2), zoom: 15, bbox: [sw[0], sw[1], ne[0], ne[1]] });
  }

  // -------------------------------------------------------- buildings
  progress('Shaping buildings');
  const lots: Feature[] = [];
  const blds: Feature[] = [];
  const places: Feature[] = [];
  const poiSeen: { name: string; x: number; z: number; poi: string; area: number }[] = [];
  const namedStations: { name: string; x: number; z: number; mode: string; modes: Set<string>; rings: XY[][]; used?: boolean }[] = [];
  const byId = new Map(city.buildings.map((b) => [b.id, b]));
  const groupHead = buildingGroups(city.buildings);
  const groupSize = new Map<number, number>();
  for (const h of groupHead.values()) groupSize.set(h, (groupSize.get(h) ?? 1) + 1);
  const areaOf = (p: XY[]) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]); return Math.abs(a / 2); };
  // named stations collect every footprint of their asset, so platforms far from the main hall still match
  const stationByHead = new Map<number, (typeof namedStations)[number]>();
  for (const b of city.buildings) {
    if (b.pts.length < 3) continue;
    const p2: XY[] = b.pts.map((p) => [p.x, p.z]);
    const area = areaOf(p2);
    const headId = groupHead.get(b.id);
    const head = headId !== undefined ? byId.get(headId) : undefined; // set only for parts
    const headRing = head && head.pts.length >= 3 ? head.pts.map((p): XY => [p.x, p.z]) : null;
    const stMode = b.srv === 'PublicTransport' ? modeOfService(b.subsrv, b.icls, b.name) : null;
    let cat = buildingCategory(b, area);
    if (head && b.srv !== head.srv && !stMode) {
      // a part with another service is the asset's own piece under a borrowed type (platforms and stairs as
      // props, glass/roof/balcony overlays as "Airplane Facility"…). Overlays inside the main footprint are
      // decoration; pieces reaching outside it are more of the same building.
      const inside = p2.filter((q) => pointInRing(q, headRing ?? [])).length / p2.length;
      const hc = buildingCategory(head, headRing ? areaOf(headRing) : area);
      cat = inside >= 0.75 || !hc ? null : hc;
    }
    if (!cat) { bump('bld:skipped'); continue; }
    bump('bld:' + cat.cat);
    if (head) bump('bld:part');
    const cx = p2.reduce((s, p) => s + p[0], 0) / p2.length, cz = p2.reduce((s, p) => s + p[1], 0) / p2.length;
    for (const p of p2) urbanMarks.push(p);
    urbanMarks.push([cx, cz]);
    const ring = [...p2, p2[0]];
    const ccw = (() => { let a = 0; for (let i = 0; i < ring.length - 1; i++) a += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]); return a < 0; })();
    const ordered = ccw ? ring : [...ring].reverse();
    const asset = cleanName(b.name);
    // parts are labelled as their asset: the player's name for it, else the main building's asset name
    const nm = b.myname || head?.myname || (head ? cleanName(head.name) : asset);
    const gid = headId ?? b.id;
    const base = { id: b.id, cat: cat.cat, name: nm, asset, named: b.myname || head?.myname ? 1 : 0, srv: b.srv, icls: b.icls, area: Math.round(area), district: districtAt(cx, cz), part: head ? 1 : 0, grp: gid, nparts: groupSize.get(gid) ?? 1 };
    lots.push({ type: 'Feature', id: b.id, properties: base, geometry: { type: 'Polygon', coordinates: [ordered.map(llxy)] } });
    if (cat.inset < 1 && cat.height > 0) {
      const r = rnd(gid); // one height factor per asset, so its parts read as one building
      const f = Math.min(0.95, cat.inset * (0.92 + rnd(b.id) * 0.14));
      const inner = ordered.map(([x, z]) => llxy([cx + (x - cx) * f, cz + (z - cz) * f]));
      const h = Math.round(cat.height * (0.75 + r * 0.5) * (cat.cat === 'residential_high' || cat.cat === 'office' || cat.cat === 'commercial' ? Math.min(1.6, Math.max(0.8, Math.sqrt(area) / 26)) : 1));
      blds.push({ type: 'Feature', id: b.id, properties: { ...base, h }, geometry: { type: 'Polygon', coordinates: [inner] } });
    }
    // stations the player named are attached to the transit markers below
    if (b.myname && stMode && !head) continue;
    if (head) continue; // parts never get their own place label
    // toll booths get their own marker (tolls section); don't also label them as a named landmark
    const poi = /Toll Booth/i.test(b.name) ? null : cat.poi ?? (b.myname ? (b.subsrv.includes('Bus') ? 'bus' : 'landmark') : null);
    if (poi && nm.length > 1 && (b.myname || !(poi === 'landmark' && isJunkName(nm)))) {
      if (poiSeen.some((p) => p.name === nm && Math.hypot(p.x - cx, p.z - cz) < 250)) continue;
      poiSeen.push({ name: nm, x: cx, z: cz, poi, area });
      let rank = poi === 'hospital' && cat.height > 20 ? 3 : poi === 'landmark' ? (area > 8000 ? 4 : 5) : poi === 'school' && /University/i.test(b.icls) ? 4 : 6;
      if (b.myname) rank = Math.min(rank, 4); // names the player chose get shown early
      places.push({ type: 'Feature', properties: { kind: 'poi', poi, name: nm, rank, area: Math.round(area) }, geometry: { type: 'Point', coordinates: toLngLat(cx, cz) } });
      search.push({ name: nm, kind: 'poi', sub: poi, center: toLngLat(cx, cz), zoom: 17 });
    }
  }
  // Station footprints. A named station is its whole asset: main hall, extra halls and platform/stair props,
  // so a stop at the far end of a long station still finds it; a station building inside a named asset (a
  // metro hall under a main station or a tower) takes the asset's name. (Unnamed station buildings don't
  // compete: players leave road-side monorail/train stops unnamed and name the interchange beside them.)
  const stationRings: { ns: (typeof namedStations)[number]; mode: string | null; ring: XY[] }[] = [];
  {
    const stModeOf = (b: CBuilding) => (b.srv === 'PublicTransport' ? modeOfService(b.subsrv, b.icls, b.name) : null);
    const byHead = new Map<number, (typeof namedStations)[number]>();
    for (const b of city.buildings) {
      const gid = groupHead.get(b.id) ?? b.id, name = b.myname || byId.get(gid)?.myname, m = stModeOf(b);
      if (!m || !name || byHead.has(gid)) continue;
      const hp = (byId.get(gid)?.pts.length ? byId.get(gid)! : b).pts;
      const ns = { name, x: hp.reduce((s, p) => s + p.x, 0) / hp.length, z: hp.reduce((s, p) => s + p.z, 0) / hp.length, mode: m, modes: new Set<string>(), rings: [] as XY[][] };
      byHead.set(gid, ns); namedStations.push(ns);
    }
    for (const b of city.buildings) {
      if (b.pts.length < 3) continue;
      const ns = byHead.get(groupHead.get(b.id) ?? b.id) ?? null, m = stModeOf(b), ring = b.pts.map((p): XY => [p.x, p.z]);
      if (ns) { if (m) ns.modes.add(m); ns.rings.push(ring); stationRings.push({ ns, mode: m, ring }); }
    }
  }

  // airport concourses: buffer each segment to its walkway width and draw it as a building
  for (const seg of concourses) {
    const st = city.segTypes.get(seg.name);
    const half = Math.max(...(st?.lanes ?? []).filter((l) => l.type.includes('Pedestrian')).map((l) => l.width), 16) / 2;
    const p: XY[] = seg.pts.map((q) => [q.x, q.z]);
    // extend ends a little so neighbouring pieces overlap at junctions
    const ext = (a: XY, b: XY): XY => { const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [a[0] + ((a[0] - b[0]) / d) * half * 0.5, a[1] + ((a[1] - b[1]) / d) * half * 0.5]; };
    p[0] = ext(p[0], p[1]); p[p.length - 1] = ext(p[p.length - 1], p[p.length - 2]);
    const left: XY[] = [], right: XY[] = [];
    p.forEach((q, i) => {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], d = Math.hypot(dx, dz) || 1;
      const nx = -dz / d, nz = dx / d;
      left.push([q[0] + nx * half, q[1] + nz * half]); right.push([q[0] - nx * half, q[1] - nz * half]);
    });
    const ring = [...right, ...left.reverse()];
    let a2 = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a2 += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    const ccw = a2 < 0 ? ring : [...ring].reverse();
    const coords = [[...ccw, ccw[0]].map(llxy)];
    const props = { id: 900000000 + seg.id, cat: 'transport', name: 'Airport concourse', asset: seg.name, named: 0, srv: 'PublicTransport', icls: seg.icls, area: Math.round(Math.abs(a2 / 2)), district: districtAt(p[0][0], p[0][1]), part: 0 };
    lots.push({ type: 'Feature', id: props.id, properties: props, geometry: { type: 'Polygon', coordinates: coords } });
    blds.push({ type: 'Feature', id: props.id, properties: { ...props, h: 14 }, geometry: { type: 'Polygon', coordinates: coords } });
    for (const q of p) urbanMarks.push(q);
  }

  // ---------------------------------------------------- districts/parks
  for (const d of city.districts) {
    if (!d.name || d.id === 0 || (Math.abs(d.x) >= HALF - 1 && Math.abs(d.z) >= HALF - 1)) continue;
    places.push({ type: 'Feature', properties: { kind: 'district', name: d.name, rank: 1 }, geometry: { type: 'Point', coordinates: ll(d) } });
    search.push({ name: d.name, kind: 'district', sub: 'District', center: ll(d), zoom: 15 });
  }
  for (const p of city.parks) {
    if (!p.name || p.id === 0 || p.type === 'None' || /^AREA_PATTERN/.test(p.name)) continue;
    const pk = p.type === 'Airport' ? 'airport' : p.type === 'Industry' || /Industry|Farm|Forest|Ore|Oil/i.test(p.type ?? '') ? 'industry' : p.type === 'Campus' || /University|Campus|Liberal|Trade|Arts/.test(p.type ?? '') ? 'campus' : p.type === 'AmusementPark' ? 'amusement' : p.type === 'Zoo' ? 'zoo' : p.type === 'NatureReserve' ? 'nature' : 'park';
    places.push({ type: 'Feature', properties: { kind: 'park', poi: pk, name: p.name, rank: pk === 'nature' || pk === 'airport' ? 1 : 2 }, geometry: { type: 'Point', coordinates: ll(p) } });
    search.push({ name: p.name, kind: 'park', sub: p.type ?? 'Park', center: ll(p), zoom: pk === 'nature' ? 14 : 16 });
  }

  // ------------------------------------------------------------ tolls
  for (const b of tolls?.booths ?? []) {
    places.push({ type: 'Feature', properties: { kind: 'toll', poi: 'toll', id: b.id, name: boothLabel(b), named: b.name ? 1 : 0, unconfirmed: b.unconfirmed ? 1 : 0, boothKind: b.kind, roads: b.roads.join(' · '), roadTypes: b.roadTypes.join(' · '), gates: b.gates.length, rank: 3 }, geometry: { type: 'Point', coordinates: toLngLat(b.x, b.z) } });
    if (b.name) search.push({ name: b.name, kind: 'poi', sub: 'toll', center: toLngLat(b.x, b.z), zoom: 17 });
  }
  stats.tollBooths = tolls?.booths.length ?? 0;
  // toll booth buildings are drawn by the marker; their sub-buildings don't need a separate POI

  // ----------------------------------------------------------- transit
  progress('Tracing transit lines');
  const routeSegs = new Map<string, number[]>();
  for (const s of city.segs) if (s.path) routeSegs.set(s.sn + ',' + s.en, s.path);
  const transit: Feature[] = [];
  const lines: BuiltCity['meta']['lines'] = [];
  // slot assignment per road segment so parallel lines sit side by side
  const segUsers = new Map<number, number[]>();
  const routeSegLists = new Map<number, number[]>();
  for (const tr of city.transports) {
    if (tr.stops.length < 2) continue;
    const used: number[] = [];
    const set = new Set<number>();
    for (let i = 0; i < tr.stops.length; i++) {
      const key = tr.stops[i] + ',' + tr.stops[(i + 1) % tr.stops.length];
      for (const id of routeSegs.get(key) ?? []) if (!set.has(id)) { set.add(id); used.push(id); }
    }
    routeSegLists.set(tr.id, used);
    for (const id of used) { const l = segUsers.get(id) ?? []; l.push(tr.id); segUsers.set(id, l); }
  }
  const modeRank: Record<string, number> = { train: 0, metro: 1, monorail: 2, tram: 3, ferry: 4, cablecar: 5, bus: 6, tour: 7, air: 8, other: 9 };
  const trById = new Map(city.transports.map((t) => [t.id, t]));
  for (const tr of city.transports) {
    const used = routeSegLists.get(tr.id);
    if (!used) continue;
    const mode = modeOf(tr.type);
    const color = hex(tr.color);
    let bb: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const id of used) {
      const s = segById.get(id);
      if (!s || s.pts.length < 2) continue;
      // lines of the same "family" (rail vs bus) share offsets on a segment
      const users = (segUsers.get(id) ?? []).filter((u) => { const m = modeOf(trById.get(u)!.type); return (m === 'bus' || m === 'tour') === (mode === 'bus' || mode === 'tour'); })
        .sort((a, b) => modeRank[modeOf(trById.get(a)!.type)] - modeRank[modeOf(trById.get(b)!.type)] || a - b);
      const slot = users.indexOf(tr.id);
      const offset = slot - (users.length - 1) / 2;
      for (const p of s.pts) { bb = [Math.min(bb[0], p.x), Math.min(bb[1], p.z), Math.max(bb[2], p.x), Math.max(bb[3], p.z)]; }
      transit.push({ type: 'Feature', properties: { line: tr.id, name: tr.name, mode, color, offset, n: users.length, underground: /Tunnel/i.test(s.name) || (city.nodes.get(s.sn)?.ug ?? false) ? 1 : 0 }, geometry: { type: 'LineString', coordinates: s.pts.map(ll) } });
    }
    const valid = bb[0] !== Infinity;
    const sw = valid ? toLngLat(bb[0], bb[1]) : null, ne = valid ? toLngLat(bb[2], bb[3]) : null;
    lines.push({ id: tr.id, name: tr.name, type: mode, color, stops: tr.stops.length, bbox: sw && ne ? [sw[0], sw[1], ne[0], ne[1]] : null });
    if (sw && ne) search.push({ name: tr.name, kind: 'line', sub: mode, center: toLngLat((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2), zoom: 13, bbox: [sw[0], sw[1], ne[0], ne[1]] });
  }

  // Stations: each stop is matched on its own to the station building the player
  // named (the `myname` attribute) — platforms sit right next to their own
  // building, so nearest-building is exact. Grouping nearby platforms first would
  // wrongly merge separate stations that happen to be close (e.g. two lines' stops).
  // Stops with no named building nearby stay unnamed, never invented.
  const family = (m: string) => (m === 'train' || m === 'metro' || m === 'monorail' ? 'rail' : m);
  const stations: { x: number; z: number; lines: Set<number>; modes: Set<string>; name: string }[] = [];
  const stopName = new Map<number, string>();
  const stopStation = new Map<number, (typeof stations)[number]>();
  const byName = new Map<string, (typeof stations)[number]>();
  const busStops: { x: number; z: number; lines: Set<number> }[] = [];
  for (const tr of city.transports) {
    const mode = modeOf(tr.type);
    for (const sid of tr.stops) {
      const n = city.nodes.get(sid);
      if (!n) continue;
      if (mode === 'bus' || mode === 'tour' || mode === 'air') {
        if (mode !== 'bus') continue;
        const c = busStops.find((c) => Math.hypot(c.x - n.x, c.z - n.z) < 40);
        if (c) c.lines.add(tr.id); else busStops.push({ x: n.x, z: n.z, lines: new Set([tr.id]) });
        continue;
      }
      // nearest station footprint; a building of another mode (a train hall over a metro stop) or a plain
      // part of the asset counts as a little farther, so the stop's own station wins a near tie
      let best: (typeof namedStations)[number] | null = null, bd = mode === 'ferry' ? 220 : 150;
      for (const r of stationRings) {
        if (r.mode ? family(r.mode) !== family(mode) : ![...r.ns.modes].some((m) => family(m) === family(mode))) continue;
        if (Math.abs(r.ring[0][0] - n.x) > bd + 600 || Math.abs(r.ring[0][1] - n.z) > bd + 600) continue;
        const d = distToRing([n.x, n.z], r.ring) + (r.mode === mode ? 0 : r.mode ? 15 : 30);
        if (d < bd) { bd = d; best = r.ns; }
      }
      let st: (typeof stations)[number] | undefined;
      if (best) {
        best.used = true;
        stopName.set(sid, best.name);
        st = byName.get(best.name);
        if (!st) { st = { x: best.x, z: best.z, lines: new Set(), modes: new Set(), name: best.name }; byName.set(best.name, st); stations.push(st); }
      } else {
        // unnamed: merge only with other unnamed platforms of the same spot
        st = stations.find((c) => !c.name && Math.hypot(c.x - n.x, c.z - n.z) < 120);
        if (!st) { st = { x: n.x, z: n.z, lines: new Set(), modes: new Set(), name: '' }; stations.push(st); }
      }
      st.lines.add(tr.id); st.modes.add(mode);
      stopStation.set(sid, st);
    }
  }
  // named stations with no line serving them yet still get a marker
  for (const ns of namedStations) if (!ns.used) stations.push({ x: ns.x, z: ns.z, lines: new Set(), modes: new Set(ns.modes), name: ns.name });
  const modeColor: Record<string, string> = { train: '#4f5d73', metro: '#2f6fe0', monorail: '#2f6fe0', tram: '#14957d', ferry: '#2f7fd6', cablecar: '#6a6f78' };
  for (const st of stations) {
    const ls = [...st.lines].map((id) => trById.get(id)!).sort((a, b) => modeRank[modeOf(a.type)] - modeRank[modeOf(b.type)]);
    const mode = ls.length ? modeOf(ls[0].type) : [...st.modes][0];
    const lineNames = ls.map((l) => l.name).join(' · ');
    const color = ls.length ? hex(ls[0].color) : modeColor[mode] ?? '#4f5d73';
    places.push({ type: 'Feature', properties: { kind: 'station', poi: mode, name: st.name, lines: lineNames, color, rank: mode === 'train' ? 1 : mode === 'ferry' ? 4 : 2, nlines: ls.length }, geometry: { type: 'Point', coordinates: toLngLat(st.x, st.z) } });
    if (st.name) search.push({ name: st.name, kind: 'station', sub: mode, center: toLngLat(st.x, st.z), zoom: 16 });
  }
  // stop order per line, using the station names the player gave
  for (const l of lines) {
    const tr = trById.get(l.id);
    if (!tr) continue;
    const seq: string[] = [];
    for (const sid of tr.stops) { const nm = stopName.get(sid) ?? ''; if (seq[seq.length - 1] !== nm || !nm) seq.push(nm); }
    // game lines are loops; a back-and-forth line is a palindrome around two turnarounds
    const n = seq.length;
    let route = seq, shape: 'both' | 'loop' = 'loop';
    if (n >= 3 && n % 2 === 0) {
      for (let t = 0; t < n; t++) {
        let ok = true;
        for (let i = 1; i < n / 2 && ok; i++) ok = !!seq[(t - i + n) % n] && seq[(t - i + n) % n] === seq[(t + i) % n];
        if (ok) { const st = (t + n / 2) % n; route = Array.from({ length: n / 2 + 1 }, (_, i) => seq[(st + i) % n]); shape = 'both'; break; }
      }
    }
    l.stopNames = route; l.shape = shape;
  }
  for (const b of busStops) {
    const lines = [...b.lines].map((id) => trById.get(id)!.name).join(' · ');
    places.push({ type: 'Feature', properties: { kind: 'busstop', poi: 'bus', name: lines, lines, rank: 8 }, geometry: { type: 'Point', coordinates: toLngLat(b.x, b.z) } });
  }
  stats.stations = stations.length; stats.busStops = busStops.length;

  // schematic input: every line as its stop order over shared station ids (same groups as the map)
  const schem: SchemInput = { stations: [], lines: [] };
  const sIdx = new Map<object, number>();
  const sid = (o: object, x: number, z: number, name: string) => { let i = sIdx.get(o); if (i === undefined) { i = schem.stations.push({ x, z, name }) - 1; sIdx.set(o, i); } return i; };
  for (const tr of city.transports) {
    const mode = modeOf(tr.type);
    if (mode === 'tour' || mode === 'air' || tr.stops.length < 2) continue;
    const seq: number[] = [];
    for (const stop of tr.stops) {
      const n = city.nodes.get(stop);
      if (!n) continue;
      if (mode === 'bus') {
        // a bus stop beside a station is that station (a transfer); otherwise its own stop cluster
        const near = stations.find((st) => st.lines.size && Math.hypot(st.x - n.x, st.z - n.z) < 90);
        const c = near ?? busStops.find((c) => Math.hypot(c.x - n.x, c.z - n.z) < 40);
        seq.push(c ? sid(c, c.x, c.z, near?.name ?? '') : sid({}, n.x, n.z, ''));
      } else {
        const st = stopStation.get(stop);
        seq.push(st ? sid(st, st.x, st.z, st.name) : sid({}, n.x, n.z, ''));
      }
    }
    schem.lines.push({ id: tr.id, name: tr.name, color: hex(tr.color), mode, stations: seq, stopIds: tr.stops.filter((x) => city.nodes.has(x)) });
  }

  // ------------------------------------------------------------ water
  progress('Tracing coastlines');
  const n = city.terrainSize, cell = MAP_SIZE / (n - 1);
  const gridToWorld = (p: XY): XY => [p[0] * cell - HALF, p[1] * cell - HALF];
  const polysFromGrid = (grid: ArrayLike<number>, gw: number, gh: number, t: number, toWorld: (p: XY) => XY, minArea: number, smooth = 1, tol = 0.12) => {
    const rings = isolines(grid, gw, gh, t, true).filter((c) => c.closed).map((c) => simplify(chaikin(c.pts, true, smooth), tol));
    return assemblePolygons(rings, minArea).map((poly) => poly.map((r) => r.map((p) => llxy(toWorld(p)))));
  };
  const waterPolys = polysFromGrid(city.water, n, n, 0.35, gridToWorld, 2.5);
  const water: Feature[] = waterPolys.map((coordinates) => ({ type: 'Feature', properties: { kind: 'water' }, geometry: { type: 'Polygon', coordinates } }));
  water.push(...waterLines);
  stats.waterBodies = waterPolys.length;

  // ----------------------------------------------------------- landcover
  progress('Growing forests');
  const fs = city.forestSize, fcell = MAP_SIZE / fs;
  const forestGrid = blur(city.forest, fs, fs, 1);
  const forestPolys = polysFromGrid(forestGrid, fs, fs, 70, (p) => [(p[0] + 0.5) * fcell - HALF, (p[1] + 0.5) * fcell - HALF], 1.5, 2, 0.08);
  const forestDense = polysFromGrid(forestGrid, fs, fs, 170, (p) => [(p[0] + 0.5) * fcell - HALF, (p[1] + 0.5) * fcell - HALF], 2, 2, 0.08);

  progress('Mapping built-up areas');
  const UC = 24, un = Math.ceil(MAP_SIZE / UC);
  const urban = new Float32Array(un * un);
  for (const [x, z] of urbanMarks) {
    const i = Math.floor((x + HALF) / UC), j = Math.floor((z + HALF) / UC);
    if (i >= 0 && j >= 0 && i < un && j < un) urban[j * un + i] = 1;
  }
  const urbanBlur = blur(blur(urban, un, un, 2), un, un, 1);
  const urbanPolys = polysFromGrid(urbanBlur, un, un, 0.22, (p) => [(p[0] + 0.5) * UC - HALF, (p[1] + 0.5) * UC - HALF], 6, 2, 0.15);

  const W = HALF * 8;
  const aero = new Float32Array(un * un);
  for (const [x, z] of aeroMarks) {
    const i = Math.floor((x + HALF) / UC), j = Math.floor((z + HALF) / UC);
    if (i >= 0 && j >= 0 && i < un && j < un) aero[j * un + i] = 1;
  }
  const aeroPolys = aeroMarks.length ? polysFromGrid(blur(blur(aero, un, un, 3), un, un, 2), un, un, 0.12, (p) => [(p[0] + 0.5) * UC - HALF, (p[1] + 0.5) * UC - HALF], 20, 2, 0.15) : [];

  const land: Feature[] = [
    { type: 'Feature', properties: { kind: 'outside' }, geometry: { type: 'Polygon', coordinates: [
      [[-W, -W], [W, -W], [W, W], [-W, W], [-W, -W]].map((p) => llxy(p as XY)),
      [[-HALF, -HALF], [-HALF, HALF], [HALF, HALF], [HALF, -HALF], [-HALF, -HALF]].map((p) => llxy(p as XY)),
    ] } },
    { type: 'Feature', properties: { kind: 'land' }, geometry: { type: 'Polygon', coordinates: [[[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF], [-HALF, -HALF]].map((p) => llxy(p as XY))] } },
    ...urbanPolys.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'urban' }, geometry: { type: 'Polygon', coordinates } })),
    ...forestPolys.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'forest' }, geometry: { type: 'Polygon', coordinates } })),
    ...forestDense.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'forest_dense' }, geometry: { type: 'Polygon', coordinates } })),
    ...aeroPolys.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'airport' }, geometry: { type: 'Polygon', coordinates } })),
  ];

  // district areas
  const districtFeats: Feature[] = [];
  // outlines are clipped to land: there are no samples on open water, so any district there would be a guess
  const landGrid = Int32Array.from(dgrid);
  for (let k = 0; k < landGrid.length; k++) {
    if (!landGrid[k]) continue;
    const x = ((k % dn) + 0.5) * DC - HALF, z = (Math.floor(k / dn) + 0.5) * DC - HALF;
    if (T.surf(x, z) - T.ground(x, z) > 1) landGrid[k] = 0;
  }
  const ids = new Set(landGrid);
  ids.delete(0);
  for (const id of ids) {
    const name = distName.get(id);
    if (!name) continue;
    const mask = new Float32Array(dn * dn);
    for (let k = 0; k < mask.length; k++) mask[k] = landGrid[k] === id ? 1 : 0;
    for (const coordinates of polysFromGrid(blur(mask, dn, dn, 1), dn, dn, 0.5, (p) => [(p[0] + 0.5) * DC - HALF, (p[1] + 0.5) * DC - HALF], 4, 2, 0.12))
      districtFeats.push({ type: 'Feature', properties: { id, name }, geometry: { type: 'Polygon', coordinates } });
  }

  // tile grid (9x9 game tiles)
  const grid: Feature[] = [];
  for (let k = 0; k <= 9; k++) {
    const v = -HALF + k * 1920;
    grid.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [llxy([v, -HALF]), llxy([v, HALF])] } });
    grid.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [llxy([-HALF, v]), llxy([HALF, v])] } });
  }

  let emin = Infinity, emax = -Infinity;
  for (let i = 0; i < city.height.length; i++) { const h = city.height[i]; if (h < emin) emin = h; if (h > emax) emax = h; }

  stats.buildings = blds.length; stats.lots = lots.length; stats.roads = roads.length; stats.rails = rails.length; stats.lines = lines.length;
  stats.districts = city.districts.length; stats.nodes = city.nodes.size;

  return {
    meta: { name: city.name, generated: city.generated, bounds: [toLngLat(-HALF, -HALF), toLngLat(HALF, HALF)], stats, elevation: { min: emin, max: emax }, lines },
    sources: { land: fc(land), water: fc(water), lots: fc(lots), buildings: fc(blds), roads: fc(roads), rails: fc(rails), transit: fc(transit), places: fc(places), roadLabels: fc(roadLabels), grid: fc(grid), districts: fc(districtFeats) },
    dem: { surface: T.surface, size: n },
    search,
    stopNames: stopName,
    schem,
  };
}

/** Contour lines, computed lazily (only needed for terrain mode). */
export function buildContours(height: Float32Array, size: number, interval = 10, major = 50): FC {
  const cell = MAP_SIZE / (size - 1);
  const sm = blur(height, size, size, 1);
  let mn = Infinity, mx = -Infinity;
  for (const h of sm) { if (h < mn) mn = h; if (h > mx) mx = h; }
  const out: Feature[] = [];
  for (let e = Math.ceil(mn / interval) * interval; e <= mx; e += interval) {
    for (const c of isolines(sm, size, size, e, false)) {
      if (c.pts.length < 4) continue;
      const pts = simplify(chaikin(c.pts, c.closed, 1), 0.15);
      if (pts.length < 3) continue;
      out.push({ type: 'Feature', properties: { ele: Math.round(e), major: e % major === 0 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: pts.map((p) => toLngLat(p[0] * cell - HALF, p[1] * cell - HALF)) } });
    }
  }
  return fc(out);
}

export type { Vec3 };
