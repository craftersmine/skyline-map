// City Discoveries panel: records found in the export (see discover.ts), grouped by theme. Picking one frames
// it on the map, draws it in gold with its number on a badge, and opens a spotlight with the full story;
// arrows (or ← →) step through the collection. On phones the panel is a bottom sheet that drops to the
// spotlight when a record is picked, so the map stays in view.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import { t, locale } from './i18n';
import { bottomSheet, isPhone } from './sheet';
import type { Discovery, DiscoveryResult, DiscoveryCat } from './discover';

const SRC = 'discover';
const LAYERS = ['dc-glow', 'dc-line', 'dc-fill', 'dc-outline', 'dc-halo', 'dc-point'];
const CATS: DiscoveryCat[] = ['transit', 'roads', 'land', 'buildings', 'quirks'];
const CAT_NAMES: Record<DiscoveryCat | 'all', string> = { all: 'All', transit: 'Transit', roads: 'Roads & bridges', land: 'Land & water', buildings: 'Buildings', quirks: 'Oddities' };
const UNITS: Record<string, string> = {
  m: '{v} m', km: '{v} km', '%': '{v}%', 'm²': '{v} m²', ha: '{v} ha', lines: '{v} lines', roads: '{v} roads', lanes: '{v} lanes', parts: '{v} parts', copies: '{v} copies',
  place: '{v} place', places: '{v} places', island: '{v} island', islands: '{v} islands', station: '{v} station', stations: '{v} stations', characters: '{v} characters',
  'm below ground': '{v} m below ground', 'm above sea': '{v} m above sea', 'm below sea': '{v} m below sea', 'm deep': '{v} m deep',
};
// i18n-keys
void ['All', 'Transit', 'Roads & bridges', 'Land & water', 'Buildings', 'Oddities', '{v} m', '{v} km', '{v}%', '{v} m²', '{v} ha', '{v} lines', '{v} roads', '{v} lanes', '{v} parts', '{v} copies', '{v} place', '{v} places', '{v} island', '{v} islands', '{v} station', '{v} stations', '{v} characters', '{v} m below ground', '{v} m above sea', '{v} m below sea', '{v} m deep'];
void ['Play tour', 'Pause tour', 'City discoveries', 'Close', '{n} records found in {city}', 'Previous', 'Next', '{i} of {n}', 'Surprise me', 'near {place}', 'km of road', 'km of rail', 'lines', 'buildings',
  'Every record is measured from your export: lengths, heights and counts. Nothing is guessed.', 'No records stand out in this city yet. Build some more and export again.', 'Finding discoveries'];
// end i18n-keys

