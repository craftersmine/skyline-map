import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type LayerSpecification, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import './consent';
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { buildStyle, SOURCE_KEYS, type StyleOptions } from './style';
import { registerDemProtocol, setDem } from './dem';
import { addIcons, iconDataUrl } from './icons';
import type { BuiltCity, SearchEntry, FC } from './build';
import { fromLngLat, toLngLat } from './geo';
import { createDirections } from './directions';
import { createMeasure } from './measure';
import { createReach } from './reach-ui';
import { createTimelapse } from './timelapse';
import { createDiscoveries } from './discover-ui';
import { createClosure, CLOSURE_ICON } from './closure-ui';
import { createSim } from './sim-ui';
import { createSchematic } from './schematic-view';
import { createContextStore, createContextEditor, moneyField, parseMoney, describeRule } from './context-ui';
import { bottomSheet, isPhone } from './sheet';
import { mountFindFile } from './findfile';
import { showDistrictGlow, clearDistrictGlow } from './district-glow';
import { t, tn, initLang, setLang, onLang, applyStatic, getLang, LANGS, locale, type Lang } from './i18n';

initLang();
applyStatic();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ------------------------------------------------------------------ state
type Mode = 'map' | 'terrain' | 'night';
const saved = (() => { try { return JSON.parse(localStorage.getItem('atlas:opts') ?? '{}'); } catch { return {}; } })();
const state = {
  mode: (saved.mode ?? 'map') as Mode,
  opts: { transit: true, bus: false, cycling: false, buildings3d: true, grid: false, labels: true, contours: false, ...saved.opts } as Omit<StyleOptions, 'theme' | 'terrain'>,
  terrain3d: false,
  city: null as BuiltCity | null,
  contoursLoaded: false,
  currentFile: '' as string,
};
const persist = () => { try { localStorage.setItem('atlas:opts', JSON.stringify({ mode: state.mode, opts: state.opts })); } catch { /* private mode */ } };
const styleOpts = (): StyleOptions => ({ ...state.opts, theme: state.mode === 'night' ? 'dark' : 'light', terrain: state.mode === 'terrain', contours: state.opts.contours || state.mode === 'terrain' });

// ------------------------------------------------------------------ map
const initialHash = location.hash; // a shared link's position wins over fit-to-city
maplibregl.setWorkerUrl(mlWorkerUrl);
registerDemProtocol();
const fontBase = new URL(import.meta.env.BASE_URL, location.href).href;
let currentStyle = buildStyle(styleOpts(), fontBase);
const map = new maplibregl.Map({
  container: 'map',
  style: currentStyle,
  center: [0, 0], zoom: 11, minZoom: 9.5, maxZoom: 21, maxPitch: 75,
  hash: true, attributionControl: false,
  canvasContextAttributes: { antialias: true },
  fadeDuration: 200,
});
(window as any).__map = map;
const styleReady = new Promise<void>((res) => (map.loaded() ? res() : map.once('load', () => res())));
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Cities: Skylines · CSLMapView' }), 'bottom-right');
map.touchZoomRotate.enableRotation();
document.documentElement.dataset.theme = state.mode === 'night' ? 'dark' : 'light';

/** Apply option changes as targeted property updates (setStyle would deep-clone all data). */
function applyStyle() {
  // the style may still be loading (first seconds, or a background tab): apply once it's ready
  if (!(map as any).style?._loaded) { document.documentElement.dataset.theme = state.mode === 'night' ? 'dark' : 'light'; syncUi(); persist(); map.once('idle', () => applyStyle()); return; }
  const next = buildStyle(styleOpts(), fontBase);
  const prevLayers = new Map((currentStyle.layers as LayerSpecification[]).map((l) => [l.id, l]));
  for (const l of next.layers as any[]) {
    const p = prevLayers.get(l.id) as any;
    if (!p || !map.getLayer(l.id)) continue;
    for (const [kind, set] of [['paint', map.setPaintProperty.bind(map) as any], ['layout', map.setLayoutProperty.bind(map) as any]] as [string, (...a: any[]) => void][]) {
      const a = p[kind] ?? {}, b = l[kind] ?? {};
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) set(l.id, k, b[k] ?? (k === 'visibility' ? 'visible' : undefined));
      }
    }
    if (JSON.stringify(p.filter) !== JSON.stringify(l.filter)) map.setFilter(l.id, l.filter ?? null);
  }
  if (JSON.stringify(currentStyle.sky) !== JSON.stringify(next.sky)) map.setSky(next.sky!);
  if (JSON.stringify(currentStyle.light) !== JSON.stringify(next.light)) map.setLight(next.light!);
  currentStyle = next;
  extruded = null; updateExtrusion();
  drawGlow();
  reach.refresh();
  timelapse.refresh();
  closure.refresh();
  sim.refresh();
  document.documentElement.dataset.theme = state.mode === 'night' ? 'dark' : 'light';
  if ((state.opts.contours || state.mode === 'terrain') && state.city && !state.contoursLoaded) requestContours();
  syncUi();
  persist();
}

// ------------------------------------------------------------------ worker / loading
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let loadT0 = 0;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('loadingStep').textContent = t(m.step) + '…'; $('loadingBar').style.width = m.pct + '%'; }
  else if (m.type === 'error') { $('loading').hidden = true; toast(t('Could not open map: {err}', { err: m.message })); if (!state.city) $('welcome').hidden = false; }
  else if (m.type === 'city') showCity(m.city as BuiltCity);
  else if (m.type === 'route') { if (!schem.onRoute(m)) dir.onResult(m); }
  else if (m.type === 'schematic') schem.onMessage(m);
  else if (m.type === 'reach') reach.onResult(m);
  else if (m.type === 'closure' || m.type === 'closureReach') closure.onMessage(m);
  else if (m.type === 'sim' || m.type === 'simProgress') sim.onMessage(m);
  else if (m.type === 'contours') { (map.getSource('contours') as GeoJSONSource).setData(m.fc); state.contoursLoaded = true; }
};
function requestContours() { state.contoursLoaded = true; worker.postMessage({ type: 'contours', interval: 10, major: 50 }); }

async function openBuffer(buf: ArrayBuffer, label: string) {
  $('loading').hidden = false; $('loadingTitle').textContent = label; $('loadingBar').style.width = '2%'; $('loadingStep').textContent = t('Reading file…');
  loadT0 = performance.now();
  worker.postMessage({ type: 'load', buffer: buf }, [buf]);
}
async function openFile(f: File) { state.currentFile = ''; await openBuffer(await f.arrayBuffer(), f.name); }
async function openLocal(file: string) {
  $('loading').hidden = false; $('loadingTitle').textContent = file; $('loadingStep').textContent = t('Downloading…'); $('loadingBar').style.width = '1%';
  try {
    const r = await fetch('/api/maps/' + encodeURIComponent(file));
    if (!r.ok) throw new Error(r.statusText);
    state.currentFile = file;
    const u = new URL(location.href); u.searchParams.set('map', file); history.replaceState(null, '', u);
    await openBuffer(await r.arrayBuffer(), file);
  } catch (err) { $('loading').hidden = true; toast(t('Failed to load {file}: {err}', { file, err: (err as Error).message })); }
}

