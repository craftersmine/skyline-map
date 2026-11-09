// Optional simulation data from a Cities: Skylines save (.crp), layered on an open CSLMapView map.
// Runs in the worker: reads the save, checks it shows the same city state as the map (validate.ts), and
// returns only values attached to individually matched objects, plus save-wide statistics labelled as such.
// The map itself always comes from the export; nothing here changes it.
import type { CityData } from '../parse';
import { SaveError, readCrp, readSaveMeta, openSaveData, loadBytes, ASSET_DATA, ASSET_SAVE_META, type SaveData } from './reader';
import { readNet, segmentLanes, type SaveNet } from './net';
import { readBuildings } from './buildings';
import { readOccupancy } from './citizens';
import { readTransport, type SaveLine } from './transport';
import { readCityStats, type CityStats } from './city';
import { readGrids } from './grids';
import { readTmpe, TMPE_UNLIMITED_KMH, type TmpeData } from './tmpe';
import { buildRules, type SimRules } from './rules';
import { md5 } from './md5';
import { validate, M, type Validation } from './validate';

export type SimErrorCode = 'not-crp' | 'not-save' | 'unsupported-version' | 'truncated' | 'damaged' | 'corrupt' | 'incompatible';

export interface SimSave {
  city: string | null;
  /** when the game wrote the save (its own timestamp, not the file's) */
  savedAt: string | null;
  /** in-game date and time */
  gameDate: string | null;
  format: number | null;
}

export interface SimLine {
  id: number;
  /** "weekly passengers" exactly as the game's line panel shows it (smoothed average) */
  residents: number; tourists: number;
  /** the last completed week, raw counts */
  lastResidents: number; lastTourists: number;
  ageShares: [number, number, number, number, number];
  /** car trips saved, % (the panel shows it for ordinary lines only) */
  tripsSaved: number | null;
}

export interface SimData {
  ok: true;
  save: SimSave;
  v: Validation;
  /** m_trafficDensity (0-100 %) for matched segments only */
  traffic: { ids: Uint16Array; pct: Uint8Array } | null;
  /** occupancy for matched buildings only; -1 = the building has no units of that kind */
  buildings: { ids: Uint16Array; residents: Int32Array; households: Int32Array; homes: Int32Array; workers: Int32Array; students: Int32Array; visitors: Int32Array; level: Uint8Array; happiness: Uint8Array } | null;
  /** TM:PE per matched segment: distinct custom lane speed limits (km/h, TMPE_UNLIMITED_KMH = none), the prefab default override, parking */
  tmpe: { segs: { id: number; kmh: number[]; typeDefault: number | null; parking: [boolean, boolean] | null }[]; modVersion: string | null } | null;
  /** ridership for matched lines only */
  lines: SimLine[] | null;
  /** save-wide figures for the whole city (not limited to matched objects) */
  city: CityStats | null;
  /** simulation grids (see grids.ts for extents) */
  grids: { landValue: Uint16Array; noise: Uint16Array; crime: Uint16Array; pollution: Uint8Array } | null;
  /** features whose save section could not be read (reason codes, not shown verbatim) */
  unavailable: string[];
  /** routing rules for the worker's router (stripped before the result goes to the page) */
  rules?: SimRules;
  /** what the rules contain, for the page */
  rulesSummary: SimRules['summary'] | null;
  ms: number;
}

export interface SimFailure { ok: false; code: SimErrorCode; detail: string; save?: SimSave; v?: Validation }

export type SimResult = SimData | SimFailure;

export async function loadSim(buf: ArrayBuffer, city: CityData, step: (s: string) => void): Promise<SimResult> {
  const t0 = performance.now();
  let save: SimSave | undefined;
  try {
    step('Reading save file');
    const bytes = await loadBytes(buf);
    const crp = readCrp(bytes);
    const metaEntry = crp.entries.find((e) => e.type === ASSET_SAVE_META);
    const dataEntry = crp.entries.find((e) => e.type === ASSET_DATA);
    if (!metaEntry || !dataEntry) throw new SaveError('not-save', 'not a saved game');
    if (dataEntry.offset + dataEntry.size > bytes.length) throw new SaveError('truncated', 'save data ends early');
    const meta = readSaveMeta(bytes, metaEntry);
    save = { city: meta.cityName ?? null, savedAt: meta.timeStamp ?? null, gameDate: null, format: null };
    const data = bytes.subarray(dataEntry.offset, dataEntry.offset + dataEntry.size);
    // the game stores the MD5 of the data block; any copy error or damage shows up here, before parsing
    if (/^[0-9a-f]{32}$/.test(dataEntry.checksum) && md5(data) !== dataEntry.checksum) throw new SaveError('damaged', 'data checksum mismatch');
    const formatOf = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
    save.format = formatOf;
    const sd = openSaveData(data);
    save.gameDate = sd.gameDate;

    step('Checking it matches this map');
    const net = readNet(sd);
    const bld = readBuildings(sd);
    const unavailable: string[] = [];
    const tryRead = <T>(name: string, f: () => T): T | null => { try { return f(); } catch (err) { console.warn('[atlas] sim: ' + name, err); unavailable.push(name); return null; } };
    const transport = tryRead('transit', () => readTransport(sd));
    const { v, m } = validate(city, net, bld, transport ? transport.lines.map((l) => ({ id: l.id, created: (l.flags & 1) !== 0, firstStop: l.firstStop })) : null);
    if (v.verdict === 'incompatible') return { ok: false, code: 'incompatible', detail: v.reason, save, v };

    step('Reading simulation data');
    const traffic = trafficOf(city, net, m.seg);
    const occ = tryRead('buildings', () => readOccupancy(sd, bld));
    const buildings = occ ? buildingsOf(city, m.bld, occ, bld) : null;
    const tmpeData = tryRead('tmpe', () => readTmpe(sd.modData));
    const tmpe = tmpeData ? tmpeOf(city, tmpeData, net, m.seg) : null;
    const rules = tryRead('rules', () => buildRules(city, net, m.seg, tmpeData, sd.leftHandTraffic)) ?? undefined;
    const lines = transport ? linesOf(transport.lines, m.line) : null;
    const cityStats = tryRead('city', () => readCityStats(sd));
    const g = tryRead('grids', () => readGrids(sd));
    const grids = g ? { landValue: g.landValue, noise: g.noise, crime: g.crime, pollution: g.groundPollution } : null;
    return { ok: true, save, v, traffic, buildings, tmpe, lines, city: cityStats, grids, unavailable, rules, rulesSummary: rules?.summary ?? null, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err instanceof SaveError) return { ok: false, code: err.code, detail: err.message, save };
    if (err instanceof RangeError) return { ok: false, code: 'truncated', detail: err.message, save };
    return { ok: false, code: 'corrupt', detail: (err as Error).message ?? String(err), save };
  }
}