// 24-unit pictograms, filled, even-odd so inner shapes cut out
const ICONS: Record<string, string> = {
  train: 'M7 3h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3l2 3h-2.5l-2-3h-5l-2 3H5l2-3a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 7v4h12V7zm2 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  metro: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM7 17h2.2v-6.2l2.8 4.4 2.8-4.4V17H17V7h-2.2L12 11.6 9.2 7H7z',
  tram: 'M8 1h8v1.6h-3.2V5H17a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3l2 3h-2.5l-2-3h-5l-2 3H5l2-3a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4.2V2.6H8zM6 8v4h12V8zm2 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  // side view, so it never reads as the front-on train
  bus: 'M2 7a2 2 0 0 1 2-2h13.5L22 10v6a2 2 0 0 1-2 2h-1.2a2.5 2.5 0 0 1-4.6 0H9.8a2.5 2.5 0 0 1-4.6 0H4a2 2 0 0 1-2-2zm2 0v4h4V7zm6 0v4h4V7zm6 0v4h3.6L17 7z',
  ferry: 'M3 13h18l-2.5 6h-13zM7 8h10v4H7zm4-4h2v3h-2zM2 21c2.5 0 2.5-1 5-1s2.5 1 5 1 2.5-1 5-1 2.5 1 5 1v1.5c-2.5 0-2.5-1-5-1s-2.5 1-5 1-2.5-1-5-1-2.5 1-5 1z',
  cablecar: 'M2 5.5 22 2v2l-9 1.6V8h3a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3h3V5.9L2 7.5zM7 11v3h10v-3z',
  corridor: 'M3 5h18v2.2H3zm0 5.9h18v2.2H3zm0 5.9h18V19H3z',
  bridge: 'M2 15h20v2h-2v4h-2v-4H6v4H4v-4H2zm0-3.2c4 0 6-5 10-5s6 5 10 5v2c-4 0-6-5-10-5S6 13.8 2 13.8z',
  viaduct: 'M2 6h20v3h-1.5v12h-3v-6a2.5 2.5 0 0 0-5 0v6h-1v-6a2.5 2.5 0 0 0-5 0v6h-3V9H2z',
  tunnel: 'M12 3a9 9 0 0 1 9 9v9H3v-9a9 9 0 0 1 9-9zm0 4a5 5 0 0 0-5 5v9h10v-9a5 5 0 0 0-5-5z',
  road: 'M9 2h2l-1 20H5zm4 0h2l4 20h-5zm-1.8 4h1.6v3h-1.6zm0 5h1.6v3h-1.6zm0 5h1.6v3h-1.6z',
  straight: 'M2 11h20v2H2zM2 7h2v10H2zm18 0h2v10h-2zM7 9h1.5v6H7zm4.25 0h1.5v6h-1.5zm4.25 0H17v6h-1.5z',
  steep: 'M2 20 20 5h2v15zm6.2-2H20V8.2z',
  summit: 'M2 20 9 7l4 6 3-4 6 11zm7-9.2L5.4 18h7.2l-1.3-2.4z',
  junction: 'M11 2h2v20h-2zM2 11h20v2H2zM4.9 6.3l1.4-1.4 12.8 12.8-1.4 1.4zM17.7 4.9l1.4 1.4L6.3 19.1l-1.4-1.4z',
  wide: 'M3 3h2v18H3zm16 0h2v18h-2zM8 3h1.6v4H8zm0 7h1.6v4H8zm0 7h1.6v4H8zm6.4-14H16v4h-1.6zm0 7H16v4h-1.6zm0 7H16v4h-1.6z',
  plane: 'M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z',
  water: 'M12 2.5S5 10 5 14.5a7 7 0 0 0 14 0C19 10 12 2.5 12 2.5zm-3.5 12h2a1.5 1.5 0 0 0 1.5 1.5v2a3.5 3.5 0 0 1-3.5-3.5z',
  wave: 'M2 8c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2v2c-2.5 0-2.5-2-5-2s-2.5 2-5 2-2.5-2-5-2-2.5 2-5 2zm0 6c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2v2c-2.5 0-2.5-2-5-2s-2.5 2-5 2-2.5-2-5-2-2.5 2-5 2z',
  building: 'M4 21V6l8-4v5l8 3v11zM7 8v2h2V8zm0 4v2h2v-2zm0 4v2h2v-2zm6-3v2h2v-2zm0 4v2h2v-2z',
  parts: 'M3 3h8v8H3zm10 0h8v5h-8zm0 7h8v11h-8zM3 13h8v8H3z',
  copies: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  lonely: 'M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z',
  crossing: 'M4.2 2.8 21.2 19.8l-1.4 1.4L2.8 4.2zm15.6 0 1.4 1.4L4.2 21.2l-1.4-1.4z',
  island: 'M2 18c3 0 3-2 6-2s3 2 6 2 3-2 6-2v2c-3 0-3 2-6 2s-3-2-6-2-3 2-6 2zm7-3c0-3 1.5-6 3-8 1.5 2 3 5 3 8z',
  ghost: 'M12 2a8 8 0 0 0-8 8v12l2.7-2 2.6 2 2.7-2 2.7 2 2.6-2 2.7 2V10a8 8 0 0 0-8-8zM9 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  sign: 'M11 2h2v3h7l2 3-2 3h-7v11h-2V11H4V5h7z',
};
ICONS.monorail = ICONS.train;
export const SPARKLE = 'M12 2l2.1 6.6L21 11l-6.9 2.4L12 20l-2.1-6.6L3 11l6.9-2.4zm7 13 .9 2.1 2.1.9-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z';
const svg = (k: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${ICONS[k] ?? SPARKLE}"/></svg>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createDiscoveries(map: MLMap, deps: { onOpen: () => void }) {
  const st = { data: null as DiscoveryResult | null, active: false, cat: 'all' as DiscoveryCat | 'all', sel: null as string | null, tour: 0 };
  // the city's pan limit would push records at the map edge behind the panel; lifted while the panel is open
  let savedBounds: maplibregl.LngLatBounds | null = null;
  const el = document.createElement('div');
  el.id = 'discover'; el.className = 'card'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', t('City discoveries'));
  document.body.appendChild(el);
  const sheet = bottomSheet(el, {
    scroll: () => el.querySelector<HTMLElement>('.dc-scroll') ?? el, snaps: ['peek', 'half', 'full'], publish: true,
    peek: () => { const s = el.querySelector<HTMLElement>('.dc-spot') ?? el.querySelector<HTMLElement>('.dc-head'); return s ? s.offsetTop + s.offsetHeight + 12 : 120; },
    top: () => 56, onDismiss: () => close(),
  });
  let badge: maplibregl.Marker | null = null;

  const fmtNum = (v: string) => { const n = Number(v.replace(/,/g, '')); return Number.isFinite(n) ? n.toLocaleString(locale(), { maximumFractionDigits: v.includes('.') ? v.split('.')[1].length : 0, minimumFractionDigits: v.includes('.') ? v.split('.')[1].length : 0 }) : v; };
  /** value + unit as HTML, the number big; the unit template decides the word order per language */
  const valueHTML = (d: Discovery) => {
    const tpl = t(UNITS[d.unit] ?? '{v} ' + d.unit), [a, b] = tpl.split('{v}');
    return `${a ? `<small>${esc(a.trim())}</small>` : ''}<b>${esc(fmtNum(d.value))}</b>${b ? `<small>${esc(b.trim())}</small>` : ''}`;
  };
  const subjectOf = (d: Discovery) => (d.subjectKey ? t(d.subject) : d.subject);
  const noteOf = (d: Discovery) => t(d.note, d.params);
  const items = () => (st.data?.items ?? []).filter((d) => st.cat === 'all' || d.cat === st.cat);
  const ordered = () => CATS.flatMap((c) => (st.data?.items ?? []).filter((d) => d.cat === c));

  function card(d: Discovery) {
    const on = d.id === st.sel;
    return `<li><button class="dc-card${on ? ' on' : ''}" data-id="${d.id}" data-cat="${d.cat}" aria-pressed="${on}">
      <span class="dc-ico">${svg(d.icon)}</span>
      <span class="dc-body"><span class="dc-t">${esc(t(d.title))}</span><span class="dc-s">${esc(subjectOf(d))}</span></span>
      <span class="dc-v">${valueHTML(d)}</span>
    </button></li>`;
  }

  function spotlight(d: Discovery) {
    const list = ordered(), i = list.findIndex((x) => x.id === d.id);
    return `<section class="dc-spot" data-cat="${d.cat}" aria-live="polite">
      <div class="dc-spot-top"><span class="dc-ico">${svg(d.icon)}</span><span class="dc-spot-t">${esc(t(d.title))}</span>
        <span class="dc-nav"><button class="icon-btn dc-play" data-a="tour" aria-pressed="${!!st.tour}" aria-label="${st.tour ? t('Pause tour') : t('Play tour')}" title="${st.tour ? t('Pause tour') : t('Play tour')}">${st.tour ? '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'}</button><button class="icon-btn" data-step="-1" aria-label="${t('Previous')}"><svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg></button><span>${esc(t('{i} of {n}', { i: i + 1, n: list.length }))}</span><button class="icon-btn" data-step="1" aria-label="${t('Next')}"><svg viewBox="0 0 24 24"><path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z"/></svg></button></span></div>
      <div class="dc-spot-v">${valueHTML(d)}</div>
      <div class="dc-spot-s">${d.color ? `<i style="background:${esc(d.color)}"></i>` : ''}${esc(subjectOf(d))}${d.place ? ` <em>${esc(t('near {place}', { place: d.place }))}</em>` : ''}</div>
      <p class="dc-spot-n">${esc(noteOf(d))}</p>
    </section>`;
  }

  function render() {
    const r = st.data;
    if (!r) { el.innerHTML = ''; return; }
    const sel = r.items.find((d) => d.id === st.sel) ?? null;
    const counts = Object.fromEntries(CATS.map((c) => [c, r.items.filter((d) => d.cat === c).length]));
    const s = r.summary, n = (v: number) => v.toLocaleString(locale());
    const tabs = (['all', ...CATS] as const).filter((c) => c === 'all' || counts[c]);
    const list = st.cat === 'all'
      ? CATS.filter((c) => counts[c]).map((c) => `<li class="dc-group"><h4>${esc(t(CAT_NAMES[c]))}</h4><ol>${r.items.filter((d) => d.cat === c).map(card).join('')}</ol></li>`).join('')
      : items().map(card).join('');
    const scroll = el.querySelector<HTMLElement>('.dc-scroll')?.scrollTop ?? 0;
    el.innerHTML = `
      <div class="dc-head"><div><b>${t('City discoveries')}</b><span>${esc(t('{n} records found in {city}', { n: r.items.length, city: r.city }))}</span></div>
        <button class="icon-btn" data-a="random" title="${t('Surprise me')}" aria-label="${t('Surprise me')}"><svg viewBox="0 0 24 24"><path d="M10.6 9.2 5.4 4 4 5.4l5.2 5.2zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2z"/></svg></button>
        <button class="icon-btn" data-a="close" aria-label="${t('Close')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>
      ${sel ? spotlight(sel) : `<div class="dc-sum"><span><b>${n(s.roadKm)}</b> ${t('km of road')}</span>${s.railKm ? `<span><b>${n(s.railKm)}</b> ${t('km of rail')}</span>` : ''}${s.lines ? `<span><b>${n(s.lines)}</b> ${t('lines')}</span>` : ''}<span><b>${n(s.buildings)}</b> ${t('buildings')}</span></div><div class="dc-cta"><button class="pill primary" data-a="tour"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>${t('Play tour')}</button></div>`}
      <div class="dc-tabs" role="tablist">${tabs.map((c) => `<button role="tab" aria-selected="${st.cat === c}" data-cat="${c}">${esc(t(CAT_NAMES[c]))}<span>${c === 'all' ? r.items.length : counts[c]}</span></button>`).join('')}</div>
      <div class="dc-scroll">${r.items.length ? `<ol class="dc-list">${list}</ol>` : `<p class="dc-empty">${t('No records stand out in this city yet. Build some more and export again.')}</p>`}
        <p class="dc-foot">${t('Every record is measured from your export: lengths, heights and counts. Nothing is guessed.')}</p></div>`;
    const sc = el.querySelector<HTMLElement>('.dc-scroll');
    if (sc) sc.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- map
  function ensureLayers() {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const GOLD = '#f5a300', INK = '#7a4b00';
    // under the labels, so station and street names stay readable on top of the gold
    const before = map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol');
    const add = (spec: any) => { if (!map.getLayer(spec.id)) map.addLayer(spec, before); };
    add({ id: 'dc-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': GOLD, 'fill-opacity': 0.42 } });
    add({ id: 'dc-outline', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': INK, 'line-width': 1.6 } });
    add({ id: 'dc-glow', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': GOLD, 'line-opacity': 0.38, 'line-blur': 3, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 16, 22] } });
    add({ id: 'dc-line', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': GOLD, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.6, 16, 6] } });
    add({ id: 'dc-halo', type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': GOLD, 'circle-opacity': 0.25, 'circle-radius': ['match', ['get', 'role'], 'pin', 22, 13], 'circle-stroke-color': GOLD, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.7 } });
    add({ id: 'dc-point', type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': GOLD, 'circle-radius': ['match', ['get', 'role'], 'pin', 7, 5.5], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    return true;
  }
  function draw() {
    const d = st.active ? st.data?.items.find((x) => x.id === st.sel) : null;
    if (!map.isStyleLoaded()) { map.once('idle', draw); return; }
    if (!d) { (map.getSource(SRC) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }); badge?.remove(); badge = null; return; }
    ensureLayers();
    (map.getSource(SRC) as GeoJSONSource).setData({ type: 'FeatureCollection', features: d.geom as any });
    badge?.remove();
    const at = anchor(d);
    if (at) {
      const b = document.createElement('div'); b.className = 'dc-badge'; b.dataset.cat = d.cat;
      b.innerHTML = `${svg(d.icon)}<span>${valueHTML(d)}</span>`;
      badge = new maplibregl.Marker({ element: b, anchor: 'bottom', offset: [0, -14] }).setLngLat(at).addTo(map);
    }
  }
  /** where the number badge sits: the pin, else the middle of the longest line, else the biggest shape */
  function anchor(d: Discovery): [number, number] | null {
    const pin = d.geom.find((g) => g.properties.role === 'pin');
    if (pin) return pin.geometry.coordinates as [number, number];
    const lines = d.geom.filter((g) => g.geometry.type === 'LineString').map((g) => g.geometry.coordinates as [number, number][]);
    if (lines.length) {
      const all = lines.length === 1 ? lines[0] : lines.flat();
      if (lines.length > 1) {
        // the coordinate nearest the middle of everything drawn
        const c = all.reduce((s, p) => [s[0] + p[0] / all.length, s[1] + p[1] / all.length], [0, 0]);
        return all.reduce((a, b) => (Math.hypot(b[0] - c[0], b[1] - c[1]) < Math.hypot(a[0] - c[0], a[1] - c[1]) ? b : a));
      }
      return all[all.length >> 1];
    }
    const poly = d.geom.find((g) => g.geometry.type === 'Polygon');
    if (poly) { const r = (poly.geometry.coordinates as [number, number][][])[0]; return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; }
    const pt = d.geom.find((g) => g.geometry.type === 'Point');
    return pt ? (pt.geometry.coordinates as [number, number]) : null;
  }
  function frame(d: Discovery) {
    const phone = isPhone();
    const bottom = phone ? Math.min(innerHeight * 0.6, innerHeight - el.getBoundingClientRect().top) + 40 : 60;
    map.fitBounds([[d.bbox[0], d.bbox[1]], [d.bbox[2], d.bbox[3]]], { padding: { top: phone ? 90 : 90, bottom, left: phone ? 30 : 430, right: phone ? 30 : 70 }, maxZoom: 16.5, duration: 1200, essential: true, bearing: map.getBearing(), pitch: map.getPitch() });
  }

  function select(id: string | null) {
    st.sel = id;
    render(); draw();
    const d = st.data?.items.find((x) => x.id === id);
    if (d) {
      if (isPhone()) sheet.show('peek');
      // a record's card stays in view in the list
      el.querySelector<HTMLElement>(`.dc-card[data-id="${CSS.escape(d.id)}"]`)?.scrollIntoView({ block: 'nearest' });
      requestAnimationFrame(() => frame(d));
    }
  }
  function step(k: number) {
    const list = ordered();
    if (!list.length) return;
    const i = list.findIndex((x) => x.id === st.sel);
    const next = list[(i + k + list.length) % list.length];
    if (st.cat !== 'all' && next.cat !== st.cat) st.cat = 'all';
    select(next.id);
  }

  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const a = tg.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'close') return close();
    if (a === 'tour') return st.tour ? stopTour(true) : startTour();
    stopTour();
    if (a === 'random') { const l = items().filter((d) => d.id !== st.sel); if (l.length) select(l[Math.floor(Math.random() * l.length)].id); return; }
    const s = tg.closest<HTMLElement>('[data-step]')?.dataset.step;
    if (s) return step(+s);
    const tab = tg.closest<HTMLElement>('.dc-tabs [data-cat]')?.dataset.cat as DiscoveryCat | 'all' | undefined;
    if (tab) { st.cat = tab; render(); el.querySelector<HTMLElement>('.dc-scroll')?.scrollTo({ top: 0 }); return; }
    const id = tg.closest<HTMLElement>('.dc-card')?.dataset.id;
    if (id) select(id);
  });
  el.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).matches('input, textarea')) return;
    if (e.key.startsWith('Arrow')) stopTour(true);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' && (e.target as HTMLElement).closest('.dc-spot')) { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' && (e.target as HTMLElement).closest('.dc-spot')) { e.preventDefault(); step(-1); }
    else if (e.key === 'Escape') close();
  });

  /** auto-advance through every record, one every few seconds */
  function startTour() {
    stopTour();
    st.tour = window.setInterval(() => step(1), 6000);
    if (!st.sel) step(1); else render();
  }
  function stopTour(rerender = false) { if (!st.tour) return; clearInterval(st.tour); st.tour = 0; if (rerender) render(); }

  function open(id?: string) {
    if (!st.data) return;
    deps.onOpen();
    if (!st.active) { savedBounds = map.getMaxBounds(); map.setMaxBounds(null); }
    st.active = true; el.hidden = false;
    if (id) st.cat = 'all';
    render();
    if (isPhone()) sheet.show('half');
    if (id) select(id); else draw();
    el.querySelector<HTMLElement>('.dc-card')?.focus({ preventScroll: true });
  }
  function close() {
    if (!st.active) return;
    stopTour();
    st.active = false; st.sel = null; el.hidden = true; sheet.hide(); draw();
    if (savedBounds) { map.setMaxBounds(savedBounds); savedBounds = null; }
  }

  return {
    open, close,
    isActive: () => st.active,
    count: () => st.data?.items.length ?? 0,
    /** results for a newly opened city */
    set(r: DiscoveryResult | null) { close(); st.data = r; st.cat = 'all'; st.sel = null; },
    /** re-render text after a language change */
    refresh() { if (st.active) { render(); draw(); } },
  };
}
