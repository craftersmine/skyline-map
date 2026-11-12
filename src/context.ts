// Additional context: facts the player knows but CSLMap exports leave out
// (currency, toll fees, transit fares, transfer rules). Stored per city in
// IndexedDB, never written into the map file.
//
// Entries are lists of { ref, data }: `ref` remembers how to find the entity
// again (id, name, position) so an updated export of the same city keeps its
// fees even when the game renumbered a booth or a line. Entries that match
// nothing in the current export are kept, not dropped, and the editor shows them.
// A new kind of context is a new list with its own ref + matcher.
import { locale } from './i18n';

export interface Currency { code: string; symbol: string; decimals: number; position: 'before' | 'after'; space: boolean }
/** +amount for every started `everyKm` beyond the previous threshold, up to `uptoKm` (null = no limit) */
export interface FareTier { everyKm: number; amount: number; uptoKm: number | null }
export interface FareRule { base: number; includedKm: number; tiers: FareTier[] }
/**
 * separate:   every boarding pays its full fare (the game's own behaviour);
 * max:        one ticket per journey: transfers only pay the difference up to the dearest ride;
 * integrated: one fare per journey: the highest base fare, plus the distance surcharge
 *             of that line applied to the whole distance ridden.
 * A journey ends when a transfer is outside the window or past the transfer limit.
 */
export interface TransferRule { mode: 'separate' | 'max' | 'integrated'; windowMin: number | null; maxTransfers: number | null }

export interface TollRef { id: number; name: string; x: number; z: number }
export interface LineRef { id: number; name: string; mode: string }
export interface CityContext {
  format: 'skyline-atlas-context'; schema: 1;
  city: string; updated: string;
  currency: Currency;
  /** fee for booths without their own (booths with no building in the export are excluded) */
  tollDefault: number | null;
  tolls: { ref: TollRef; fee: number }[];
  /** fare for every line of a mode (bus, metro…) without its own */
  fareDefaults: Record<string, FareRule>;
  fares: { ref: LineRef; rule: FareRule }[];
  transfer: TransferRule;
}

export const CURRENCIES: Currency[] = [
  { code: 'KRW', symbol: '₩', decimals: 0, position: 'before', space: false },
  { code: 'USD', symbol: '$', decimals: 2, position: 'before', space: false },
  { code: 'EUR', symbol: '€', decimals: 2, position: 'after', space: true },
  { code: 'JPY', symbol: '¥', decimals: 0, position: 'before', space: false },
  { code: 'GBP', symbol: '£', decimals: 2, position: 'before', space: false },
  { code: 'RUB', symbol: '₽', decimals: 2, position: 'after', space: true}
];

export function defaultCurrency(lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US'): Currency {
  const l = lang.toLowerCase();
  const code = l.startsWith('ko') ? 'KRW' : l.startsWith('ja') ? 'JPY' : l.startsWith('ru') ? 'RUB' : l === 'en-gb' ? 'GBP' : /^(de|fr|es|it|nl|pt-pt|fi|el|sk|sl|et|lv|lt)/.test(l) ? 'EUR' : 'USD';
  return { ...CURRENCIES.find((c) => c.code === code)! };
}

export function emptyContext(city: string): CityContext {
  return { format: 'skyline-atlas-context', schema: 1, city, updated: new Date().toISOString(), currency: defaultCurrency(), tollDefault: null, tolls: [], fareDefaults: {}, fares: [], transfer: { mode: 'separate', windowMin: 30, maxTransfers: 4 } };
}

export function fmtMoney(v: number, c: Currency): string {
  const n = Math.abs(v).toLocaleString(locale(), { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals });
  const s = c.position === 'before' ? `${c.symbol}${c.space ? ' ' : ''}${n}` : `${n}${c.space ? ' ' : ''}${c.symbol}`;
  return v < 0 ? '−' + s : s;
}

// ------------------------------------------------------------------ fares

