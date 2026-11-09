// The additional-context store for the open city, and its editor sheet
// (currency, toll fees, transit fares, transfers, backup).
import type { BuiltCity } from './build';
import type { Route } from './router';
import { fromLngLat } from './geo';
import { iconDataUrl } from './icons';
import { bottomSheet } from './sheet';
import { t, tn, getLang, locale } from './i18n';
import {
  CURRENCIES, emptyContext, fmtMoney, fareFor, journeyFare, tollTotal, matchTolls, matchLines,
  sanitizeContext, loadContext, saveContext, type CityContext, type Currency, type FareRule, type TollRef, type LineRef, type FareResult, type TransferRule,
} from './context';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// i18n-keys
const MODE_LABEL: Record<string, string> = { bus: 'Bus', tram: 'Tram', metro: 'Metro', train: 'Train', monorail: 'Monorail', ferry: 'Ferry', cablecar: 'Cable car', other: 'Other' };
// end i18n-keys
const modeLabel = (m: string) => (MODE_LABEL[m] ? t(MODE_LABEL[m]) : m);
const MODE_ORDER = ['train', 'metro', 'monorail', 'tram', 'bus', 'ferry', 'cablecar', 'other'];

export interface Booth extends TollRef { road: string; unconfirmed: boolean }
export interface CityLine extends LineRef { color: string }
export type Source = 'own' | 'default' | null;
export interface TollCost { total: number; missing: number; fees: { booth: number; name: string; fee: number | null; source: Source }[] }
export interface FareCost extends FareResult { rides: { name: string; color: string; mode: string; km: number; source: Source }[] }

/** Short human summary of a fare rule, in the city currency. */
export function describeRule(r: FareRule, c: Currency): string {
  const m = (v: number) => fmtMoney(v, c);
  const parts = [r.tiers.length ? t('{fee} up to {km} km', { fee: m(r.base), km: r.includedKm }) : m(r.base)];
  let from = r.includedKm;
  for (const ti of r.tiers) {
    const v = { fee: m(ti.amount), every: ti.everyKm, km: ti.uptoKm ?? 0 };
    parts.push(ti.uptoKm !== null ? t('+{fee} per {every} km to {km} km', v) : from ? t('+{fee} per {every} km after', v) : t('+{fee} per {every} km', v));
    from = ti.uptoKm ?? from;
  }
  return parts.join(', ');
}