function showCity(city: BuiltCity) {
  if (reach.isActive()) reach.close();
  timelapse.reset();
  discoveries.set(city.discoveries ?? null);
  closure.reset();
  sim.reset();
  $('discoverBtn').hidden = !discoveries.count();
  state.city = city;
  state.contoursLoaded = false;
  setDem(city.dem);
  const apply = () => {
    for (const k of SOURCE_KEYS) (map.getSource(k) as GeoJSONSource).setData(city.sources[k] as any);
    (map.getSource('contours') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    (map.getSource('selection') as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
    // reload DEM tiles for the new heightmap
    const dem = map.getSource('dem') as any;
    dem?.setTiles?.(['csldem://{z}/{x}/{y}?v=' + Date.now()]);
    const colors = [...new Set(city.sources.places.features.filter((f) => f.properties.kind === 'station').map((f) => String(f.properties.color)))];
    addIcons(map, colors);
    extruded = null; updateExtrusion();
    if ((state.opts.contours || state.mode === 'terrain')) requestContours();
  };
  styleReady.then(apply);

  const [sw, ne] = city.meta.bounds;
  const pad = 0.02;
  map.setMaxBounds([[sw[0] - pad, sw[1] - pad], [ne[0] + pad, ne[1] + pad]]);
  const hashOk = /^#\d/.test(initialHash) && !document.body.dataset.loadedOnce;
  if (!hashOk) map.fitBounds([sw, ne], { padding: 40, duration: document.body.dataset.loadedOnce ? 800 : 0 });
  document.body.dataset.loadedOnce = '1';

  $('welcome').hidden = true; $('loading').hidden = true;
  for (const id of ['topbar', 'layerSwitch', 'controls', 'dirFab']) $(id).hidden = false;
  $('cityChip').textContent = city.meta.name;
  cityTexts(city);
  renderDrawer(city);
  void pricing.attach(city);
  schem.reset();
  closePanel();
  console.info(`[atlas] ${city.meta.name} ready in ${Math.round(performance.now() - loadT0)} ms`, city.meta.stats);
}

function cityTexts(city: BuiltCity) {
  ($('search') as HTMLInputElement).placeholder = t('Search {city}', { city: city.meta.name });
  document.title = `${city.meta.name} · Skyline Map`;
}

// ------------------------------------------------------------------ welcome screen
let autoOpened = false;
async function loadLocalList() {
  const box = $('localMaps');
  try {
    const r = await fetch('/api/maps');
    if (!r.ok) return;
    const { dir, maps } = (await r.json()) as { dir: string; maps: { file: string; size: number; mtime: number }[] };
    if (!maps.length) return;
    const groups = new Map<string, typeof maps>();
    for (const m of maps) {
      const city = m.file.normalize('NFC').replace(/\.cslmap(\.gz)?$/i, '').replace(/-\d{8}-\d{6}$/, '');
      groups.set(city, [...(groups.get(city) ?? []), m]);
    }
    const fmt = (ms: number) => new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
    const palette = ['#1a73e8', '#188038', '#e37400', '#a142f4', '#d93025', '#12a4af', '#5f6368'];
    box.innerHTML = `<h3>${t('Exports on this computer')}</h3><div class="dir">${esc(dir)}</div>` + [...groups].map(([city, list], gi) => `
      <div class="city-group">
        <div class="city-row" role="button" tabindex="0" data-file="${esc(list[0].file)}">
          <span class="avatar" style="background:${palette[gi % palette.length]}">${esc([...city][0] ?? '?')}</span>
          <span class="grow"><div class="cname">${esc(city)}</div><div class="cmeta">${t('Latest {date}', { date: fmt(list[0].mtime) })} · ${(list[0].size / 1e6).toFixed(1)} MB${list.length > 1 ? ` · ${tn(list.length, '{n} save', '{n} saves')}` : ''}</div></span>
          ${list.length > 1 ? `<button class="more" data-toggle>${t('History')}</button>` : ''}
        </div>
        <div class="versions" hidden>${list.map((m) => `<button class="version" data-file="${esc(m.file)}"><span>${esc(m.file)}</span><span>${fmt(m.mtime)}</span></button>`).join('')}</div>
      </div>`).join('');
    box.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-toggle]')) { const v = t.closest('.city-group')!.querySelector('.versions') as HTMLElement; v.hidden = !v.hidden; return; }
      const f = (t.closest('[data-file]') as HTMLElement | null)?.dataset.file;
      if (f) openLocal(f);
    };
    box.onkeydown = (e) => { if (e.key === 'Enter') (e.target as HTMLElement).click(); };
    const want = new URL(location.href).searchParams.get('map');
    if (want && !autoOpened && maps.some((m) => m.file === want)) { autoOpened = true; openLocal(want); }
  } catch { /* static hosting: no local listing */ }
}

mountFindFile($('findFile'));
$('fileInput').addEventListener('change', (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f); });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// ------------------------------------------------------------------ drawer
const fmtGenerated = (raw: string) => { const d = new Date(raw); return isNaN(+d) ? raw : d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }); };
function renderDrawer(city: BuiltCity) {
  const s = city.meta.stats;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString();
  $('cityInfo').innerHTML = `
    <div class="city-title">${esc(city.meta.name)}</div>
    <div class="city-meta">${t('Saved {date}', { date: esc(fmtGenerated(city.meta.generated)) })}${state.currentFile ? ' · ' + esc(state.currentFile) : ''}</div>
    <div class="stats">
      <div class="stat"><b>${n(s.buildings)}</b><span>${t('Buildings')}</span></div>
      <div class="stat"><b>${n(s.roads)}</b><span>${t('Road segments')}</span></div>
      <div class="stat"><b>${n(s.lines)}</b><span>${t('Transit lines')}</span></div>
      <div class="stat"><b>${n(s.stations)}</b><span>${t('Stations')}</span></div>
      <div class="stat"><b>${n(s.districts)}</b><span>${t('Districts')}</span></div>
      <div class="stat"><b>${Math.round(city.meta.elevation.max)} m</b><span>${t('Highest point')}</span></div>
    </div>`;
  const order = ['train', 'metro', 'monorail', 'tram', 'ferry', 'cablecar', 'bus', 'tour', 'air', 'other'];
  const lines = [...city.meta.lines].filter((l) => l.bbox).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  $('lineList').innerHTML = lines.length ? `<h3>${t('Transit lines')}</h3>` + lines.map((l) => `<button class="line-item" data-line="${l.id}"><span class="bullet" style="background:${l.color}"></span><span class="lname">${esc(l.name)}</span><span class="lmode">${esc(modeName(l.type))}</span></button>`).join('') : '';
}
$('lineList').addEventListener('click', (e) => {
  const id = +((e.target as HTMLElement).closest('[data-line]') as HTMLElement | null)?.dataset.line!;
  if (!id || !state.city) return;
  closeDrawer();
  selectLine(id, true);
});
const openDrawer = () => { $('drawer').hidden = false; $('scrim').hidden = false; };
const closeDrawer = () => { $('drawer').hidden = true; $('scrim').hidden = true; };
$('menuBtn').onclick = openDrawer; $('drawerClose').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
$('openOther').onclick = () => { closeDrawer(); $('welcome').hidden = false; };
$('fitCity').onclick = () => { closeDrawer(); if (state.city) map.fitBounds(state.city.meta.bounds, { padding: 40, bearing: 0, pitch: 0 }); };
$('exportPng').onclick = () => {
  closeDrawer();
  const name = (state.city?.meta.name ?? 'map') + '.png';
  // preserveDrawingBuffer is off, so read pixels synchronously inside the render event
  map.once('render', () => {
    const a = document.createElement('a');
    a.href = map.getCanvas().toDataURL('image/png'); a.download = name; a.click();
  });
  map.triggerRepaint();
};
$('welcome').addEventListener('click', (e) => { if (e.target === $('welcome') && state.city) $('welcome').hidden = true; });