const EPS = 1e-9;
/** Fare for riding `km` on a line with this rule. */
export function fareFor(r: FareRule, km: number): number {
  let total = r.base, from = r.includedKm;
  for (const t of r.tiers) {
    const to = t.uptoKm ?? Infinity;
    if (to <= from) continue;
    const part = Math.min(km, to) - from;
    if (part > EPS && t.everyKm > 0) total += Math.ceil(part / t.everyKm - EPS) * t.amount;
    from = to;
  }
  return total;
}

export interface Ride { label: string; mode: string; km: number; /** seconds from departure to boarding (estimated) */ boardAt: number; rule: FareRule | null }
export interface FareItem { ride: number; full: number | null; charged: number | null; transfer: boolean }
export interface FareResult { total: number; items: FareItem[]; missing: number[] }

export function journeyFare(rides: Ride[], tr: TransferRule): FareResult {
  const items: FareItem[] = rides.map((r, i) => ({ ride: i, full: r.rule ? fareFor(r.rule, r.km) : null, charged: null, transfer: false }));
  const missing = rides.map((r, i) => (r.rule ? -1 : i)).filter((i) => i >= 0);
  const priced = rides.map((r, i) => i).filter((i) => rides[i].rule);
  const groupFare = (g: number[]) => {
    if (tr.mode === 'max') return Math.max(...g.map((i) => items[i].full!));
    // integrated: the highest base fare's line sets the distance schedule for the whole journey
    const top = g.reduce((a, i) => (rides[i].rule!.base > rides[a].rule!.base ? i : a), g[0]);
    return fareFor(rides[top].rule!, g.reduce((s, i) => s + rides[i].km, 0));
  };
  let group: number[] = [];
  for (const i of priced) {
    const start = group[0];
    const joins = tr.mode !== 'separate' && group.length > 0
      && (tr.maxTransfers === null || group.length <= tr.maxTransfers)
      && (tr.windowMin === null || rides[i].boardAt - rides[start].boardAt <= tr.windowMin * 60 + EPS);
    if (!joins) { group = [i]; items[i].charged = items[i].full; continue; }
    const before = groupFare(group);
    group.push(i);
    items[i].charged = Math.max(0, groupFare(group) - before);
    items[i].transfer = true;
  }
  return { total: items.reduce((s, it) => s + (it.charged ?? 0), 0), items, missing };
}

export function tollTotal(fees: (number | null)[]) {
  return { total: fees.reduce<number>((s, f) => s + (f ?? 0), 0), missing: fees.filter((f) => f === null).length };
}

// ------------------------------------------------------------------ matching entries to the current export

/** Booth ids matched by each saved toll entry (index → booth id), and the indices that matched nothing. */
export function matchTolls(saved: { ref: TollRef }[], booths: TollRef[]): { byEntry: Map<number, number>; unmatched: number[] } {
  const near = (a: TollRef, b: TollRef) => Math.hypot(a.x - b.x, a.z - b.z);
  const taken = new Set<number>(), byEntry = new Map<number, number>();
  const pass = (pick: (r: TollRef) => TollRef | undefined) => saved.forEach((e, i) => {
    if (byEntry.has(i)) return;
    const b = pick(e.ref);
    if (b && !taken.has(b.id)) { taken.add(b.id); byEntry.set(i, b.id); }
  });
  pass((r) => booths.find((b) => b.id === r.id && near(b, r) < 40));                        // same booth
  pass((r) => (r.name ? booths.filter((b) => b.name === r.name && !taken.has(b.id)) : []).length === 1 ? booths.find((b) => b.name === r.name) : undefined); // renumbered, same name
  pass((r) => booths.filter((b) => !taken.has(b.id) && near(b, r) < 40).sort((a, b) => near(a, r) - near(b, r))[0]); // rebuilt in place
  return { byEntry, unmatched: saved.map((_, i) => i).filter((i) => !byEntry.has(i)) };
}

