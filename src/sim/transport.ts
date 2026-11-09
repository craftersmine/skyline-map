// TransportManager section reader. Mirrors TransportManager.Data.Serialize (acs/TransportManager.cs:32), format 121034.
// Per-line rows are written only for slots whose m_flags != 0, in id order.
import { SaveData, SaveError, section, endSection } from './reader';

/** new Array16<TransportLine>(256u) (TransportManager.cs:660). Slot 0 is never used. */
export const LINE_COUNT = 256;
/** TransportInfo.TransportType count written since format 111006 (TransportManager.cs:106) */
const TYPE_COUNT = 17;

/** TransportLine.Flags (TransportLine.cs:10) */
export const LINE_CREATED = 1, LINE_COMPLETE = 4, LINE_TEMPORARY = 8, LINE_CUSTOM_COLOR = 0x100, LINE_CUSTOM_NAME = 0x200;

/**
 * One TransportPassengerData group set. Counts are passengers boarding, per "week": the line folds its
 * running count into these once every 4096 simulation frames (TransportLine.SimulationStep, GroupData.Update).
 */
export interface Passengers { residents: number; tourists: number; child: number; teen: number; young: number; adult: number; senior: number; carOwning: number }

export interface SaveLine {
  id: number;
  /** raw TransportLine.m_flags: Created 1, Deleted 2, Complete 4 (closed loop of stops), Temporary 8, Hidden 0x10,
   *  CustomColor 0x100, CustomName 0x200, DisabledDay 0x1000, DisabledNight 0x2000 */
  flags: number;
  /** TransportInfo prefab name (e.g. "Bus", "Metro", "Sightseeing Bus", "Pedestrian") */
  prefab: string | null;
  /** PublicTransportWorldInfoPanel.GetLineType: by prefab name ("Sightseeing Bus" / "Pedestrian" / anything else) */
  lineType: 'default' | 'touristBus' | 'walkingTour';
  /** m_lineNumber as shown on the line */
  lineNumber: number;
  /** m_stops: node id of the first stop (the export's <Stop> list starts here); 0 = no stops */
  firstStop: number;
  /** m_color as #rrggbb, only when CustomColor is set; otherwise the game uses a per-type default not stored in the save */
  customColor: string | null;
  /** m_budget: the panel's vehicle count modifier, percent (100 = default) */
  budget: number;
  /** m_ticketPrice in cents; only for tourist bus lines (the only lines that charge it and show its slider) */
  ticketPrice: number | null;
  /** m_totalLength, metres along the route */
  totalLength: number;
  /** m_averageCount per group: what the line panel shows ("weekly passengers" = residents + tourists, age chart) */
  weekly: Passengers;
  /** m_finalCount per group: the last completed week, raw */
  lastWeek: Passengers;
  /** line panel age chart, percent [child, teen, young, adult, senior] from `weekly` (adult absorbs rounding) */
  ageShares: [number, number, number, number, number];
  /** line panel "trips saved" percent (shown for default lines only) */
  tripsSaved: number;
}

export interface SaveTransport {
  /** lines with m_flags != 0, by id */
  lines: SaveLine[];
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

/** PublicTransportWorldInfoPanel.GetPercentageValue: clamp(floor(value/total*100), 0, 100) in float32 */
function pct(value: number, total: number): number {
  const f = Math.fround(Math.fround(value / total) * 100);
  return Number.isFinite(f) ? Math.min(100, Math.max(0, Math.floor(f))) : 0;
}

/** Age chart exactly as PublicTransportWorldInfoPanel.UpdateBindings computes it. */
export function ageShares(p: Passengers): [number, number, number, number, number] {
  const total = p.residents + p.tourists;
  const a = pct(p.child, total), b = pct(p.teen, total), c = pct(p.young, total), e = pct(p.senior, total);
  let d = pct(p.adult, total);
  const sum = a + b + c + d + e;
  if (sum !== 0 && sum !== 100) d = 100 - (a + b + c + e);
  return [a, b, c, d, e];
}

/** "Trips saved" percent, PublicTransportWorldInfoPanel.UpdateBindings (integer C# arithmetic). */
export function tripsSaved(p: Passengers): number {
  const r = p.residents, t = p.tourists, n = r + t;
  let w = 0;
  if (n !== 0) {
    const h = n >> 1;
    w += p.teen * 5;
    w += p.young * Math.trunc((15 * r + 20 * t + h) / n);
    w += p.adult * Math.trunc((20 * r + 20 * t + h) / n);
    w += p.senior * Math.trunc((10 * r + 20 * t + h) / n);
    w |= 0;
  }
  if (w === 0) return 0;
  const v = Math.trunc((p.carOwning * 10000 + (w >> 1)) / w);
  return Math.min(100, Math.max(0, v));
}

export function readTransport(sd: SaveData): SaveTransport {
  const sec = section(sd, 'TransportManager');
  if (!sec) throw new SaveError('corrupt', 'TransportManager section missing');
  const { s, end } = sec;

  const flags = s.eaU32(LINE_COUNT - 1); // slots 1..255
  const ids: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) ids.push(i + 1);
  const milestones = s.u16(); // unlock milestones written in game mode
  const prefabIdx = s.eaU16(ids.length + milestones);
  const nPrefab = s.u16();
  const prefabNames: (string | null)[] = [];
  for (let i = 0; i < nPrefab; i++) prefabNames.push(s.ustr());
  for (let i = 0; i < milestones; i++) s.obj();
  for (let i = 0; i < TYPE_COUNT; i++) s.u16(); // next line number per type

  // TransportPassengerData.Serialize: 8 groups x (temp, final, average) uint24
  const group = (): [Passengers, Passengers] => {
    const last = {} as Passengers, avg = {} as Passengers;
    for (const k of ['residents', 'tourists', 'child', 'teen', 'young', 'adult', 'senior', 'carOwning'] as const) {
      s.u24(); last[k] = s.u24(); avg[k] = s.u24();
    }
    return [last, avg];
  };

  const lines: SaveLine[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k], f = flags[id - 1];
    const prefab = prefabNames[prefabIdx[k]] ?? null;
    const lineType = prefab === 'Sightseeing Bus' ? 'touristBus' : prefab === 'Pedestrian' ? 'walkingTour' : 'default';
    const lineNumber = s.u16(), firstStop = s.u16();
    const r = s.u8(), g = s.u8(), b = s.u8();
    s.u16(); // m_building
    const budget = s.u16(), totalLength = s.f32();
    s.u8(); // m_averageInterval
    const ticket = s.u16();
    const [lastWeek, weekly] = group();
    lines.push({
      id, flags: f, prefab, lineType, lineNumber, firstStop,
      customColor: f & LINE_CUSTOM_COLOR ? hex(r, g, b) : null,
      budget, ticketPrice: lineType === 'touristBus' ? ticket : null, totalLength,
      weekly, lastWeek, ageShares: ageShares(weekly), tripsSaved: tripsSaved(weekly),
    });
  }
  for (let i = 0; i < TYPE_COUNT; i++) group(); // city totals per transport type
  for (let i = 0; i < 7; i++) s.obj(); // guide objects
  const nSel = s.i16();
  for (let i = 0; i < nSel; i++) { s.i16(); s.sstr(); } // per-line vehicle selection
  endSection(s, end, 'TransportManager');
  return { lines };
}