// ------------------------------------------------------------------ store
export function createContextStore() {
  let ctx: CityContext | null = null;
  let booths: Booth[] = [], lines: CityLine[] = [];
  let tollIdx = new Map<number, number>(), lineIdx = new Map<number, number>();
  let unmatched = { tolls: [] as number[], fares: [] as number[] };
  const listeners = new Set<(origin?: string) => void>();
  let attachId = 0;

  function reindex() {
    if (!ctx) return;
    const tm = matchTolls(ctx.tolls, booths), f = matchLines(ctx.fares, lines);
    tollIdx = new Map([...tm.byEntry].map(([i, id]) => [id, i]));
    lineIdx = new Map([...f.byEntry].map(([i, id]) => [id, i]));
    unmatched = { tolls: tm.unmatched, fares: f.unmatched };
    // refresh refs so the next export keeps finding them under their current ids
    for (const [id, i] of tollIdx) { const b = booths.find((x) => x.id === id)!; ctx.tolls[i].ref = { id: b.id, name: b.name, x: b.x, z: b.z }; }
    for (const [id, i] of lineIdx) { const l = lines.find((x) => x.id === id)!; ctx.fares[i].ref = { id: l.id, name: l.name, mode: l.mode }; }
  }
  const emit = (origin?: string) => listeners.forEach((f) => f(origin));
  async function commit(origin?: string) { if (!ctx) return; reindex(); emit(origin); await saveContext(ctx); }

  return {
    on: (f: (origin?: string) => void) => listeners.add(f),
    get ctx() { return ctx; },
    get booths() { return booths; },
    get lines() { return lines; },
    get unmatched() { return unmatched; },
    currency: (): Currency => ctx?.currency ?? emptyContext('').currency,
    money(v: number) { return fmtMoney(v, this.currency()); },

    async attach(city: BuiltCity) {
      const id = ++attachId;
      booths = city.sources.places.features.filter((f) => f.properties.kind === 'toll').map((f) => {
        const p = f.properties as any, [x, z] = fromLngLat(...((f.geometry as any).coordinates as [number, number]));
        return { id: +p.id, name: p.named ? String(p.name) : '', x, z, road: String(p.roads || '').split(' · ')[0] || String(p.roadTypes || '').split(' · ')[0] || '', unconfirmed: !!p.unconfirmed };
      });
      lines = city.meta.lines.filter((l) => l.type !== 'tour' && l.type !== 'air').map((l) => ({ id: l.id, name: l.name, mode: l.type, color: l.color }));
      const saved = await loadContext(city.meta.name);
      if (id !== attachId) return; // another city opened meanwhile
      ctx = saved ? sanitizeContext(saved, city.meta.name) : emptyContext(city.meta.name);
      reindex(); emit();
    },

    tollFee(booth: number): { fee: number | null; source: Source } {
      const i = tollIdx.get(booth);
      if (ctx && i !== undefined) return { fee: ctx.tolls[i].fee, source: 'own' };
      const b = booths.find((x) => x.id === booth);
      if (ctx && ctx.tollDefault !== null && b && !b.unconfirmed) return { fee: ctx.tollDefault, source: 'default' };
      return { fee: null, source: null };
    },
    setTollFee(booth: number, fee: number | null, origin?: string) {
      if (!ctx) return;
      const i = tollIdx.get(booth), b = booths.find((x) => x.id === booth);
      if (!b) return;
      if (fee === null) { if (i !== undefined) ctx.tolls.splice(i, 1); }
      else if (i !== undefined) ctx.tolls[i].fee = fee;
      else ctx.tolls.push({ ref: { id: b.id, name: b.name, x: b.x, z: b.z }, fee });
      return commit(origin);
    },
    setTollDefault(fee: number | null, origin?: string) { if (ctx) { ctx.tollDefault = fee; return commit(origin); } },

    lineRule(line: number): { rule: FareRule | null; source: Source } {
      const i = lineIdx.get(line);
      if (ctx && i !== undefined) return { rule: ctx.fares[i].rule, source: 'own' };
      const l = lines.find((x) => x.id === line);
      const d = l && ctx?.fareDefaults[l.mode];
      return d ? { rule: d, source: 'default' } : { rule: null, source: null };
    },
    setLineRule(line: number, rule: FareRule | null, origin?: string) {
      if (!ctx) return;
      const i = lineIdx.get(line), l = lines.find((x) => x.id === line);
      if (!l) return;
      if (rule === null) { if (i !== undefined) ctx.fares.splice(i, 1); }
      else if (i !== undefined) ctx.fares[i].rule = rule;
      else ctx.fares.push({ ref: { id: l.id, name: l.name, mode: l.mode }, rule });
      return commit(origin);
    },
    setModeDefault(mode: string, rule: FareRule | null, origin?: string) {
      if (!ctx) return;
      if (rule) ctx.fareDefaults[mode] = rule; else delete ctx.fareDefaults[mode];
      return commit(origin);
    },
    setCurrency(c: Currency, origin?: string) { if (ctx) { ctx.currency = c; return commit(origin); } },
    setTransfer(tr: TransferRule, origin?: string) { if (ctx) { ctx.transfer = tr; return commit(origin); } },
    removeUnmatched() {
      if (!ctx) return;
      const dt = new Set(unmatched.tolls), df = new Set(unmatched.fares);
      ctx.tolls = ctx.tolls.filter((_, i) => !dt.has(i)); ctx.fares = ctx.fares.filter((_, i) => !df.has(i));
      return commit();
    },
    reset() { if (ctx) { ctx = { ...emptyContext(ctx.city), currency: ctx.currency }; return commit(); } },
    exportJson: () => JSON.stringify(ctx, null, 2),
    /** replaces this city's context with the file's (validated) content; returns the file's city name */
    importJson(text: string) {
      if (!ctx) throw new Error(t('Open a city first'));
      const raw = JSON.parse(text);
      ctx = sanitizeContext(raw, ctx.city);
      void commit();
      return typeof raw.city === 'string' ? raw.city : '';
    },

    /** toll fees along a driving route */
    tollCost(r: Route): TollCost | null {
      if (!r.tolls?.length) return null;
      const fees = r.tolls.map((tp) => ({ booth: tp.booth, name: tp.name, ...this.tollFee(tp.booth) }));
      return { ...tollTotal(fees.map((f) => f.fee)), fees };
    },
    /** fare of a transit route: ride distance along the line, transfers by the city's rule */
    fareCost(r: Route): FareCost | null {
      if (!ctx || r.mode !== 'transit') return null;
      let elapsed = 0;
      const rides: FareCost['rides'] = [], input: Parameters<typeof journeyFare>[0] = [];
      for (const l of r.legs) {
        if (l.kind === 'ride' && l.line) {
          const { rule, source } = this.lineRule(l.line.id);
          input.push({ label: l.line.name, mode: l.line.mode, km: l.dist / 1000, boardAt: elapsed + (l.wait ?? 0), rule });
          rides.push({ name: l.line.name, color: l.line.color, mode: l.line.mode, km: l.dist / 1000, source });
        }
        elapsed += l.time;
      }
      if (!input.length) return null;
      return { ...journeyFare(input, ctx.transfer), rides };
    },
  };
}
export type ContextStore = ReturnType<typeof createContextStore>;