// ------------------------------------------------------------------ selection / info panel
// i18n-keys
const LABELS: Record<string, string> = {
  motorway: 'Highway', motorway_link: 'Highway ramp', trunk: 'Expressway', primary: 'Major arterial', secondary: 'Arterial road', tertiary: 'Collector road', minor: 'Local street', service: 'Service road / alley', track: 'Gravel road', raceway: 'Race track', pedestrian: 'Pedestrian street', footway: 'Footpath', trail: 'Trail', runway: 'Runway', taxiway: 'Taxiway', rail: 'Railway', subway: 'Metro track', tram: 'Tram track', monorail: 'Monorail', cablecar: 'Cable car', ferry: 'Ferry route', canal: 'Canal',
  residential: 'Low-density residential', residential_high: 'High-density residential', commercial: 'Commercial', office: 'Office', industrial: 'Industrial', education: 'Education', health: 'Healthcare', civic: 'Public service', landmark: 'Landmark', transport: 'Transport facility', park_building: 'Park structure', plaza: 'Plaza', cemetery: 'Cemetery', sports: 'Sports & recreation', utility: 'Utility', utility_open: 'Utility', apron: 'Aircraft apron', other: 'Building',
  toll: 'Toll booth', hospital: 'Hospital / clinic', school: 'School', police: 'Police', fire: 'Fire station', prison: 'Prison', park: 'Park', nature: 'Nature reserve', amusement: 'Amusement park', zoo: 'Zoo', airport: 'Airport', industry: 'Industry area', campus: 'Campus',
  metro: 'Metro', train: 'Train', bus: 'Bus', ferry_mode: 'Ferry',
};
const MODES: Record<string, string> = { bus: 'Bus', tram: 'Tram', metro: 'Metro', train: 'Train', monorail: 'Monorail', ferry: 'Ferry', cablecar: 'Cable car', tour: 'Walking tour', air: 'Air', other: 'Other' };
const BOOTH_KINDS = ['One-way toll booth (small)', 'One-way toll booth (medium)', 'One-way toll booth (large)', 'Two-way toll booth (small)', 'Two-way toll booth (medium)', 'Two-way toll booth (large)', 'Toll lanes (no booth in the export)'];
const GENERIC_NAMES = ['Toll booth', 'Toll lanes', 'Airport concourse', 'Dropped pin', 'Unnamed stop'];
const ERRORS = ['Not a Skyline Map context file'];
void ERRORS;
// end i18n-keys
/** translated label, or undefined when there is none (so `??` fallbacks still work) */
const L = (k: string | undefined) => (k && LABELS[k] !== undefined ? t(LABELS[k]) : undefined);
const modeName = (m: string) => (MODES[m] ? t(MODES[m]) : m);
/** names the export leaves generic ("Toll booth") are shown in the UI language */
const nameOf = (p: { name?: string; named?: number }) => (p.name && !p.named && GENERIC_NAMES.includes(p.name) ? t(p.name) : p.name ?? '');
void BOOTH_KINDS;
const INTERACTIVE = ['station', 'toll', 'poi', 'park-label', 'district-label', 'busstop', 'transit-line', 'building-3d', 'building', 'bridge-fill', 'road-fill', 'tunnel-fill', 'ground-rail', 'bridge-rail', 'ground-subway', 'bridge-subway', 'runway', 'lots'];
const interactive = () => INTERACTIVE.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');