function trafficOf(city: CityData, net: SaveNet, seg: Uint8Array) {
  const ids: number[] = [], pct: number[] = [];
  for (const s of city.segs) if (seg[s.id] === M.Verified) { ids.push(s.id); pct.push(net.segTraffic[s.id]); }
  return { ids: Uint16Array.from(ids), pct: Uint8Array.from(pct) };
}

function buildingsOf(city: CityData, bm: Uint8Array, occ: ReturnType<typeof readOccupancy>, bld: ReturnType<typeof readBuildings>): SimData['buildings'] {
  const ids = city.buildings.filter((b) => bm[b.id] === M.Verified).map((b) => b.id);
  const col = (a: Int32Array) => Int32Array.from(ids, (i) => a[i]);
  return {
    ids: Uint16Array.from(ids),
    residents: col(occ.residents), households: col(occ.households), homes: col(occ.homes),
    workers: col(occ.workers), students: col(occ.students), visitors: col(occ.visitors),
    level: Uint8Array.from(ids, (i) => bld.level[i]), happiness: Uint8Array.from(ids, (i) => bld.happiness[i]),
  };
}

/** TM:PE rules, attached through the save's own lane chains to matched segments only. */
function tmpeOf(city: CityData, t: TmpeData, net: SaveNet, seg: Uint8Array): SimData['tmpe'] {
  const laneSeg = new Map<number, number>();
  for (const s of city.segs) {
    if (seg[s.id] !== M.Verified) continue;
    // the lane chain must line up with the export's lane list, or lane-level rules can't be placed
    const lanes = segmentLanes(net, s.id);
    const st = city.segTypes.get(s.name);
    if (!st || st.lanes.length !== lanes.length) continue;
    for (const l of lanes) laneSeg.set(l, s.id);
  }
  const per = new Map<number, { id: number; kmh: number[]; typeDefault: number | null; parking: [boolean, boolean] | null }>();
  const get = (id: number) => { let e = per.get(id); if (!e) per.set(id, (e = { id, kmh: [], typeDefault: null, parking: null })); return e; };
  for (const sl of t.speedLimits) { const id = laneSeg.get(sl.lane); if (id !== undefined) { const e = get(id); if (!e.kmh.includes(sl.kmh)) e.kmh.push(sl.kmh); } }
  const defaults = new Map(t.customDefaultSpeedLimits.map((d) => [d.prefab, d.kmh]));
  if (defaults.size) for (const s of city.segs) if (seg[s.id] === M.Verified && defaults.has(s.name)) get(s.id).typeDefault = defaults.get(s.name)!;
  for (const p of t.parking) if (seg[p.segment] === M.Verified) get(p.segment).parking = [p.forward, p.backward];
  for (const e of per.values()) e.kmh.sort((a, b) => a - b);
  void TMPE_UNLIMITED_KMH;
  return { segs: [...per.values()], modVersion: t.modVersion };
}

function linesOf(lines: SaveLine[], lm: Uint8Array): SimLine[] {
  return lines.filter((l) => lm[l.id] === M.Verified).map((l) => ({
    id: l.id,
    residents: l.weekly.residents, tourists: l.weekly.tourists,
    lastResidents: l.lastWeek.residents, lastTourists: l.lastWeek.tourists,
    ageShares: l.ageShares,
    tripsSaved: l.lineType === 'default' ? l.tripsSaved : null,
  }));
}

/** typed arrays to transfer to the page */
export function transferables(r: SimResult): ArrayBuffer[] {
  if (!r.ok) return [];
  const out: ArrayBufferLike[] = [];
  if (r.traffic) out.push(r.traffic.ids.buffer, r.traffic.pct.buffer);
  if (r.buildings) for (const k of ['ids', 'residents', 'households', 'homes', 'workers', 'students', 'visitors', 'level', 'happiness'] as const) out.push(r.buildings[k].buffer);
  if (r.grids) out.push(r.grids.landValue.buffer, r.grids.noise.buffer, r.grids.crime.buffer, r.grids.pollution.buffer);
  return [...new Set(out)] as ArrayBuffer[];
}