/** a money input with the city's currency symbol on its side */
export function moneyField(store: ContextStore, attrs: string, v: number | null, ph = '') {
  const c = store.currency(), sym = `<i>${esc(c.symbol)}</i>`;
  const step = c.decimals ? (1 / 10 ** c.decimals).toString() : '1';
  return `<span class="money${c.position === 'after' ? ' after' : ''}">${c.position === 'before' ? sym : ''}<input type="number" inputmode="decimal" min="0" step="${step}" ${attrs} value="${v ?? ''}" placeholder="${esc(ph)}">${c.position === 'after' ? sym : ''}</span>`;
}
/** parse a money input: blank → null, rounded to the currency's decimals */
export function parseMoney(store: ContextStore, s: string): number | null {
  if (s.trim() === '') return null;
  const v = Number(s), k = 10 ** store.currency().decimals;
  return Number.isFinite(v) && v >= 0 ? Math.round(v * k) / k : null;
}

// ------------------------------------------------------------------ editor sheet

type Tab = 'currency' | 'tolls' | 'fares' | 'backup';
const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const CLOSE = 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z';

export function createContextEditor(store: ContextStore, hooks: { flyTo: (x: number, z: number) => void; toast: (s: string) => void; onOpen: () => void }) {
  const el = document.createElement('aside');
  el.id = 'ctx'; el.className = 'card'; el.hidden = true;
  el.innerHTML = '<div class="ctx-wrap"></div>';
  document.body.appendChild(el);
  const wrap = el.querySelector('.ctx-wrap') as HTMLElement;
  const sheet = bottomSheet(el, { scroll: () => (el.querySelector('.ctx-body') as HTMLElement) ?? wrap, snaps: ['half', 'full'], peek: () => 0, onDismiss: () => close() });
  const st = { tab: 'tolls' as Tab, editing: '' as string, q: '', draft: null as FareRule | null };

  const cur = () => store.currency();
  const moneyIn = (attrs: string, v: number | null, ph = '') => moneyField(store, attrs, v, ph);
  const money = (s: string) => parseMoney(store, s);

  let renderedTab: Tab | null = null;
  function render() {
    const c = store.ctx;
    if (!c) { wrap.innerHTML = ''; return; }
    // re-rendering replaces the scroll area: keep the reader's place unless the tab changed
    const keep = renderedTab === st.tab ? wrap.querySelector('.ctx-body')?.scrollTop ?? 0 : 0;
    renderedTab = st.tab;
    const tabs: [Tab, string][] = [['tolls', t('Tolls')], ['fares', t('Transit fares')], ['currency', t('Currency')], ['backup', t('Backup')]];
    wrap.innerHTML = `
      <div class="ctx-head" data-sheet-drag><div><b>${t('City pricing')}</b><div class="muted small">${esc(t('{city} · saved in this browser', { city: c.city }))}</div></div>
        <button class="icon-btn" data-close aria-label="${t('Close')}">${svg(CLOSE)}</button></div>
      <div class="ctx-tabs" role="tablist">${tabs.map(([tb, l]) => `<button role="tab" data-tab="${tb}" class="${st.tab === tb ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="ctx-body">${st.tab === 'currency' ? currencyTab() : st.tab === 'tolls' ? tollsTab() : st.tab === 'fares' ? faresTab() : backupTab()}</div>`;
    if (keep) wrap.querySelector('.ctx-body')!.scrollTop = keep;
  }

  // ---------------------------------------------------------------- currency
  function currencyTab() {
    const c = cur();
    const preset = CURRENCIES.find((p) => p.code === c.code && p.symbol === c.symbol);
    return `<p class="ctx-intro">${t('Used for every toll and fare in this city.')}</p>
      <div class="ctx-presets">${CURRENCIES.map((p) => `<button class="chip-btn${preset?.code === p.code ? ' on' : ''}" data-preset="${p.code}"><b>${esc(p.symbol)}</b> ${p.code}</button>`).join('')}<button class="chip-btn${preset ? '' : ' on'}" data-preset="custom">${t('Custom')}</button></div>
      <div class="ctx-form">
        <label>${t('Code')}<input data-cur="code" value="${esc(c.code)}" maxlength="12"></label>
        <label>${t('Symbol')}<input data-cur="symbol" value="${esc(c.symbol)}" maxlength="8"></label>
        <label>${t('Decimals')}<select data-cur="decimals">${[0, 1, 2, 3].map((d) => `<option ${c.decimals === d ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label>${t('Symbol position')}<select data-cur="position"><option value="before" ${c.position === 'before' ? 'selected' : ''}>${t('Before amount')}</option><option value="after" ${c.position === 'after' ? 'selected' : ''}>${t('After amount')}</option></select></label>
        <label class="ctx-check"><input type="checkbox" data-cur="space" ${c.space ? 'checked' : ''}> ${t('Space between symbol and amount')}</label>
      </div>
      <div class="ctx-preview"><span class="muted small">${t('Preview')}</span><b>${esc(fmtMoney(1234.5, c))}</b><b>${esc(fmtMoney(1450, c))}</b></div>`;
  }

  // ---------------------------------------------------------------- tolls
  const boothName = (b: Booth) => b.name || (b.unconfirmed ? t('Toll lanes') : t('Toll booth'));
  const boothCount = () => `${tn(store.booths.length, '{n} booth', '{n} booths')} · ${t('{n} with their own fee', { n: store.booths.filter((b) => store.tollFee(b.id).source === 'own').length })}`;
  function tollsTab() {
    const c = store.ctx!, bs = store.booths;
    if (!bs.length) return `<div class="ctx-empty">${t('This city has no toll booths.')}</div>${orphanNote()}`;
    const q = st.q.toLowerCase();
    const list = bs.filter((b) => !q || boothName(b).toLowerCase().includes(q) || b.road.toLowerCase().includes(q));
    return `<p class="ctx-intro">${t('The export has no toll prices. Set a fee per booth, or one default for all of them. Drivers are charged each time a route passes through a booth.')}</p>
      <div class="ctx-row ctx-default"><div><b>${t('Default fee')}</b><div class="muted small">${t('For booths without their own fee')}</div></div>${moneyIn('data-toll-default', c.tollDefault, t('Not set'))}</div>
      <div class="ctx-sub"><span>${boothCount()}</span>${bs.length > 6 ? `<input type="search" class="ctx-search" data-q placeholder="${t('Filter booths')}" value="${esc(st.q)}">` : ''}</div>
      <div class="ctx-list">${list.map((b) => {
        const own = store.tollFee(b.id), def = c.tollDefault;
        return `<div class="ctx-row" data-booth-row="${b.id}"><button class="ctx-name" data-fly="${b.x},${b.z}" title="${t('Show on map')}"><img src="${iconDataUrl('toll')}" alt=""><span><b>${esc(boothName(b))}</b><span class="muted small">${esc(b.road || t('Unnamed road'))}${b.unconfirmed ? ' · ' + t('no booth building') : ''}</span></span></button>
          ${moneyIn(`data-booth="${b.id}"`, own.source === 'own' ? own.fee : null, def !== null && !b.unconfirmed ? t('{fee} default', { fee: fmtMoney(def, cur()) }) : t('Not set'))}</div>`;
      }).join('') || `<div class="ctx-empty">${t('No booth matches.')}</div>`}</div>${orphanNote()}`;
  }

  // ---------------------------------------------------------------- fares
  function ruleEditor(key: string, r: FareRule, canRemove: string) {
    const kmIn = (attr: string, v: number | null, ph = '') => `<span class="km"><input type="number" inputmode="decimal" min="0" step="0.1" ${attr} value="${v ?? ''}" placeholder="${ph}"><i>km</i></span>`;
    const samples = [3, 10, 20, 40].map((km) => `<span><small>${km} km</small>${esc(fmtMoney(fareFor(r, km), cur()))}</span>`).join('');
    return `<div class="rule-ed" data-rule="${esc(key)}">
      <div class="re-line"><span>${t('Base fare')}</span>${moneyIn('data-f="base"', r.base)}</div>
      <div class="re-line"><span>${t('Base fare covers the first')}</span>${kmIn('data-f="included"', r.includedKm)}</div>
      ${r.tiers.map((ti, i) => `<div class="re-tier"><span>${t('then +')}</span>${moneyIn(`data-t="${i}" data-k="amount"`, ti.amount)}<span>${t('every')}</span>${kmIn(`data-t="${i}" data-k="everyKm"`, ti.everyKm)}<span>${t('up to')}</span>${kmIn(`data-t="${i}" data-k="uptoKm"`, ti.uptoKm, t('no limit'))}<button class="icon-btn sm" data-del-tier="${i}" aria-label="${t('Remove surcharge')}">${svg(CLOSE)}</button></div>`).join('')}
      <button class="link-btn" data-add-tier>${t('+ Add distance surcharge')}</button>
      <div class="re-samples" title="${t('Fare for a single ride of this length')}">${samples}</div>
      <div class="re-actions">${canRemove ? `<button class="pill ghost" data-rule-remove>${canRemove}</button>` : ''}<span></span><button class="pill ghost" data-rule-cancel>${t('Cancel')}</button><button class="pill primary" data-rule-save>${t('Save')}</button></div>
    </div>`;
  }
  function faresTab() {
    const c = store.ctx!, tr = c.transfer;
    const modes = MODE_ORDER.filter((m) => store.lines.some((l) => l.mode === m));
    if (!modes.length) return `<div class="ctx-empty">${t('This city has no transit lines.')}</div>${orphanNote()}`;
    const fareTxt = (r: FareRule | null) => (r ? esc(describeRule(r, cur())) : `<span class="muted">${t('Not set')}</span>`);
    const transfer = `<div class="ctx-card"><b>${t('Transfers')}</b>
      <div class="seg" role="radiogroup">${([['separate', t('Pay every ride')], ['max', t('One ticket')], ['integrated', t('Distance-integrated')]] as const).map(([m, l]) => `<button role="radio" data-tmode="${m}" class="${tr.mode === m ? 'on' : ''}" aria-checked="${tr.mode === m}">${l}</button>`).join('')}</div>
      <p class="muted small">${tr.mode === 'separate' ? t('Each boarding pays its line’s full fare, as in the base game.') : tr.mode === 'max' ? t('A journey pays once: a transfer to a dearer line pays only the difference.') : t('A journey pays the highest base fare once, plus that line’s distance surcharge over the total distance ridden (like Seoul’s integrated fares).')}</p>
      ${tr.mode === 'separate' ? '' : `<div class="ctx-form two"><label>${t('Transfer window')}<span class="km"><input type="number" min="0" data-tw value="${tr.windowMin ?? ''}" placeholder="${t('no limit')}"><i>${t('min')}</i></span></label><label>${t('Max transfers')}<input type="number" min="0" max="20" data-tm value="${tr.maxTransfers ?? ''}" placeholder="${t('no limit')}"></label></div><p class="muted small">${t('Measured from the first boarding, using the estimated travel times.')}</p>`}
    </div>`;
    return `<p class="ctx-intro">${t('Set a fare for each mode, then override single lines. Distance surcharges use the distance actually ridden along the line.')}</p>${transfer}
      ${modes.map((m) => {
        const ls = store.lines.filter((l) => l.mode === m).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const dk = 'mode:' + m, def = c.fareDefaults[m] ?? null;
        return `<div class="ctx-group"><div class="ctx-gh"><img src="${iconDataUrl(m)}" alt=""><b>${esc(modeLabel(m))}</b><span class="muted small">${tn(ls.length, '{n} line', '{n} lines')}</span></div>
          <div class="ctx-row fare-row default"><div><b>${esc(t('All {mode} lines', { mode: getLang() === 'en' ? modeLabel(m).toLowerCase() : modeLabel(m) }))}</b><div class="small">${fareTxt(def)}</div></div>${st.editing === dk ? '' : `<button class="pill" data-edit="${dk}">${def ? t('Edit') : t('Set fare')}</button>`}</div>
          ${st.editing === dk ? ruleEditor(dk, st.draft!, def ? t('Remove default') : '') : ''}
          ${ls.map((l) => {
            const k = 'line:' + l.id, r = store.lineRule(l.id);
            return `<div class="ctx-row fare-row" id="ctx-line-${l.id}"><div><span class="bullet" style="background:${l.color}"></span><b>${esc(l.name)}</b><div class="small">${r.source === 'own' ? fareTxt(r.rule) : r.source === 'default' ? `<span class="muted">${t('Uses the default')}</span>` : `<span class="muted">${t('Not set')}</span>`}</div></div>${st.editing === k ? '' : `<button class="pill" data-edit="${k}">${r.source === 'own' ? t('Edit') : t('Custom fare')}</button>`}</div>
              ${st.editing === k ? ruleEditor(k, st.draft!, r.source === 'own' ? (def ? t('Use default') : t('Remove fare')) : '') : ''}`;
          }).join('')}</div>`;
      }).join('')}${orphanNote()}`;
  }

  // ---------------------------------------------------------------- backup
  function backupTab() {
    const c = store.ctx!;
    const nd = Object.keys(c.fareDefaults).length;
    const n = c.tolls.length + c.fares.length + nd + (c.tollDefault !== null ? 1 : 0);
    const big = (k: number, one: string, other: string) => `<span>${tn(k, one, other).replace(k.toLocaleString(locale()), `<b>${k.toLocaleString(locale())}</b>`)}</span>`;
    return `<p class="ctx-intro">${t('Pricing is kept in this browser, separate from the map file, and follows the city to newer exports of the same save. Export it to back it up or share it.')}</p>
      <div class="ctx-card"><div class="ctx-stats">${big(c.tolls.length, '{n} toll fee', '{n} toll fees')}${big(c.fares.length, '{n} line fare', '{n} line fares')}${big(nd, '{n} mode default', '{n} mode defaults')}</div>
      <div class="muted small">${t('Last changed {date}', { date: new Date(c.updated).toLocaleString(locale()) })}</div></div>
      <div class="ctx-actions"><button class="pill primary" data-export ${n ? '' : 'disabled'}>${t('Export JSON')}</button><label class="pill">${t('Import JSON')}<input type="file" accept=".json,application/json" data-import hidden></label><button class="pill danger" data-reset ${n ? '' : 'disabled'}>${t('Clear all')}</button></div>
      ${orphanNote()}`;
  }
  function orphanNote() {
    const u = store.unmatched, n = u.tolls.length + u.fares.length;
    if (!n) return '';
    const names = [...u.tolls.map((i) => store.ctx!.tolls[i].ref.name || t('unnamed booth')), ...u.fares.map((i) => store.ctx!.fares[i].ref.name)].slice(0, 6);
    return `<div class="ctx-orphans"><b>${tn(n, '{n} saved price not found in this export', '{n} saved prices not found in this export')}</b><div class="small">${names.map(esc).join(', ')}${n > 6 ? '…' : ''}. ${t('They are kept in case the booth or line comes back.')}</div><button class="link-btn" data-drop-orphans>${t('Remove them')}</button></div>`;
  }

  // ---------------------------------------------------------------- events
  const ruleFromEditor = (box: HTMLElement): FareRule => {
    const val = (s: string) => (box.querySelector(s) as HTMLInputElement | null)?.value ?? '';
    const n = (s: string) => { const v = Number(val(s)); return val(s).trim() !== '' && Number.isFinite(v) && v >= 0 ? v : null; };
    return {
      base: money(val('[data-f="base"]')) ?? 0,
      includedKm: n('[data-f="included"]') ?? 0,
      tiers: st.draft!.tiers.map((_, i) => ({ amount: money(val(`[data-t="${i}"][data-k="amount"]`)) ?? 0, everyKm: n(`[data-t="${i}"][data-k="everyKm"]`) ?? 0, uptoKm: n(`[data-t="${i}"][data-k="uptoKm"]`) })),
    };
  };
  el.addEventListener('click', async (e) => {
    const tg = e.target as HTMLElement, c = store.ctx;
    if (!c) return;
    if (tg.closest('[data-close]')) return close();
    const tab = (tg.closest('[data-tab]') as HTMLElement | null)?.dataset.tab as Tab | undefined;
    if (tab) { st.tab = tab; st.editing = ''; return render(); }
    const fly = (tg.closest('[data-fly]') as HTMLElement | null)?.dataset.fly;
    if (fly) { const [x, z] = fly.split(',').map(Number); return hooks.flyTo(x, z); }
    const preset = (tg.closest('[data-preset]') as HTMLElement | null)?.dataset.preset;
    if (preset) { const p = CURRENCIES.find((x) => x.code === preset); await store.setCurrency(p ? { ...p } : { ...cur(), code: 'CUSTOM' }, 'ed'); render(); if (!p) (el.querySelector('[data-cur="symbol"]') as HTMLInputElement)?.select(); return; }
    const tm = (tg.closest('[data-tmode]') as HTMLElement | null)?.dataset.tmode as TransferRule['mode'] | undefined;
    if (tm) { await store.setTransfer({ ...c.transfer, mode: tm }, 'ed'); return render(); }
    const edit = (tg.closest('[data-edit]') as HTMLElement | null)?.dataset.edit;
    if (edit) {
      const [kind, id] = edit.split(':');
      const r = kind === 'mode' ? c.fareDefaults[id] : store.lineRule(+id).rule;
      st.editing = edit; st.draft = structuredClone(r ?? { base: 0, includedKm: 0, tiers: [] });
      render(); (el.querySelector('[data-rule] input') as HTMLInputElement | null)?.select(); return;
    }
    const box = tg.closest('[data-rule]') as HTMLElement | null;
    if (box) {
      const key = box.dataset.rule!, [kind, id] = key.split(':');
      const save = (r: FareRule | null) => (kind === 'mode' ? store.setModeDefault(id, r, 'ed') : store.setLineRule(+id, r, 'ed'));
      if (tg.closest('[data-add-tier]')) { st.draft = ruleFromEditor(box); const last = st.draft.tiers.at(-1); st.draft.tiers.push({ amount: last?.amount ?? 0, everyKm: last?.everyKm ?? 5, uptoKm: null }); if (last && last.uptoKm === null) last.uptoKm = Math.max(st.draft.includedKm, 0) + 40; return render(); }
      const del = (tg.closest('[data-del-tier]') as HTMLElement | null)?.dataset.delTier;
      if (del !== undefined) { st.draft = ruleFromEditor(box); st.draft.tiers.splice(+del, 1); return render(); }
      if (tg.closest('[data-rule-cancel]')) { st.editing = ''; return render(); }
      if (tg.closest('[data-rule-remove]')) { st.editing = ''; await save(null); return render(); }
      if (tg.closest('[data-rule-save]')) {
        const r = ruleFromEditor(box);
        r.tiers = r.tiers.filter((x) => x.everyKm > 0);
        st.editing = ''; await save(r); return render();
      }
    }
    if (tg.closest('[data-drop-orphans]')) { if (confirm(t('Remove saved prices that match nothing in this export? This cannot be undone.'))) { await store.removeUnmatched(); render(); } return; }
    if (tg.closest('[data-export]')) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([store.exportJson()], { type: 'application/json' }));
      a.download = `${c.city.replace(/[\\/:*?"<>|]+/g, '_')}.atlas-pricing.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000); return;
    }
    if (tg.closest('[data-reset]')) { if (confirm(t('Clear all toll fees and fares for {city}? This cannot be undone. Export a backup first if you may need them.', { city: c.city }))) { await store.reset(); render(); } }
  });
  // live re-render only for fare editor previews; values save on change (blur / enter)
  el.addEventListener('input', (e) => {
    const tg = e.target as HTMLInputElement;
    if (tg.matches('[data-q]')) { st.q = tg.value; const pos = tg.selectionStart; render(); const q = el.querySelector('[data-q]') as HTMLInputElement; q.focus(); q.setSelectionRange(pos, pos); return; }
    const box = tg.closest('[data-rule]') as HTMLElement | null;
    if (box) { const r = ruleFromEditor(box); box.querySelector('.re-samples')!.innerHTML = [3, 10, 20, 40].map((km) => `<span><small>${km} km</small>${esc(fmtMoney(fareFor({ ...r, tiers: r.tiers.filter((x) => x.everyKm > 0) }, km), cur()))}</span>`).join(''); }
  });
  el.addEventListener('change', async (e) => {
    const tg = e.target as HTMLInputElement, c = store.ctx;
    if (!c) return;
    if (tg.matches('[data-booth]')) {
      const id = +tg.dataset.booth!;
      await store.setTollFee(id, money(tg.value), 'ed');
      const f = store.tollFee(id);
      tg.value = f.source === 'own' ? String(f.fee) : '';
      // update the count in place: a full render would steal focus from the next field
      const span = el.querySelector('.ctx-sub > span');
      if (span) span.textContent = boothCount();
      return;
    }
    if (tg.matches('[data-toll-default]')) { await store.setTollDefault(money(tg.value), 'ed'); return render(); }
    if (tg.matches('[data-cur]')) {
      const k = tg.dataset.cur as keyof Currency, next = { ...cur() } as any;
      next[k] = k === 'space' ? tg.checked : k === 'decimals' ? +tg.value : tg.value;
      if (k === 'symbol' && !String(next.symbol).trim()) return render();
      await store.setCurrency(next, 'ed'); return render();
    }
    if (tg.matches('[data-tw], [data-tm]')) {
      const v = tg.value.trim() === '' ? null : Math.max(0, Math.round(+tg.value));
      await store.setTransfer({ ...c.transfer, [tg.matches('[data-tw]') ? 'windowMin' : 'maxTransfers']: v }, 'ed'); return;
    }
    if (tg.matches('[data-import]') && tg.files?.[0]) {
      const f = tg.files[0]; tg.value = '';
      try {
        const text = await f.text(), probe = JSON.parse(text);
        if (probe?.city && probe.city !== c.city && !confirm(t('This file is for “{file}”. Apply it to {city}? Booths and lines are matched by name and position.', { file: probe.city, city: c.city }))) return;
        if ((c.tolls.length || c.fares.length) && !confirm(t('Replace the current pricing for {city} with the file?', { city: c.city }))) return;
        store.importJson(text);
        const u = store.unmatched;
        const n = u.tolls.length + u.fares.length;
        hooks.toast(t('Imported pricing') + (n ? ' · ' + tn(n, '{n} entry matches nothing in this map', '{n} entries match nothing in this map') : ''));
        render();
      } catch (err) { hooks.toast(t('Could not import: {err}', { err: t((err as Error).message) })); }
    }
  });
  el.addEventListener('keydown', (e) => {
    const tg = e.target as HTMLElement;
    if (e.key === 'Enter' && tg.closest('[data-rule]')) { e.preventDefault(); (el.querySelector('[data-rule-save]') as HTMLButtonElement).click(); }
    if (e.key === 'Escape') { if (st.editing) { st.editing = ''; render(); } else close(); }
  });
  store.on((origin) => { if (!el.hidden && origin !== 'ed') render(); });

  function open(tab?: Tab, focus?: { line?: number; booth?: number }) {
    if (!store.ctx) return;
    if (tab) st.tab = tab;
    st.editing = ''; st.q = '';
    if (focus?.line !== undefined) { const r = store.lineRule(focus.line).rule; st.editing = 'line:' + focus.line; st.draft = structuredClone(r ?? { base: 0, includedKm: 0, tiers: [] }); }
    el.hidden = false; hooks.onOpen(); render(); sheet.show('full');
    if (focus?.line !== undefined) requestAnimationFrame(() => { el.querySelector(`#ctx-line-${focus.line}`)?.scrollIntoView({ block: 'center' }); (el.querySelector('[data-rule] input') as HTMLInputElement | null)?.select(); });
    if (focus?.booth !== undefined) requestAnimationFrame(() => { const i = el.querySelector(`[data-booth="${focus.booth}"]`) as HTMLInputElement | null; i?.scrollIntoView({ block: 'center' }); i?.focus(); });
  }
  function close() { el.hidden = true; st.editing = ''; renderedTab = null; sheet.hide(); }
  return { open, close, isOpen: () => !el.hidden, refresh: () => { if (!el.hidden) render(); } };
}