function setSelection(features: { type: 'Feature'; geometry: any; properties: any }[]) {
  (map.getSource('selection') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  glowDistrict = null; clearDistrictGlow(map);
}

// place shown in the panel, offered as a directions target
let panelPlace: { label: string; ll: [number, number] } | null = null;
function panel(html: string, accent?: string) {
  $('panelBody').innerHTML = (accent ? `<div class="p-hero" style="background:${accent}"></div>` : '') + html;
  if (panelPlace) {
    $('panelBody').querySelector('.p-head')?.insertAdjacentHTML('afterend', `<div class="p-quick">
      <button class="q-btn primary" data-dir="to"><span><svg viewBox="0 0 24 24"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg></span>${t('Directions')}</button>
      <button class="q-btn" data-dir="from"><span><svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg></span>${t('Start here')}</button>
    </div>`);
  }
  const wasOpen = !$('panel').hidden;
  $('panel').hidden = false;
  if (wasOpen) panelSheet.refresh(); else panelSheet.show(isPhone() && innerHeight < 700 ? 'peek' : 'half');
}
/** re-renders the open panel when prices change */
let panelRefresh: (() => void) | null = null;
function closePanel() { $('panel').hidden = true; panelSheet.hide(); setSelection([]); panelRefresh = null; }
// phones: the info panel is a draggable sheet that peeks with the title and actions
const panelSheet = bottomSheet($('panel'), {
  scroll: $('panel'), snaps: ['peek', 'half', 'full'], publish: true,
  peek: () => { const q = $('panel').querySelector<HTMLElement>('.p-quick') ?? $('panel').querySelector<HTMLElement>('.p-head'); return q ? q.offsetTop + q.offsetHeight + 16 : 140; },
  top: () => 0,
});
$('panelClose').onclick = closePanel;
const row = (k: string, v: string | number | undefined | null) => (v === undefined || v === null || v === '' ? '' : `<div class="p-row"><span>${esc(t(k))}</span><span>${typeof v === 'number' ? v.toLocaleString(locale()) : esc(String(v))}</span></div>`);
const head = (title: string, sub: string, icon?: string) => `<div class="p-head">${icon ? `<img src="${icon}" alt="">` : ''}<div><div class="p-title">${esc(title)}</div><div class="p-sub">${esc(sub)}</div></div></div>`;

function stopList(line: BuiltCity['meta']['lines'][number]) {
  const names = line.stopNames ?? [];
  if (!names.some(Boolean)) return '';
  let unnamed = 0;
  const items = names.map((n) => n ? `<li><button class="stop-btn" data-stop="${esc(n)}"><i style="border-color:${line.color}"></i>${esc(n)}</button></li>` : `<li class="muted"><i style="border-color:${line.color}"></i>${t('Stop {n}', { n: ++unnamed })}</li>`).join('');
  return `<div class="stops"><div class="stops-head">${line.shape === 'both' ? t('Stops · runs both ways') : t('Stops · circular route')}</div><ol style="--c:${line.color}">${items}</ol></div>`;
}
function fareRow(line: BuiltCity['meta']['lines'][number]) {
  if (line.type === 'tour' || line.type === 'air') return '';
  const r = pricing.lineRule(line.id);
  return `<div class="p-row"><span>${t('Fare')}</span><span>${r.rule ? esc(describeRule(r.rule, pricing.currency())) + (r.source === 'default' ? ` <small class="muted">${t('(default)')}</small>` : '') : `<span class="muted">${t('Not set')}</span>`} <button class="link-btn" data-edit-fare="${line.id}">${r.rule ? t('Edit') : t('Set fare')}</button></span></div>`;
}
function selectLine(id: number, fit: boolean) {
  panelPlace = null;
  const c = state.city!;
  const line = c.meta.lines.find((l) => l.id === id);
  if (!line) return;
  if (!state.opts.transit) { state.opts.transit = true; applyStyle(); }
  if (line.type === 'bus' && !state.opts.bus) { state.opts.bus = true; applyStyle(); }
  const feats = c.sources.transit.features.filter((f) => f.properties.line === id) as any[];
  setSelection(feats.map((f) => ({ type: 'Feature', geometry: f.geometry, properties: {} })));
  if (fit && line.bbox) map.fitBounds([[line.bbox[0], line.bbox[1]], [line.bbox[2], line.bbox[3]]], { padding: { top: 90, bottom: 60, left: innerWidth > 700 ? 420 : 40, right: 60 }, maxZoom: 15.5 });
  const stations = c.sources.places.features.filter((f) => (f.properties.kind === 'station' || f.properties.kind === 'busstop') && String(f.properties.lines).split(' · ').includes(line.name)).length;
  panelRefresh = () => selectLine(id, false);
  panel(head(line.name, t('{mode} line', { mode: modeName(line.type) }), iconDataUrl(line.type, line.color)) + `<div class="p-rows">${row('Mode', modeName(line.type))}${row('Stops', line.stops)}${row('Stations on map', stations || null)}${fareRow(line)}<div class="p-row"><span>${t('Colour')}</span><span><i class="swatch" style="background:${line.color}"></i>${line.color}</span></div></div>${sim.lineHtml(id)}${stopList(line)}`, line.color);
}

function describe(f: MapGeoJSONFeature, lng: number, lat: number) {
  const p = f.properties as any;
  const layer = f.layer.id;
  const geom = (f.geometry as any);
  panelPlace = { label: nameOf(p) || L(p.cls) || L(p.cat) || (layer === 'busstop' ? t('Bus stop') : t('Dropped pin')), ll: geom.type === 'Point' ? geom.coordinates : [lng, lat] };
  if (layer === 'transit-line') return selectLine(p.line, false);
  if (layer === 'station' || layer === 'busstop') {
    const names = String(p.lines ?? p.name).split(' · ');
    panel(head(layer === 'busstop' ? t('Bus stop') : p.name || t('{mode} station', { mode: modeName(p.poi) }), `${modeName(p.poi)} · ${tn(names.length, '{n} line', '{n} lines')}`, iconDataUrl(p.poi, p.color)) +
      `<div class="p-rows">${names.map((n) => { const l = state.city!.meta.lines.find((x) => x.name === n); return `<div class="p-row"><span><i class="swatch" style="background:${l?.color ?? '#999'}"></i>${esc(n)}</span><span>${esc(l ? modeName(l.type) : '')}</span></div>`; }).join('')}</div>` +
      `<div class="p-actions">${names.map((n) => { const l = state.city!.meta.lines.find((x) => x.name === n); return l ? `<button class="pill" data-line="${l.id}">${esc(t('Show {name}', { name: n }))}</button>` : ''; }).join('')}${closeBtn({ kind: 'station', name: layer === 'station' ? p.name || undefined : undefined, at: fromLngLat(geom.coordinates[0], geom.coordinates[1]), scope: layer === 'busstop' ? 'road' : 'stretch' })}</div>`, p.color);
    setSelection([{ type: 'Feature', geometry: geom, properties: {} }]);
    return;
  }
  if (layer === 'district-label') { showDistrict(p.name); return; }
  if (layer === 'park-label') { panel(head(p.name, L(p.poi) ?? t('Park area'), iconDataUrl(p.poi)) + `<div class="p-rows">${row('Type', L(p.poi))}${row('Position', coordText(lng, lat))}</div>`, '#34a05a'); return; }
  if (layer === 'toll') { showToll(p); panelRefresh = () => showToll(p); return; }
  if (layer === 'poi') { panel(head(p.name, L(p.poi) ?? t('Point of interest'), iconDataUrl(p.poi)) + `<div class="p-rows">${row('Lot area', p.area ? p.area + ' m²' : null)}${row('Position', coordText(lng, lat))}</div>`); return; }
  describeRest(f, p, layer, geom, lng, lat);
}
function showToll(p: any) {
  {
    const roads = String(p.roads || '').split(' · ').filter(Boolean), types = String(p.roadTypes || '').split(' · ').filter(Boolean);
    panel(head(nameOf(p), t(p.boothKind), iconDataUrl('toll')) + `<div class="p-rows">${row('On road', roads[0] || types[0] || null)}${roads.length > 1 ? row('Also connects', roads.slice(1).join(', ')) : ''}${row('Road types', types.join(', '))}${row('Toll lanes', p.gates ? tn(p.gates, '{n} gate segment', '{n} gate segments') : t('none found'))}</div>${tollFeeEditor(+p.id, !!p.unconfirmed)}${p.unconfirmed ? `<p class="muted small" style="padding:0 22px 14px;margin:0">${t('These toll lanes have no booth building in the export (it may have been removed in game), so they may not charge. Directions still flag them.')}</p>` : ''}`, '#d9822b');
  }
}
function tollFeeEditor(id: number, unconfirmed: boolean) {
  const f = pricing.tollFee(id), def = pricing.ctx?.tollDefault ?? null;
  const ph = def !== null && !unconfirmed ? t('{fee} default', { fee: pricing.money(def) }) : t('Not set');
  return `<div class="p-fee"><div><b>${t('Toll fee')}</b><div class="muted small">${f.source === 'own' ? t('Set for this booth') : f.source === 'default' ? t('Using the city default') : t('Not in the export: add your own')}</div></div>${moneyField(pricing, `data-panel-booth="${id}" aria-label="${esc(t('Toll fee'))}"`, f.source === 'own' ? f.fee : null, ph)}</div>
    <div class="p-fee-foot"><button class="link-btn" data-open-pricing="tolls">${t('All toll fees & currency')}</button></div>`;
}
function describeRest(f: MapGeoJSONFeature, p: any, layer: string, geom: any, lng: number, lat: number) {
  if (layer.startsWith('building') || layer === 'lots') {
    const c = state.city!;
    const lot = c.sources.lots.features.find((x) => x.properties.id === p.id) as any;
    const bld = c.sources.buildings.features.find((x) => x.properties.id === p.id) as any;
    // a multi-part asset (station halls, stadium stands…) is selected as a whole
    const grp = p.grp ?? p.id, parts = Number(p.nparts) > 1 ? c.sources.lots.features.filter((x) => (x.properties.grp ?? x.properties.id) === grp) as any[] : lot ? [lot] : [];
    setSelection(parts.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: {} })));
    const level = /Level ?(\d)/.exec(p.icls ?? '')?.[1];
    panel(head(nameOf(p) || L(p.cat) || t('Building'), L(p.cat) ?? p.cat) + `<div class="p-rows">${row('District', p.district)}${row('This part', p.part ? p.asset : null)}${row('Buildings in asset', Number(p.nparts) > 1 ? p.nparts : null)}${row('Zone / service', String(p.srv ?? '').replace(/([a-z])([A-Z])/g, '$1 $2'))}${row('Class', p.icls)}${p.named && !p.part ? row('Asset', p.asset) : ''}${row('Level', level)}${row('Lot area', p.area ? p.area + ' m²' : null)}${row('Est. height', bld?.properties.h ? bld.properties.h + ' m' : null)}${row('Asset ID', p.id)}</div>${sim.buildingHtml(Number(p.id))}`);
    return;
  }
  if (layer === 'water') { panel(head(t('Water'), t('Lake, river or sea')) + `<div class="p-rows">${row('Position', coordText(lng, lat))}</div>`, '#a2cdf3'); return; }
  // roads / rails
  const name = p.name || L(p.cls) || p.type;
  let sel: any[] = [{ type: 'Feature', geometry: geom, properties: {} }];
  if (p.name) {
    const all = state.city!.sources.roads.features.filter((x) => x.properties.name === p.name) as any[];
    sel = all.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: {} }));
  }
  setSelection(sel);
  const totalLen = p.name ? Math.round(sel.reduce((s, x) => s + lineLen(x.geometry.coordinates), 0)) : p.len;
  panel(head(name, (L(p.cls) ?? p.cls) + (p.brunnel === 'bridge' ? ' · ' + t('Bridge / elevated') : p.brunnel === 'tunnel' ? ' · ' + t('Tunnel') : '')) +
    `<div class="p-rows">${row('Road type', p.type)}${row('District', p.district)}${row('Lanes', p.lanes || null)}${row('Speed limit', p.speed ? p.speed + ' km/h' : null)}${row('Bike lane', p.bike ? t('Yes') : null)}${row('Carriageway', p.w ? p.w + ' m' : null)}${row('One-way', p.oneway ? t('Yes') : null)}${row(p.name ? t('Total length') : t('Segment length'), totalLen ? (totalLen > 1000 ? (totalLen / 1000).toFixed(2) + ' km' : totalLen + ' m') : null)}${row('Elevation', p.z !== undefined ? Math.round(p.z) + ' m' : null)}</div>${p.id !== undefined && !/rail|subway|monorail|tram|cablecar/.test(p.cls) ? sim.roadHtml(Number(p.id)) : ''}${p.id !== undefined && !['runway', 'taxiway', 'canal', 'ferry'].includes(p.cls) ? `<div class="p-actions">${closeBtn({ kind: /rail|subway|monorail|tram|cablecar/.test(p.cls) ? 'rail' : 'road', seg: Number(p.id) })}</div>` : ''}`);
}
/** The district shown as a soft region (estimated: no district shapes in the export), redrawn on theme changes. */
let glowDistrict: number | null = null;
function drawGlow() {
  const f = state.city?.districtField;
  if (glowDistrict === null || !f) return;
  showDistrictGlow(map, f, glowDistrict, state.mode === 'night' ? '#b7a6e8' : '#7d5fc4', state.mode === 'night');
}
function showDistrict(name: string) {
  const c = state.city!;
  const dl = c.sources.places.features.find((f) => f.properties.kind === 'district' && f.properties.name === name);
  panelPlace = dl ? { label: name, ll: (dl.geometry as any).coordinates } : null;
  const areas = c.sources.districts.features.filter((f) => f.properties.name === name) as any[];
  setSelection([]);
  glowDistrict = dl ? Number(dl.properties.did) : null;
  drawGlow();
  let area = 0;
  for (const f of areas) area += Math.abs(ringAreaLL(f.geometry.coordinates[0]));
  const blds = c.sources.lots.features.filter((f) => f.properties.district === name);
  const by = (cat: string) => blds.filter((f) => String(f.properties.cat).startsWith(cat)).length;
  const stations = c.sources.places.features.filter((f) => f.properties.kind === 'station' && f.properties.name && areas.some((a) => inPoly((f.geometry as any).coordinates, a.geometry.coordinates))).map((f) => String(f.properties.name));
  const about = (v: number | null) => (v ? '≈ ' + v : null);
  panel(head(name, t('District, estimated area')) + `<div class="p-rows">${row('Area', area ? '≈ ' + (area / 1e6).toFixed(2) + ' km²' : null)}${row('Buildings', about(blds.length))}${row('Residential', about(by('residential')))}${row('Commercial / office', about(by('commercial') + by('office')))}${row('Industrial', about(by('industrial')))}${row('Stations', stations.join(', ') || null)}</div>
    <p class="p-note">${t('The export has no district boundaries. This area is estimated from the district label and the transit stops that record it, so its edges and counts are approximate.')}</p>`, '#7d5fc4');
}
function ringAreaLL(r: [number, number][]) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const p = fromLngLat(r[i][0], r[i][1]), q = fromLngLat(r[j][0], r[j][1]); a += (q[0] - p[0]) * (q[1] + p[1]); } return a / 2; }
function inPoly(pt: [number, number], rings: [number, number][][]) {
  const inside = (r: [number, number][]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if ((r[i][1] > pt[1]) !== (r[j][1] > pt[1]) && pt[0] < ((r[j][0] - r[i][0]) * (pt[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; } return c; };
  return inside(rings[0]) && !rings.slice(1).some(inside);
}
/** "What if it closes?" button for a panel */
function closeBtn(p: import('./closure').ClosurePick) {
  return `<button class="pill" data-close-pick="${esc(JSON.stringify(p))}"><svg viewBox="0 0 24 24" width="16" height="16"><path fill-rule="evenodd" d="${CLOSURE_ICON}"/></svg>${t('What if it closes?')}</button>`;
}
function lineLen(c: [number, number][]) { let l = 0; for (let i = 1; i < c.length; i++) { const a = fromLngLat(c[i - 1][0], c[i - 1][1]), b = fromLngLat(c[i][0], c[i][1]); l += Math.hypot(a[0] - b[0], a[1] - b[1]); } return l; }
function coordText(lng: number, lat: number) { const [x, z] = fromLngLat(lng, lat); return `x ${Math.round(x)}, z ${Math.round(z)}`; }

$('panelBody').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const cp = (t.closest('[data-close-pick]') as HTMLElement | null)?.dataset.closePick;
  if (cp) return closure.open(JSON.parse(cp));
  const dd = (t.closest('[data-dir]') as HTMLElement | null)?.dataset.dir;
  if (dd && panelPlace) { const pl = panelPlace; closePanel(); return dd === 'to' ? dir.setTo(pl) : dir.setFrom(pl); }
  const id = (t.closest('[data-line]') as HTMLElement | null)?.dataset.line;
  if (id) return selectLine(+id, true);
  const fare = (t.closest('[data-edit-fare]') as HTMLElement | null)?.dataset.editFare;
  if (fare) return pricingEd.open('fares', { line: +fare });
  const tab = (t.closest('[data-open-pricing]') as HTMLElement | null)?.dataset.openPricing;
  if (tab) return pricingEd.open(tab as 'tolls');
  const stop = (t.closest('[data-stop]') as HTMLElement | null)?.dataset.stop;
  const f = stop && state.city!.sources.places.features.find((x) => x.properties.kind === 'station' && x.properties.name === stop);
  if (f) map.flyTo({ center: (f.geometry as any).coordinates, zoom: Math.max(map.getZoom(), 16), speed: 1.4 });
});

$('panelBody').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.matches('[data-panel-booth]')) void pricing.setTollFee(+t.dataset.panelBooth!, parseMoney(pricing, t.value), 'panel');
});
$('panelBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target as HTMLElement).matches('[data-panel-booth]')) (e.target as HTMLInputElement).blur(); });

map.on('click', (e) => {
  if (!state.city) return;
  hideCtx();
  if (measure.isActive()) { measure.click(e); return; }
  if (reach.isActive()) { reach.click([e.lngLat.lng, e.lngLat.lat]); return; }
  if (discoveries.isActive()) return;
  if (closure.isActive()) { closurePickAt(e.point); return; }
  if (dir.isOpen()) { dir.mapClick([e.lngLat.lng, e.lngLat.lat], placeLabelAt(e.point)); return; }
  if (sim.isOpen()) sim.close();
  const r = 6;
  const feats = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: interactive() });
  if (!feats.length) { closePanel(); return; }
  // prefer symbols, then lines, then polygons
  const pri = (f: MapGeoJSONFeature) => INTERACTIVE.indexOf(f.layer.id);
  feats.sort((a, b) => pri(a) - pri(b));
  describe(feats[0], e.lngLat.lng, e.lngLat.lat);
});
let hoverRaf = 0;
map.on('mousemove', (e) => {
  if (!state.city || hoverRaf || measure.isActive() || reach.isActive()) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const hit = map.queryRenderedFeatures(e.point, { layers: interactive().filter((l) => l !== 'lots' && l !== 'water') }).length > 0;
    map.getCanvas().style.cursor = hit ? 'pointer' : '';
  });
});

