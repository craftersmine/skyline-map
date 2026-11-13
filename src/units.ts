// Display units: metric or imperial, for every distance, area, height and speed the page shows.
// The data stays metric (game metres); only the formatting changes. The choice is shared with the measure
// tool (same storage key) and defaults to metric.
import { fmtFixed, locale, t } from './i18n';

export type Units = 'metric' | 'imperial';
const KEY = 'atlas:units';
const FT = 3.28084, MI = 1609.344, FT2 = 10.7639, ACRE = 4046.86, MI2 = 2589988.11, MPH = 0.621371;

let units: Units = (() => { try { return localStorage.getItem(KEY) === 'imperial' ? 'imperial' : 'metric'; } catch { return 'metric'; } })();
const listeners = new Set<() => void>();

export const getUnits = () => units;
export const imperial = () => units === 'imperial';
export function setUnits(u: Units) {
  if (u === units) return;
  units = u;
  try { localStorage.setItem(KEY, u); } catch { /* storage blocked: this visit only */ }
  for (const f of listeners) f();
}
export function onUnits(f: () => void) { listeners.add(f); return () => listeners.delete(f); }

const int = (v: number) => Math.round(v).toLocaleString(locale());

/** Route distances, rounded like a navigation app: 10 m / 1 decimal km, or 10 ft / 1 decimal mi. */
export function fmtDist(m: number): string {
  if (imperial()) {
    const ft = m * FT;
    if (m < MI * 0.1) return `${int(Math.max(10, Math.round(ft / 10) * 10))} ft`;
    return `${fmtFixed(m / MI, m < MI * 9.5 ? 1 : 0)} mi`;
  }
  return m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${fmtFixed(m / 1000, m < 9500 ? 1 : 0)} km`;
}
/** Measured lengths (panels, records): metres / km with 2 decimals, or feet / miles with 2 decimals. */
export function fmtLength(m: number): string {
  if (imperial()) return m < MI * 0.1 ? `${int(m * FT)} ft` : `${fmtFixed(m / MI, m < MI * 10 ? 2 : 1)} mi`;
  return m < 1000 ? `${int(m)} m` : `${fmtFixed(m / 1000, m < 10000 ? 2 : 1)} km`;
}
/** A long total such as a city's road length: km or mi with one decimal. */
export const fmtLong = (m: number) => (imperial() ? `${fmtFixed(m / MI, 1)} mi` : `${fmtFixed(m / 1000, 1)} km`);
/** Heights, depths and widths: whole metres or feet. */
export const fmtHeight = (m: number) => (imperial() ? `${int(m * FT)} ft` : `${Math.round(m)} m`);
/** Widths given to a tenth of a metre (a road's carriageway): as given, or whole feet. */
export const fmtWidth = (m: number) => (imperial() ? `${int(m * FT)} ft` : `${m} m`);
/** Larger areas (reachable land, closures): ha / km², or acres / mi². */
export function fmtArea(m2: number): string {
  if (imperial()) return m2 < MI2 ? t('{n} acres', { n: fmtFixed(m2 / ACRE, m2 < ACRE * 100 ? 1 : 0) }) : `${fmtFixed(m2 / MI2, m2 < MI2 * 10 ? 2 : 1)} mi²`;
  return m2 < 1e6 ? `${fmtFixed(m2 / 1e4, 1)} ha` : `${fmtFixed(m2 / 1e6, m2 < 1e7 ? 2 : 1)} km²`;
}
/** A lot or building footprint: m², or ft². */
export const fmtAreaSmall = (m2: number) => (imperial() ? `${int(m2 * FT2)} ft²` : `${m2} m²`);
/** A district-sized area with two decimals: km², or mi². */
export const fmtAreaLarge = (m2: number) => (imperial() ? `${fmtFixed(m2 / MI2, 2)} mi²` : `${fmtFixed(m2 / 1e6, 2)} km²`);
/** Conversions for figures written elsewhere in metric (discoveries): metres → feet, km → miles, m² → ft², ha → acres. */
export const CONVERT = { ft: FT, mi: 1000 / MI, ft2: FT2, acres: 1e4 / ACRE };
/** A speed given in km/h, as a number in the chosen unit (mph rounded to whole numbers). */
export const speedValue = (kmh: number) => (imperial() ? Math.round(kmh * MPH) : Math.round(kmh));
export const speedUnit = () => (imperial() ? 'mph' : 'km/h');
export const fmtSpeed = (kmh: number) => `${speedValue(kmh)} ${speedUnit()}`;
/** Contour labels on the map are elevations in metres: this converts the map expression's value. */
export const FEET_PER_METRE = FT;

/** Spoken distance before a maneuver: the i18n key and the number to say. */
export function spokenDistance(m: number): { key: string; n: number } {
  if (imperial()) {
    const ft = m * FT;
    if (m >= MI * 0.2) return { key: 'In {n} miles, {instruction}', n: Math.round((m / MI) * 10) / 10 };
    return { key: 'In {n} feet, {instruction}', n: ft >= 500 ? Math.round(ft / 100) * 100 : Math.max(50, Math.round(ft / 50) * 50) };
  }
  return m >= 950 ? { key: 'In {n} kilometers, {instruction}', n: Math.round(m / 100) / 10 } : { key: 'In {n} meters, {instruction}', n: m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50) };
}
// i18n-keys
void ['{n} acres', 'In {n} miles, {instruction}', 'In {n} feet, {instruction}', 'In {n} kilometers, {instruction}', 'In {n} meters, {instruction}', 'Units', 'Metric', 'Imperial'];
// end i18n-keys
