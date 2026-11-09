import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import type { BuiltCity, SearchEntry } from './build';
import type { Route, Leg, Step, Mode } from './router';
import { fromLngLat, type XY } from './geo';
import { iconDataUrl } from './icons';
import { bottomSheet, isPhone } from './sheet';
import { t, tn, applyStatic } from './i18n';
import type { ContextStore, TollCost, FareCost } from './context-ui';

type LL = [number, number];
interface Place { label: string; ll: LL }

export const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: 'drive', label: 'Driving', icon: '<path d="M18.9 6a1.5 1.5 0 0 0-1.4-1h-11a1.5 1.5 0 0 0-1.4 1L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.1-6zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z"/>' },
  { id: 'transit', label: 'Transit', icon: '<path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-3.6-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3.5-7H6V6h5v4zm5.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm1.5-7h-5V6h5v4z"/>' },
  { id: 'walk', label: 'Walking', icon: '<path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6a2 2 0 0 0-2.4-.8L6 8.3V13h2V9.6l1.8-.7"/>' },
  { id: 'bike', label: 'Cycling', icon: '<path d="M15.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm5.8-10 2.4-2.4.8.8a7 7 0 0 0 5 2.1V9a5 5 0 0 1-3.6-1.5l-1.9-1.9a2 2 0 0 0-2.8 0L7.4 8.9a2 2 0 0 0 0 2.8L11 14v5h2v-6.2l-2.2-2.3zM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>' },
];
// i18n-keys: mode labels above
void ['Driving', 'Transit', 'Walking', 'Cycling'];
// end i18n-keys
const svg = (inner: string, cls = '') => `<svg viewBox="0 0 24 24" class="${cls}">${inner}</svg>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fmtTime = (s: number) => { const m = Math.max(1, Math.round(s / 60)); return m < 60 ? t('{n} min', { n: m }) : m % 60 ? t('{h} hr {n} min', { h: Math.floor(m / 60), n: m % 60 }) : t('{h} hr', { h: m / 60 }); };
export const fmtDist = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);

const ARROW = '<path d="M12 21V8"/><path d="m6.5 12.5 5.5-5.5 5.5 5.5"/>';
function maneuverIcon(m: string): string {
  if (m === 'depart') return svg('<circle cx="12" cy="12" r="5" fill="none" stroke-width="2.4"/>', 'man');
  if (m === 'arrive') return svg('<path d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" stroke="none" fill="#ea4335"/>', 'man');
  if (m === 'uturn') return svg('<path d="M9 21V9a4 4 0 0 1 8 0v4"/><path d="m13.5 10.5 3.5 3.5 3.5-3.5"/>', 'man');
  if (m === 'warn') return svg('<path d="M12 3 2 21h20L12 3z" fill="#e37400" stroke="none"/><path d="M12 10v5M12 17.5v.5" stroke="#fff" stroke-width="2.2"/>', 'man');
  if (m === 'toll') return svg('<rect x="4" y="8" width="6" height="12" rx="1" fill="#d9822b" stroke="none"/><path d="M10 12h10" stroke="#d9822b"/>', 'man');
  if (m === 'merge') return svg('<path d="M12 21V11L7 4"/><path d="M12 11l5-7"/>', 'man');
  const deg = /slight-left|ramp-left|exit-left/.test(m) ? -45 : /slight-right|ramp-right|exit-right/.test(m) ? 45 : m === 'turn-left' ? -90 : m === 'turn-right' ? 90 : 0;
  return svg(`<g transform="rotate(${deg} 12 12)">${ARROW}</g>`, 'man');
}

export interface DirectionsDeps {
  map: MLMap; worker: Worker; city: () => BuiltCity | null;
  onOpen: () => void; onClose: () => void;
  /** user-supplied prices (tolls, fares, currency) */
  pricing: ContextStore;
  editPricing: (tab: 'tolls' | 'fares', focus?: { line?: number; booth?: number }) => void;
  /** draw a transit route on the schematic transit map */
  showOnSchematic: (r: Route) => void;
  /** a matched save's traffic rules are loaded in the worker's router (see sim/rules.ts) */
  simRules: () => boolean;
}

export function createDirections(d: DirectionsDeps) {
  const { map, worker } = d;
  const el = document.createElement('aside');
  el.id = 'dir';
  el.hidden = true;
  el.innerHTML = `
    <div class="dir-top">
    <div class="dir-head">
      <div class="dir-modes" role="tablist">${MODES.map((m) => `<button class="dir-mode" role="tab" data-mode="${m.id}" title="${m.label}" data-i18n-title="${m.label}">${svg(m.icon)}<span class="t"></span></button>`).join('')}</div>
      <button class="icon-btn dir-close" aria-label="Close directions" data-i18n-aria="Close directions">${svg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>')}</button>
    </div>
    <div class="dir-inputs">
      <div class="dir-dots"><i class="o"></i><i class="dots"></i><i class="d"></i></div>
      <div class="dir-fields">
        <input id="dirFrom" placeholder="Choose starting point, or click the map" data-i18n-placeholder="Choose starting point, or click the map" autocomplete="off" spellcheck="false" />
        <input id="dirTo" placeholder="Choose destination…" data-i18n-placeholder="Choose destination…" autocomplete="off" spellcheck="false" />
      </div>
      <button class="icon-btn dir-swap" title="Reverse starting point and destination" aria-label="Swap" data-i18n-title="Reverse starting point and destination" data-i18n-aria="Swap">${svg('<path d="M16 17.01V10h-2v7.01h-3L15 21l4-3.99h-3zM9 3 5 6.99h3V14h2V6.99h3L9 3z"/>')}</button>
      <div class="dir-suggest" hidden></div>
    </div>
    <div class="dir-options"><label><input type="checkbox" id="dirAvoidTolls" /> <span data-i18n="Avoid tolls">Avoid tolls</span></label><label id="dirRulesRow" hidden title="One-way directions, TM:PE speed limits, car restrictions and U-turn bans from your save" data-i18n-title="One-way directions, TM:PE speed limits, car restrictions and U-turn bans from your save"><input type="checkbox" id="dirRules" checked /> <span data-i18n="Traffic rules from my save">Traffic rules from my save</span></label></div>
    </div>
    <div class="dir-sheet"><div class="dir-body"></div></div>`;
  document.body.appendChild(el);
  applyStatic(el);
  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const fromIn = $<HTMLInputElement>('#dirFrom'), toIn = $<HTMLInputElement>('#dirTo');
  const body = $<HTMLElement>('.dir-body'), sug = $<HTMLElement>('.dir-suggest');
  // phones: inputs stay in a card at the top, results go in a draggable sheet below the map
  const sheet = bottomSheet($<HTMLElement>('.dir-sheet'), {
    scroll: body, snaps: ['peek', 'half', 'full'], publish: true,
    peek: () => { const c = body.querySelector<HTMLElement>('.dir-card, .dd-head, .dir-hint, .dir-empty, .dir-loading'); return 26 + (c?.offsetHeight ?? 80); },
    top: () => $<HTMLElement>('.dir-top').getBoundingClientRect().bottom + 8,
  });

  const st = {
    from: null as Place | null, to: null as Place | null, mode: 'drive' as Mode, avoidTolls: false, rules: true,
    results: {} as Partial<Record<Mode, Route[]>>, sel: 0, req: 0, active: 'to' as 'from' | 'to', expanded: false,
  };

  // ---------------------------------------------------------- prices (user-supplied: the export has none)
  const P = d.pricing, money = (v: number) => esc(P.money(v));
  const tollSummary = (tc: TollCost) => tc.missing === tc.fees.length ? t('fee not set') : `<b>${money(tc.total)}</b>${tc.missing ? ' ' + t('+ {n} not set', { n: tc.missing }) : ''}`;
  /** card-level fare: shown once at least one ride has a price */
  const fareShort = (fc: FareCost | null) => !fc || fc.missing.length === fc.rides.length ? '' : `${money(fc.total)}${fc.missing.length ? '+' : ''}`;
  function fareBox(fc: FareCost | null): string {
    if (!fc) return '';
    const none = fc.missing.length === fc.rides.length;
    if (none) return `<div class="fare-box empty"><span class="muted small">${t('Fares aren’t in the export.')}</span><button class="link-btn" data-pricing="fares">${t('Set transit fares')}</button></div>`;
    const tr = P.ctx!.transfer;
    const rows = fc.items.map((it, i) => {
      const r = fc.rides[i];
      const what = it.charged === null ? `<span class="muted">${t('not set')}</span>` : it.transfer ? (it.charged ? t('Transfer +{fee}', { fee: money(it.charged) }) : t('Free transfer')) : money(it.charged);
      return `<div class="fb-row"><span class="line-pill" style="background:${r.color};color:${textOn(r.color)}"><img src="${iconDataUrl(r.mode, r.color)}" alt="">${esc(r.name)}</span><span class="muted small">${r.km < 10 ? r.km.toFixed(1) : Math.round(r.km)} km</span><span class="fb-amt">${what}</span></div>`;
    }).join('');
    const rule = tr.mode === 'separate' ? t('Each ride pays its own fare') : tr.mode === 'max' ? t('One ticket per journey') : t('Distance-integrated fare');
    return `<div class="fare-box"><div class="fb-head"><b>${t('Fare')}</b><b>${money(fc.total)}${fc.missing.length ? '+' : ''}</b></div>${rows}
      <div class="fb-foot"><span class="muted small">${rule}${tr.mode !== 'separate' && tr.windowMin !== null ? ' · ' + t('{n} min window', { n: tr.windowMin }) : ''}${fc.missing.length ? ' · ' + t('some lines have no fare set') : ''}</span><button class="link-btn" data-pricing="fares">${t('Edit fares')}</button></div></div>`;
  }
  P.on(() => { if (isOpen()) render(); });

  // markers
  const mk = (cls: string) => { const e = document.createElement('div'); e.className = cls; return e; };
  const startM = new maplibregl.Marker({ element: mk('dir-pin-a'), draggable: true });
  const endM = new maplibregl.Marker({ element: mk('dir-pin-b'), draggable: true, anchor: 'bottom' });
  startM.on('dragend', () => { const p = startM.getLngLat(); setPoint('from', { label: t('Dropped pin'), ll: [p.lng, p.lat] }); });
  endM.on('dragend', () => { const p = endM.getLngLat(); setPoint('to', { label: t('Dropped pin'), ll: [p.lng, p.lat] }); });

  function open(opts: { to?: Place; from?: Place; mode?: Mode } = {}) {
    if (opts.mode) st.mode = opts.mode;
    if (opts.to) st.to = opts.to;
    if (opts.from) st.from = opts.from;
    el.hidden = false; d.onOpen(); sheet.show('half');
    fromIn.value = st.from?.label ?? ''; toIn.value = st.to?.label ?? '';
    st.active = !st.from ? 'from' : 'to';
    (st.active === 'from' ? fromIn : toIn).focus();
    syncMarkers(); compute();
  }
  function close() {
    el.hidden = true; sheet.hide(); startM.remove(); endM.remove();
    (map.getSource('route') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
    st.results = {}; d.onClose();
  }
  const isOpen = () => !el.hidden;

  function setPoint(which: 'from' | 'to', p: Place) {
    st[which] = p;
    (which === 'from' ? fromIn : toIn).value = p.label;
    if (which === 'from' && !st.to) { st.active = 'to'; toIn.focus(); }
    syncMarkers(); compute();
  }
  function syncMarkers() {
    if (st.from) startM.setLngLat(st.from.ll).addTo(map); else startM.remove();
    if (st.to) endM.setLngLat(st.to.ll).addTo(map); else endM.remove();
  }

  // ---------------------------------------------------------- routing
  function compute() {
    st.results = {}; st.sel = 0; st.expanded = false;
    drawRoutes();
    if (!st.from || !st.to) { render(); return; }
    const id = ++st.req;
    const from = fromLngLat(...st.from.ll), to = fromLngLat(...st.to.ll);
    for (const m of MODES) worker.postMessage({ type: 'route', id, mode: m.id, from, to, avoidTolls: st.avoidTolls, rules: st.rules });
    render();
  }
  function onResult(msg: { id: number; mode: Mode; routes: Route[] }) {
    if (msg.id !== st.req) return;
    st.results[msg.mode] = msg.routes;
    if (msg.mode === st.mode) { drawRoutes(true); }
    render();
  }

  function drawRoutes(fit = false) {
    const src = map.getSource('route') as GeoJSONSource | undefined;
    if (!src) return;
    const routes = st.results[st.mode] ?? [];
    const feats: any[] = [];
    routes.forEach((r, i) => {
      if (i === st.sel) return;
      for (const l of r.legs) feats.push({ type: 'Feature', properties: { role: 'alt', idx: i }, geometry: { type: 'LineString', coordinates: l.coords } });
    });
    const r = routes[st.sel];
    if (r) {
      for (const l of r.legs) {
        const kind = l.kind === 'ride' ? 'ride' : l.kind === 'walk' ? 'walk' : 'main';
        feats.push({ type: 'Feature', properties: { role: kind, color: l.line?.color ?? '#1a73e8', idx: st.sel }, geometry: { type: 'LineString', coordinates: l.coords } });
        if (l.kind === 'ride' && l.coords.length) {
          for (const c of [l.coords[0], l.coords[l.coords.length - 1]]) feats.push({ type: 'Feature', properties: { role: 'stop', color: l.line!.color }, geometry: { type: 'Point', coordinates: c } });
        }
      }
    }
    // connect pins to the network with a faint dotted line, as Google does
    if (r && st.from && st.to) {
      const first = r.legs[0]?.coords[0], last = r.legs[r.legs.length - 1]?.coords.at(-1);
      if (first) feats.push({ type: 'Feature', properties: { role: 'link' }, geometry: { type: 'LineString', coordinates: [st.from.ll, first] } });
      if (last) feats.push({ type: 'Feature', properties: { role: 'link' }, geometry: { type: 'LineString', coordinates: [last, st.to.ll] } });
    }
    src.setData({ type: 'FeatureCollection', features: feats });
    if (fit && r) {
      const all = r.legs.flatMap((l) => l.coords).concat(st.from ? [st.from.ll] : [], st.to ? [st.to.ll] : []);
      const b = all.reduce((bb, c) => bb.extend(c as LL), new maplibregl.LngLatBounds(all[0] as LL, all[0] as LL));
      const phone = isPhone(), narrow = innerWidth < 700;
      const top = phone ? $<HTMLElement>('.dir-top').getBoundingClientRect().bottom + 24 : 70;
      const bottom = phone ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-h')) || innerHeight * 0.4) + 24 : narrow ? innerHeight * 0.5 : 60;
      map.fitBounds(b, { padding: { top, bottom, left: narrow ? 30 : 460, right: narrow ? 30 : 70 }, maxZoom: 17, duration: 700 });
    }
  }

  // ---------------------------------------------------------- rendering
  function render() { renderBody(); sheet.refresh(); }
  function renderBody() {
    ($<HTMLElement>('.dir-options')).hidden = st.mode !== 'drive';
    el.querySelectorAll<HTMLElement>('.dir-mode').forEach((b) => {
      const m = b.dataset.mode as Mode, rs = st.results[m];
      b.classList.toggle('on', m === st.mode);
      b.querySelector('.t')!.textContent = !st.from || !st.to ? '' : rs === undefined ? '…' : rs.length ? fmtTime(rs[0].time) : '—';
    });
    if (!st.from || !st.to) { body.innerHTML = `<div class="dir-hint">${svg('<path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/>')}<p>${t('Search for places above, click the map, or right-click anywhere to set a start or destination.')}</p></div>`; return; }
    const rs = st.results[st.mode];
    if (rs === undefined) { body.innerHTML = '<div class="dir-loading"><span></span></div>'; return; }
    if (!rs.length) {
      const why = st.mode === 'transit' ? t('No transit route — it may be quicker to walk, or no line serves these places.') : st.mode === 'walk' || st.mode === 'bike' ? t('No route for this mode. The places may only be connected by highways or water.') : t('No legal driving route between these places. One-way roads confirmed by traffic are never driven the wrong way.');
      body.innerHTML = `<div class="dir-empty">${esc(why)}</div>`; return;
    }
    const sel = rs[st.sel];
    body.innerHTML = st.expanded && sel ? details(sel) : rs.map((r, i) => routeCard(r, i, i === st.sel)).join('');
  }

  function routeCard(r: Route, i: number, on: boolean): string {
    const icon = MODES.find((m) => m.id === r.mode)!.icon;
    const chips = r.mode === 'transit' ? `<div class="dir-chips">${r.legs.map((l) => l.kind === 'ride'
      ? `<span class="line-pill" style="background:${l.line!.color};color:${textOn(l.line!.color)}"><img src="${iconDataUrl(l.line!.mode, l.line!.color)}" alt="">${esc(l.line!.name)}</span>`
      : `<span class="walk-chip">${svg(MODES[2].icon)}${l.dist > 60 ? `<small>${Math.round(l.time / 60) || 1}</small>` : ''}</span>`).join('<i class="chev">›</i>')}</div>` : '';
    const transfers = r.legs.filter((l) => l.kind === 'ride').length - 1;
    const sub = r.mode === 'transit'
      ? `${transfers > 0 ? tn(transfers, '{n} transfer', '{n} transfers') + ' · ' : ''}${t('{dist} walk', { dist: fmtDist(r.legs.filter((l) => l.kind === 'walk').reduce((a, l) => a + l.dist, 0)) })} · ${t('incl. ~{time} est. wait', { time: fmtTime(r.legs.reduce((a, l) => a + (l.wait ?? 0), 0)) })}`
      : (r.via ? esc(t('via {road}', { road: r.via })) : i === 0 ? t('Fastest route') : t('Alternative route'))
        + (r.tolls?.length ? `<div class="toll-note${r.tollsUnavoidable ? ' warn' : ''}">${r.tollsUnavoidable ? t('Tolls can’t be avoided on this trip') : t('This route has tolls')} · ${tollSummary(P.tollCost(r)!)}</div>` : '')
        + onewayNote(r);
    return `<div class="dir-card${on ? ' on' : ''}" data-idx="${i}">
      <div class="dc-icon">${svg(icon)}</div>
      <div class="dc-main">${chips}<div class="dc-sub">${sub}</div>${on && !st.expanded ? `<button class="dc-details" data-details>${t('Details')}</button>` : ''}</div>
      <div class="dc-time"><b class="${i === 0 ? 'best' : ''}">${fmtTime(r.time)}</b><span>${fmtDist(r.dist)}</span>${r.mode === 'transit' && fareShort(P.fareCost(r)) ? `<span class="dc-fare">${fareShort(P.fareCost(r))}</span>` : ''}</div>
    </div>`;
  }

  function details(r: Route): string {
    const head = `<div class="dd-head"><button class="icon-btn" data-back aria-label="${t('Back')}">${svg('<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>')}</button><div><b>${fmtTime(r.time)}</b> <span class="muted">(${fmtDist(r.dist)})</span>${r.via ? `<div class="muted small">${esc(t('via {road}', { road: r.via }))}</div>` : ''}${r.tolls?.length ? tollDetails(r) : ''}${onewayNote(r, true)}</div></div>`;
    if (r.mode !== 'transit') return head + `<ol class="steps">${r.legs[0].steps.map(stepRow).join('')}</ol>`;
    const rows: string[] = [`<li class="tr-place"><i class="dot o"></i><b>${esc(st.from!.label)}</b></li>`];
    r.legs.forEach((l, i) => {
      const next = r.legs[i + 1];
      if (l.kind === 'walk') {
        const target = next?.kind === 'ride' ? next.from : st.to!.label;
        rows.push(`<li class="tr-walk"><span class="rail walk"></span>${svg(MODES[2].icon, 'wi')}<div><div>${esc(t('Walk to {place}', { place: target ?? t('destination') }))}</div><div class="muted small">${fmtTime(l.time)} · ${fmtDist(l.dist)}</div>
          ${l.steps.length > 2 ? `<details><summary>${t('Walking directions')}</summary><ol class="steps mini">${l.steps.map(stepRow).join('')}</ol></details>` : ''}</div></li>`);
      } else {
        const c = l.line!.color;
        rows.push(`<li class="tr-stop"><i class="dot" style="border-color:${c}"></i><b>${esc(l.from!)}</b>${l.wait ? `<div class="muted small tr-wait" title="${t('No timetable in the export: this is a typical average wait for this kind of line')}">${t('Wait ~{time}', { time: fmtTime(l.wait) })} <span class="est">${t('estimate')}</span></div>` : ''}</li>`);
        const mid = (l.stopNames ?? []).slice(1, -1);
        rows.push(`<li class="tr-ride"><span class="rail" style="background:${c}"></span><div>
          <span class="line-pill" style="background:${c};color:${textOn(c)}"><img src="${iconDataUrl(l.line!.mode, c)}" alt="">${esc(l.line!.name)}</span>
          <div class="muted small" style="margin-top:6px">${t('{time} ride', { time: fmtTime(l.ride ?? l.time) })} · ${tn(l.stops ?? 0, '{n} stop', '{n} stops')}</div>
          ${mid.length ? `<details><summary>${tn(l.stops ?? 0, 'Ride {n} stop', 'Ride {n} stops')}</summary><ul class="mid">${mid.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}</div></li>`);
        rows.push(`<li class="tr-stop"><i class="dot" style="border-color:${c}"></i><b>${esc(l.to!)}</b></li>`);
      }
    });
    rows.push(`<li class="tr-place"><i class="dot d"></i><b>${esc(st.to!.label)}</b></li>`);
    return head + `<ol class="transit-steps">${rows.join('')}</ol>${fareBox(P.fareCost(r))}<div class="dd-schem"><button class="pill" data-schem>${svg('<path d="M4 6h5v2H6v3h3v2H6v3h3v2H4V6zm11 0h5v12h-5v-2h3v-3h-3v-2h3V8h-3V6zM10 11h4v2h-4z"/>')}${t('Show on transit map')}</button></div><p class="muted small dd-note">${t('Ride times come from the real road and track speed limits, with acceleration, stops and traffic. Waiting times are estimates: the export has no timetable.')}</p>`;
  }

  /** A last-resort route that drives against a likely (unconfirmed) one-way: never shown as an ordinary route. */
  function onewayNote(r: Route, long = false): string {
    const n = r.againstLikelyOneWay?.length;
    if (!n) return '';
    return `<div class="toll-note warn oneway-note">${t('No route obeys every one-way here: this one drives against a likely one-way direction')}${long ? `<div class="small">${t('That direction was inferred from the road layout and no vehicle has confirmed it, so it may be wrong. Check before driving.')}</div>` : ''}</div>`;
  }
  function tollDetails(r: Route): string {
    const tc = P.tollCost(r)!;
    return `<div class="toll-note${r.tollsUnavoidable ? ' warn' : ''}">${r.tollsUnavoidable ? t('Tolls can’t be avoided') : t('Has tolls')} · ${tn(tc.fees.length, '{n} booth', '{n} booths')} · ${tollSummary(tc)}</div>
      <button class="link-btn small" data-pricing="tolls">${tc.missing ? t('Set toll fees') : t('Edit toll fees')}</button>`;
  }
  function stepRow(s: Step): string {
    const fee = s.booth !== undefined ? P.tollFee(s.booth) : null;
    const right = fee ? `<div class="st-dist toll-fee">${fee.fee === null ? t('fee not set') : money(fee.fee)}</div>` : s.dist ? `<div class="st-dist">${fmtDist(s.dist)}</div>` : '';
    return `<li class="step" data-at="${s.at[0]},${s.at[1]}">${maneuverIcon(s.maneuver)}<div class="st-text">${esc(s.text)}</div>${right}</li>`;
  }

  // ---------------------------------------------------------- events
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.dir-close')) return close();
    const mode = (t.closest('.dir-mode') as HTMLElement | null)?.dataset.mode as Mode | undefined;
    if (mode) { st.mode = mode; st.sel = 0; st.expanded = false; drawRoutes(true); render(); return; }
    if (t.closest('.dir-swap')) { [st.from, st.to] = [st.to, st.from]; fromIn.value = st.from?.label ?? ''; toIn.value = st.to?.label ?? ''; syncMarkers(); compute(); return; }
    const pricing = (t.closest('[data-pricing]') as HTMLElement | null)?.dataset.pricing as 'tolls' | 'fares' | undefined;
    if (pricing) { const r = st.results[st.mode]?.[st.sel]; d.editPricing(pricing, pricing === 'tolls' && r?.tolls?.[0] ? { booth: r.tolls.find((x) => P.tollFee(x.booth).fee === null)?.booth ?? r.tolls[0].booth } : undefined); return; }
    if (t.closest('[data-schem]')) { const r = st.results[st.mode]?.[st.sel]; if (r) d.showOnSchematic(r); return; }
    if (t.closest('[data-back]')) { st.expanded = false; render(); sheet.to('half'); return; }
    if (t.closest('[data-details]')) { st.expanded = true; render(); body.scrollTop = 0; sheet.to('full'); return; }
    const step = (t.closest('[data-at]') as HTMLElement | null)?.dataset.at;
    if (step) { const [lng, lat] = step.split(',').map(Number); map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 17), speed: 1.5 }); return; }
    const card = t.closest('.dir-card') as HTMLElement | null;
    if (card) { const i = +card.dataset.idx!; if (i === st.sel) { st.expanded = true; sheet.to('full'); } else { st.sel = i; } drawRoutes(true); render(); }
  });

  const avoid = $<HTMLInputElement>('#dirAvoidTolls');
  avoid.addEventListener('change', () => { st.avoidTolls = avoid.checked; compute(); });
  const rulesBox = $<HTMLInputElement>('#dirRules');
  rulesBox.addEventListener('change', () => { st.rules = rulesBox.checked; compute(); });
  /** the save's rules were loaded or removed: show the switch while they exist, and re-route */
  function rulesChanged() {
    const on = d.simRules();
    $<HTMLElement>('#dirRulesRow').hidden = !on;
    if (!on) { st.rules = true; rulesBox.checked = true; }
    if (st.from && st.to) compute();
  }

  // autocomplete for the two fields
  let sugItems: { place: Place; sub: string; icon: string }[] = [];
  let sugActive = -1;
  function suggest(input: HTMLInputElement) {
    st.active = input === fromIn ? 'from' : 'to';
    const q = input.value.trim().toLowerCase();
    const city = d.city();
    if (!city || !q) { sug.hidden = true; return; }
    const seen = new Set<string>();
    const hits = city.search.filter((s) => s.kind !== 'line' && s.name.toLowerCase().includes(q) && !seen.has(s.kind + s.name) && seen.add(s.kind + s.name))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || rank(a) - rank(b)).slice(0, 8);
    sugItems = hits.map((s) => ({ place: { label: s.name, ll: s.center as LL }, sub: s.kind === 'station' ? t('Station') : s.kind === 'district' ? t('District') : s.kind === 'road' ? t('Road') : s.kind === 'park' ? t('Park') : t('Place'), icon: s.kind === 'station' ? iconDataUrl(s.sub) : s.kind === 'poi' ? iconDataUrl(s.sub) : '' }));
    sugActive = sugItems.length ? 0 : -1;
    sug.style.top = (input.offsetTop + input.offsetHeight + 4) + 'px';
    sug.innerHTML = sugItems.length ? sugItems.map((s, i) => `<div class="sg${i === sugActive ? ' on' : ''}" data-i="${i}">${s.icon ? `<img src="${s.icon}" alt="">` : `<span class="sg-pin">${svg('<path d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>')}</span>`}<div><div>${esc(s.place.label)}</div><small>${s.sub}</small></div></div>`).join('') : `<div class="sg-none">${t('No matching places')}</div>`;
    sug.hidden = false;
  }
  const rank = (s: SearchEntry) => ({ station: 0, district: 1, park: 2, poi: 3, road: 4 } as Record<string, number>)[s.kind] ?? 5;
  for (const input of [fromIn, toIn]) {
    input.addEventListener('input', () => suggest(input));
    input.addEventListener('focus', () => { st.active = input === fromIn ? 'from' : 'to'; input.select(); });
    input.addEventListener('blur', () => setTimeout(() => (sug.hidden = true), 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!sugItems.length) return; sugActive = (sugActive + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length; sug.querySelectorAll('.sg').forEach((x, i) => x.classList.toggle('on', i === sugActive)); }
      else if (e.key === 'Enter' && sugActive >= 0 && !sug.hidden) { setPoint(input === fromIn ? 'from' : 'to', sugItems[sugActive].place); sug.hidden = true; input.blur(); }
      else if (e.key === 'Escape') { sug.hidden = true; input.blur(); }
    });
  }
  sug.addEventListener('mousedown', (e) => { const i = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null; if (i) { e.preventDefault(); setPoint(st.active, sugItems[+i.dataset.i!].place); sug.hidden = true; } });

  return {
    open, close, isOpen, onResult, redraw: () => drawRoutes(), rulesChanged,
    /** language changed: relabel and re-ask the worker, whose step text is in the UI language */
    relang() { applyStatic(el); if (isOpen()) compute(); },
    /** a click on the map while directions are open fills the active empty field */
    mapClick(ll: LL, label: string) { const w = !st.from ? 'from' : !st.to ? 'to' : st.active; setPoint(w, { label, ll }); },
    setFrom: (p: Place) => { if (!isOpen()) open({ from: p }); else setPoint('from', p); },
    setTo: (p: Place) => { if (!isOpen()) open({ to: p }); else setPoint('to', p); },
  };
}

function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 165 ? '#202124' : '#ffffff';
}
export type { XY, Leg };