// ------------------------------------------------------------------ pricing (user-supplied context)
const pricing = createContextStore();
const pricingEd = createContextEditor(pricing, {
  flyTo: (x, z) => map.flyTo({ center: toLngLat(x, z), zoom: Math.max(map.getZoom(), 16.5), speed: 1.4 }),
  toast,
  onOpen: () => { closeDrawer(); if (measure.isActive()) measure.close(); },
});
pricing.on((origin) => { if (origin !== 'panel' && !$('panel').hidden) panelRefresh?.(); });
$('pricingBtn').onclick = () => { closeDrawer(); pricingEd.open(); };

// ------------------------------------------------------------------ schematic transit map
const schem = createSchematic({
  worker, pricing,
  cityName: () => state.city?.meta.name ?? '',
  showStation: (p) => {
    const se = state.city?.search.find((x) => x.kind === 'station' && x.name === p.label);
    if (se) choose(se); else map.flyTo({ center: p.ll, zoom: 16.5, speed: 1.6 });
  },
  showLine: (id) => selectLine(id, true),
  directions: (from, to) => dir.open({ from, to, mode: 'transit' }),
  onOpen: () => { closeDrawer(); closePanel(); if (measure.isActive()) measure.close(); },
  onClose: () => {},
});
$('schemBtn').onclick = () => { closeDrawer(); schem.open(); };
$('schemChip').onclick = () => schem.open();