export function matchLines(saved: { ref: LineRef }[], lines: LineRef[]): { byEntry: Map<number, number>; unmatched: number[] } {
  const taken = new Set<number>(), byEntry = new Map<number, number>();
  const pass = (pick: (r: LineRef) => LineRef | undefined) => saved.forEach((e, i) => {
    if (byEntry.has(i)) return;
    const l = pick(e.ref);
    if (l && !taken.has(l.id)) { taken.add(l.id); byEntry.set(i, l.id); }
  });
  pass((r) => lines.find((l) => l.id === r.id && l.name === r.name));
  pass((r) => { const c = lines.filter((l) => l.name === r.name && l.mode === r.mode && !taken.has(l.id)); return c.length === 1 ? c[0] : undefined; });
  pass((r) => lines.find((l) => l.id === r.id && l.mode === r.mode)); // renamed in game
  return { byEntry, unmatched: saved.map((_, i) => i).filter((i) => !byEntry.has(i)) };
}

// ------------------------------------------------------------------ import validation (files come from anywhere)

const num = (v: unknown, max = 1e9): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
function rule(v: any): FareRule | null {
  if (!v || typeof v !== 'object' || num(v.base) === null) return null;
  const tiers: FareTier[] = (Array.isArray(v.tiers) ? v.tiers.slice(0, 20) : []).flatMap((t: any) => {
    const everyKm = num(t?.everyKm, 1e4), amount = num(t?.amount), uptoKm = t?.uptoKm == null ? null : num(t.uptoKm, 1e5);
    return everyKm && amount !== null && (t?.uptoKm == null || uptoKm !== null) ? [{ everyKm, amount, uptoKm }] : [];
  });
  return { base: v.base, includedKm: num(v.includedKm, 1e5) ?? 0, tiers };
}
export function sanitizeContext(v: any, city: string): CityContext {
  if (!v || typeof v !== 'object' || v.format !== 'skyline-atlas-context') throw new Error('Not a Skyline Map context file');
  const out = emptyContext(city);
  const c = v.currency;
  if (c && typeof c === 'object' && str(c.symbol, 8)) out.currency = { code: str(c.code, 12) || 'CUSTOM', symbol: str(c.symbol, 8), decimals: Math.min(4, Math.round(num(c.decimals, 4) ?? 0)), position: c.position === 'after' ? 'after' : 'before', space: !!c.space };
  out.tollDefault = num(v.tollDefault);
  if (Array.isArray(v.tolls)) for (const t of v.tolls.slice(0, 10000)) {
    const fee = num(t?.fee), r = t?.ref;
    if (fee === null || !r || typeof r.id !== 'number' || typeof r.x !== 'number' || typeof r.z !== 'number') continue;
    out.tolls.push({ ref: { id: r.id, name: str(r.name), x: r.x, z: r.z }, fee });
  }
  if (v.fareDefaults && typeof v.fareDefaults === 'object') for (const [m, r] of Object.entries(v.fareDefaults).slice(0, 20)) { const ok = rule(r); if (ok && /^[a-z]{1,16}$/.test(m)) out.fareDefaults[m] = ok; }
  if (Array.isArray(v.fares)) for (const f of v.fares.slice(0, 10000)) {
    const ok = rule(f?.rule), r = f?.ref;
    if (ok && r && typeof r.id === 'number') out.fares.push({ ref: { id: r.id, name: str(r.name), mode: str(r.mode, 16) }, rule: ok });
  }
  const t = v.transfer;
  if (t && typeof t === 'object') out.transfer = { mode: ['separate', 'max', 'integrated'].includes(t.mode) ? t.mode : 'separate', windowMin: t.windowMin === null ? null : num(t.windowMin, 1440) ?? 30, maxTransfers: t.maxTransfers === null ? null : num(t.maxTransfers, 20) ?? 4 };
  return out;
}

// ------------------------------------------------------------------ storage (IndexedDB, localStorage fallback)

const DB = 'skyline-atlas', STORE = 'context';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'city' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function loadContext(city: string): Promise<CityContext | null> {
  try { return (await tx('readonly', (s) => s.get(city))) ?? null; }
  catch { try { const j = localStorage.getItem('atlas:ctx:' + city); return j ? JSON.parse(j) : null; } catch { return null; } }
}
export async function saveContext(c: CityContext): Promise<void> {
  c.updated = new Date().toISOString();
  try { await tx('readwrite', (s) => s.put(structuredClone(c))); }
  catch { localStorage.setItem('atlas:ctx:' + c.city, JSON.stringify(c)); }
}
