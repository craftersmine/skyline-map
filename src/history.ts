// City time-lapse: when did each road, building and transit line of the open city first appear? Older exports
// of the same city are scanned for identities only (no geometry), so dozens of saves stay cheap.
//
// The game reuses ids after something is demolished, so an id alone could credit a new road to an old one in
// the same slot. Identities therefore pair the id with what it connects or is: a segment's end nodes, a
// building's asset name, a line's type.
import { unescapeXml, type CityData } from './parse';

export interface HistoryKeys { segs: Map<string, number>; blds: Map<string, number>; lines: Map<string, number> }

const segKey = (id: string | number, sn: string | number, en: string | number) => `${id}:${sn}:${en}`;
const bldKey = (id: string | number, name: string) => `${id}:${name}`;
const lineKey = (id: string | number, type: string) => `${id}:${type}`;

/** Parse an export's own timestamp ("1/25/2026 11:34:45 PM"); NaN when missing or unreadable. */
export function exportTime(generated: string): number { return generated ? Date.parse(generated) : NaN; }

/** Identities of the open city, each with the earliest time seen (starting at the open export's time). */
export function cityKeys(city: CityData, time: number): HistoryKeys {
  const segs = new Map<string, number>(), blds = new Map<string, number>(), lines = new Map<string, number>();
  for (const s of city.segs) segs.set(segKey(s.id, s.sn, s.en), time);
  for (const b of city.buildings) blds.set(bldKey(b.id, b.name), time);
  for (const l of city.transports) lines.set(lineKey(l.id, l.type), time);
  return { segs, blds, lines };
}

/** Scan an older export: its city name and time, and lower the first-seen time of every identity it contains. */
export function scanExport(xml: string, keys: HistoryKeys): { name: string; time: number } {
  const name = unescapeXml(/<City>([^<]*)<\/City>/.exec(xml)?.[1] ?? '');
  const time = exportTime(/<Generated>([^<]*)<\/Generated>/.exec(xml)?.[1] ?? '');
  if (!Number.isFinite(time)) return { name, time };
  const lower = (m: Map<string, number>, k: string) => { const v = m.get(k); if (v !== undefined && time < v) m.set(k, time); };
  let r: RegExpExecArray | null;
  const seg = /<Seg id="(\d+)" sn="(\d+)" en="(\d+)"/g;
  while ((r = seg.exec(xml))) lower(keys.segs, segKey(r[1], r[2], r[3]));
  const bld = /<Buil id="(\d+)" name="([^"]*)"/g;
  while ((r = bld.exec(xml))) lower(keys.blds, bldKey(r[1], unescapeXml(r[2])));
  const line = /<Trans id="(\d+)" name="[^"]*" type="([^"]*)"/g;
  while ((r = line.exec(xml))) lower(keys.lines, lineKey(r[1], r[2]));
  return { name, time };
}

/** First-seen times by id, for tagging the open city's map features. */
export function bornById(city: CityData, keys: HistoryKeys) {
  const seg: [number, number][] = [], bld: [number, number][] = [], line: [number, number][] = [];
  for (const s of city.segs) seg.push([s.id, keys.segs.get(segKey(s.id, s.sn, s.en))!]);
  for (const b of city.buildings) bld.push([b.id, keys.blds.get(bldKey(b.id, b.name))!]);
  for (const l of city.transports) line.push([l.id, keys.lines.get(lineKey(l.id, l.type))!]);
  return { seg, bld, line };
}