// ------------------------------------------------------------------ directions
const dir = createDirections({
  map, worker, city: () => state.city,
  pricing, editPricing: (tab, focus) => pricingEd.open(tab, focus),
  showOnSchematic: (route) => schem.open({ route }),
  simRules: () => sim.hasRules(),
  onOpen: () => { closePanel(); sim.close(); if (reach.isActive()) reach.close(); discoveries.close(); closure.close(); $('topbar').hidden = true; document.body.classList.add('dir-open'); },
  onClose: () => { $('topbar').hidden = false; document.body.classList.remove('dir-open'); },
});
$('dirBtn').onclick = () => dir.open();
$('dirFab').onclick = () => dir.open();

const measure = createMeasure(map, {
  onOpen: () => { closePanel(); if (dir.isOpen()) dir.close(); if (reach.isActive()) reach.close(); discoveries.close(); closure.close(); $('measureBtn').classList.add('on'); },
  onClose: () => $('measureBtn').classList.remove('on'),
});
$('measureBtn').onclick = () => measure.toggle();

const reach = createReach(map, {
  worker,
  land: () => state.city?.districtField ?? null,
  night: () => state.mode === 'night',
  onOpen: () => { closeDrawer(); closePanel(); sim.close(); if (dir.isOpen()) dir.close(); if (measure.isActive()) measure.close(); if (timelapse.isActive()) timelapse.close(); discoveries.close(); closure.close(); },
});
$('reachBtn').onclick = () => { closeDrawer(); const c = map.getCenter(); reach.open([c.lng, c.lat]); };

const timelapse = createTimelapse(map, {
  worker, city: () => state.city, currentFile: () => state.currentFile, toast,
  onOpen: () => { closeDrawer(); closePanel(); sim.close(); if (reach.isActive()) reach.close(); if (measure.isActive()) measure.close(); discoveries.close(); closure.close(); },
});
$('timelapseBtn').onclick = () => timelapse.open();

const discoveries = createDiscoveries(map, {
  onOpen: () => { sim.close(); closeDrawer(); closePanel(); hideCtx(); if (dir.isOpen()) dir.close(); if (reach.isActive()) reach.close(); if (measure.isActive()) measure.close(); if (timelapse.isActive()) timelapse.close(); closure.close(); },
});
$('discoverBtn').onclick = () => (discoveries.isActive() ? discoveries.close() : discoveries.open());
$('discoverMenu').onclick = () => discoveries.open();

const closure = createClosure(map, {
  worker, toast,
  land: () => state.city?.districtField ?? null,
  night: () => state.mode === 'night',
  onOpen: () => { sim.close(); closeDrawer(); closePanel(); hideCtx(); if (dir.isOpen()) dir.close(); if (reach.isActive()) reach.close(); if (measure.isActive()) measure.close(); if (timelapse.isActive()) timelapse.close(); discoveries.close(); },
});
$('closureMenu').onclick = () => closure.open();

const sim = createSim(map, {
  worker, toast, city: () => state.city,
  onRules: () => dir.rulesChanged(),
  selectLine: (id) => selectLine(id, true),
  onOpen: () => { closeDrawer(); closePanel(); hideCtx(); if (dir.isOpen()) dir.close(); if (reach.isActive()) reach.close(); if (measure.isActive()) measure.close(); if (timelapse.isActive()) timelapse.close(); discoveries.close(); closure.close(); },
});
$('simMenu').onclick = () => sim.open();
/** What a click while closing picks: a station, a railway, or a road (nearest of each in a small box). */
function closurePickAt(pt: { x: number; y: number }) {
  const r = 8, box: [[number, number], [number, number]] = [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
  const layers = (ids: string[]) => ids.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
  // stations first (small targets on top of track), then whatever is drawn on top
  const st = map.queryRenderedFeatures(box, { layers: layers(['station', 'busstop']) })[0];
  if (st) { const c = (st.geometry as any).coordinates as [number, number]; return closure.pick({ kind: 'station', name: st.layer.id === 'station' ? (st.properties.name || undefined) : undefined, at: fromLngLat(c[0], c[1]), scope: st.layer.id === 'busstop' ? 'road' : 'stretch' }); }
  const RAIL = ['ground-rail', 'bridge-rail', 'tunnel-rail', 'ground-subway', 'bridge-subway', 'ground-tram', 'bridge-tram', 'tunnel-tram'];
  // a drawn transit line is also the only way to reach metro tunnels (they aren't drawn): it closes the track under it
  for (const f of map.queryRenderedFeatures(box, { layers: layers([...RAIL, 'transit-line', 'bridge-fill', 'road-fill', 'tunnel-fill']) })) {
    if (f.layer.id === 'transit-line') { if (f.properties.seg !== undefined && !['bus', 'tour'].includes(String(f.properties.mode))) return closure.pick({ kind: 'rail', seg: Number(f.properties.seg) }); continue; }
    if (f.properties.id !== undefined) return closure.pick({ kind: RAIL.includes(f.layer.id) ? 'rail' : 'road', seg: Number(f.properties.id) });
  }
}

/** Name of whatever labelled thing is under a screen point, else a generic pin label. */
function placeLabelAt(pt: { x: number; y: number }): string {
  const order = ['station', 'poi', 'park-label', 'building', 'lots'];
  const f = map.queryRenderedFeatures([[pt.x - 10, pt.y - 10], [pt.x + 10, pt.y + 10]], { layers: order.filter((l) => map.getLayer(l)) })
    .filter((x) => x.properties.name && (!x.layer.id.match(/^(building|lots)$/) || x.properties.named))
    .sort((a, b) => order.indexOf(a.layer.id) - order.indexOf(b.layer.id))[0];
  return f ? nameOf(f.properties as any) : t('Dropped pin');
}

// right-click menu (Google's "Directions from / to here")
const ctx = document.createElement('div');
ctx.id = 'ctxMenu'; ctx.className = 'card'; ctx.hidden = true;
document.body.appendChild(ctx);
let ctxPlace: { label: string; ll: [number, number] } | null = null;
function hideCtx() { ctx.hidden = true; }
map.on('contextmenu', (e) => {
  if (!state.city) return;
  e.preventDefault();
  ctxPlace = { label: placeLabelAt(e.point), ll: [e.lngLat.lng, e.lngLat.lat] };
  const [x, z] = fromLngLat(e.lngLat.lng, e.lngLat.lat);
  ctx.innerHTML = `<div class="ctx-title">${esc(ctxPlace.label === t('Dropped pin') ? `x ${Math.round(x)}, z ${Math.round(z)}` : ctxPlace.label)}</div>
    <button data-c="from">${t('Directions from here')}</button><button data-c="to">${t('Directions to here')}</button><button data-c="measure">${t('Measure distance')}</button><button data-c="reach">${t('How far can I get from here?')}</button>`;
  const r = map.getContainer().getBoundingClientRect();
  ctx.style.left = Math.min(e.point.x + r.left, innerWidth - 230) + 'px';
  ctx.style.top = Math.min(e.point.y + r.top, innerHeight - 170) + 'px';
  ctx.hidden = false;
});
ctx.addEventListener('click', (e) => {
  const c = ((e.target as HTMLElement).closest('[data-c]') as HTMLElement | null)?.dataset.c;
  if (!c || !ctxPlace) return;
  hideCtx();
  if (c === 'measure') return measure.open(ctxPlace.ll);
  if (c === 'reach') return reach.open(ctxPlace.ll);
  c === 'from' ? dir.setFrom(ctxPlace) : dir.setTo(ctxPlace);
});
map.on('movestart', hideCtx);

// ------------------------------------------------------------------ search
const KIND_ORDER: Record<string, number> = { district: 0, station: 1, park: 2, line: 3, road: 4, poi: 5 };
let results: SearchEntry[] = [];
let active = -1;
const searchInput = $('search') as HTMLInputElement;
function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  $('searchClear').hidden = !q;
  const box = $('results');
  if (!q || !state.city) { $('searchbox').classList.remove('open'); return; }
  const scored: [number, SearchEntry][] = [];
  const seen = new Set<string>();
  for (const s of state.city.search) {
    const n = s.name.toLowerCase();
    const i = n.indexOf(q);
    if (i < 0) continue;
    const key = s.kind + s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push([(i === 0 ? 0 : 10) + (KIND_ORDER[s.kind] ?? 5) * 2 + n.length / 100, s]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  results = scored.slice(0, 12).map((x) => x[1]);
  active = results.length ? 0 : -1;
  const hl = (name: string) => { const i = name.toLowerCase().indexOf(q); return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length)); };
  const pin = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
  const road = '<svg viewBox="0 0 24 24"><path d="M11 4h2v3h-2zm0 6h2v4h-2zm0 7h2v3h-2zM4 20 8 4h2L6.5 20zm16 0h-2.5L14 4h2z"/></svg>';
  box.innerHTML = results.length ? results.map((s, i) => {
    const line = s.kind === 'line' ? state.city!.meta.lines.find((l) => l.name === s.name) : null;
    const icon = s.kind === 'station' ? `<img src="${iconDataUrl(s.sub)}" alt="">` : s.kind === 'poi' ? `<img src="${iconDataUrl(s.sub)}" alt="">` : s.kind === 'park' ? `<img src="${iconDataUrl(/Nature/.test(s.sub) ? 'nature' : /Airport/.test(s.sub) ? 'airport' : 'park')}" alt="">` : line ? `<img src="${iconDataUrl(line.type, line.color)}" alt="">` : `<span class="ricon">${s.kind === 'road' ? road : pin}</span>`;
    const sub = s.kind === 'station' ? t('{mode} station', { mode: modeName(s.sub) }) : s.kind === 'district' ? t('District') : s.kind === 'road' ? s.sub : s.kind === 'line' ? t('{mode} line', { mode: modeName(s.sub) }) : s.kind === 'park' ? (s.sub === 'Generic' ? t('Park') : L(s.sub.toLowerCase()) ?? s.sub.replace(/([a-z])([A-Z])/g, '$1 $2')) : L(s.sub) ?? s.sub;
    return `<div class="result${i === active ? ' active' : ''}" data-i="${i}" role="option">${icon}<div style="min-width:0"><div class="rname">${hl(s.name)}</div><div class="rsub">${esc(sub)}</div></div></div>`;
  }).join('') : `<div class="result-empty">${esc(t('No results for “{q}”', { q: searchInput.value }))}</div>`;
  $('searchbox').classList.add('open');
}
function choose(s: SearchEntry) {
  $('searchbox').classList.remove('open');
  searchInput.value = s.name; searchInput.blur();
  if (s.kind === 'line') { const l = state.city!.meta.lines.find((x) => x.name === s.name); if (l) return selectLine(l.id, true); }
  if (s.bbox) map.fitBounds([[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]], { padding: { top: 100, bottom: 60, left: innerWidth > 700 ? 420 : 40, right: 60 }, maxZoom: 16.5 });
  else map.flyTo({ center: s.center, zoom: s.zoom, speed: 1.6 });
  if (s.kind === 'road') {
    const all = state.city!.sources.roads.features.filter((x) => x.properties.name === s.name) as any[];
    setSelection(all.map((x) => ({ type: 'Feature', geometry: x.geometry, properties: {} })));
    const f = all[0];
    if (f) {
      const p = f.properties;
      const len = Math.round(all.reduce((t, x) => t + lineLen(x.geometry.coordinates), 0));
      panel(head(s.name, L(p.cls) ?? t('Road')) + `<div class="p-rows">${row('Road type', p.type)}${row('Total length', len > 1000 ? (len / 1000).toFixed(2) + ' km' : len + ' m')}${row('Segments', all.length)}</div>`);
    }
  } else {
    map.once('moveend', () => {
      const pt = map.project(s.center);
      const f = map.queryRenderedFeatures([[pt.x - 20, pt.y - 20], [pt.x + 20, pt.y + 20]], { layers: ['district-label', 'park-label', 'poi', 'station'].filter((l) => map.getLayer(l)) }).find((x) => x.properties.name === s.name);
      if (s.kind === 'district') showDistrict(s.name);
      else if (f) describe(f, s.center[0], s.center[1]);
      else panel(head(s.name, s.kind === 'district' ? t('District') : L(s.sub) ?? s.sub));
    });
  }
}
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('focus', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!results.length) return; active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; $('results').querySelectorAll('.result').forEach((el, i) => el.classList.toggle('active', i === active)); }
  else if (e.key === 'Enter' && active >= 0) choose(results[active]);
  else if (e.key === 'Escape') { $('searchbox').classList.remove('open'); searchInput.blur(); }
});
$('results').addEventListener('mousedown', (e) => { const el = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null; if (el) { e.preventDefault(); choose(results[+el.dataset.i!]); } });
searchInput.addEventListener('blur', () => setTimeout(() => $('searchbox').classList.remove('open'), 120));
$('searchClear').onclick = () => { searchInput.value = ''; runSearch(); searchInput.focus(); closePanel(); };
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput && state.city) { e.preventDefault(); searchInput.focus(); }
  if (e.key === 'Escape') { closePanel(); closeDrawer(); hideCtx(); $('layerPop').hidden = true; }
});

// ------------------------------------------------------------------ chips, layers, controls
function syncUi() {
  document.querySelectorAll<HTMLElement>('#chips .chip[data-opt]').forEach((c) => {
    const k = c.dataset.opt as keyof typeof state.opts;
    c.classList.toggle('on', !!state.opts[k] || (k === 'contours' && state.mode === 'terrain'));
  });
  document.querySelectorAll<HTMLElement>('.layer-opt').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  $('layerThumb').className = 'thumb ' + (state.mode === 'night' ? 't-map' : state.mode === 'terrain' ? 't-map' : 't-terrain');
  ($('optLabels') as HTMLInputElement).checked = state.opts.labels;
  ($('opt3dTerrain') as HTMLInputElement).checked = state.terrain3d;
  $('tilt').classList.toggle('on', map.getPitch() > 5);
}
$('chips').addEventListener('click', (e) => {
  const c = (e.target as HTMLElement).closest('.chip[data-opt]') as HTMLElement | null;
  if (!c) return;
  const k = c.dataset.opt as keyof typeof state.opts;
  (state.opts as any)[k] = !state.opts[k];
  if (k === 'bus' && state.opts.bus) state.opts.transit = true;
  if (k === 'transit' && !state.opts.transit) state.opts.bus = false;
  if (k === 'buildings3d' && state.opts.buildings3d && map.getPitch() < 10 && map.getZoom() > 15) map.easeTo({ pitch: 50, duration: 600 });
  applyStyle();
});
$('layerBtn').onclick = (e) => { e.stopPropagation(); $('layerPop').hidden = !$('layerPop').hidden; };
document.addEventListener('click', (e) => { if (!$('layerSwitch').contains(e.target as Node)) $('layerPop').hidden = true; });
document.querySelectorAll<HTMLElement>('.layer-opt').forEach((b) => (b.onclick = () => { state.mode = b.dataset.mode as Mode; applyStyle(); }));
$('optLabels').onchange = (e) => { state.opts.labels = (e.target as HTMLInputElement).checked; applyStyle(); };
$('opt3dTerrain').onchange = (e) => { state.terrain3d = (e.target as HTMLInputElement).checked; set3dTerrain(); };
function set3dTerrain() {
  map.setTerrain(state.terrain3d ? { source: 'dem', exaggeration: 1.2 } : null);
  if (state.terrain3d && map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
  syncUi();
}
$('zoomIn').onclick = () => map.zoomIn();
$('zoomOut').onclick = () => map.zoomOut();
$('compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
$('tilt').onclick = () => map.easeTo({ pitch: map.getPitch() > 5 ? 0 : 55, duration: 700 });
// Google-style: the compass only shows once the map is turned or tilted (phones)
const syncNorth = () => document.body.classList.toggle('north-up', Math.abs(map.getBearing()) < 0.5 && map.getPitch() < 1);
map.on('rotate', () => { ($('compassIcon') as unknown as SVGElement).style.transform = `rotate(${-map.getBearing()}deg)`; syncNorth(); });
map.on('pitch', syncNorth);
syncNorth();
// phones: attribution starts collapsed to its (i) button
map.once('load', () => { if (isPhone()) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'); });
map.on('pitchend', syncUi);
// Google-style: footprints stay flat top-down, extrude once the camera tilts
let extruded: boolean | null = null;
function updateExtrusion() {
  const want = state.opts.buildings3d && (map.getPitch() > 8 || state.terrain3d);
  if (want === extruded || !map.getLayer('building-3d')) return;
  extruded = want;
  map.setLayoutProperty('building-3d', 'visibility', want ? 'visible' : 'none');
}
map.on('pitch', updateExtrusion);

let toastT = 0;
function toast(msg: string) { const el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = window.setTimeout(() => (el.hidden = true), 4500); }

map.on('error', (e) => { if (!String(e.error?.message ?? '').includes('csldem')) console.warn('[map]', e.error?.message ?? e); });

// ------------------------------------------------------------------ language
function renderLangSwitches() {
  document.querySelectorAll<HTMLElement>('.lang-switch').forEach((box) => {
    box.innerHTML = LANGS.map((l) => `<button role="radio" aria-checked="${l.id === getLang()}" class="${l.id === getLang() ? 'on' : ''}" data-lang="${l.id}">${l.name}</button>`).join('');
  });
}
document.addEventListener('click', (e) => {
  const l = ((e.target as HTMLElement).closest('[data-lang]') as HTMLElement | null)?.dataset.lang as Lang | undefined;
  if (l && l !== getLang()) setLang(l);
});
worker.postMessage({ type: 'lang', lang: getLang() });
onLang(() => {
  worker.postMessage({ type: 'lang', lang: getLang() });
  applyStatic(); renderLangSwitches(); applyStyle();
  if (state.city) { renderDrawer(state.city); cityTexts(state.city); }
  if (!$('panel').hidden) { if (panelRefresh) panelRefresh(); else closePanel(); }
  dir.relang(); measure.refresh(); pricingEd.refresh(); schem.relang(); discoveries.refresh(); closure.refresh();
  if (!$('welcome').hidden) loadLocalList();
});
renderLangSwitches();

syncUi();
loadLocalList();

export type { FC };
