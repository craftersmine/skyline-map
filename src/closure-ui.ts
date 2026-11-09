// "What if it closes?": pick a road, bridge, tunnel, railway or station; the worker closes it in the router
// and compares trips across it, the lines it cuts, places cut off, and what's reachable from a point before
// and after. The map shows the closure, the detour against the old route, and the change in reach.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource } from 'maplibre-gl';
import { HALF, toLngLat, fromLngLat, type XY } from './geo';
import { t, locale } from './i18n';
import { bottomSheet, isPhone } from './sheet';
import type { ClosurePick, ClosureResult, Trip } from './closure';
import type { ReachGrid } from './reach';
import type { DistrictField } from './district-glow';

type LL = [number, number];
type RMode = 'drive' | 'transit' | 'walk' | 'bike';
type View = 'change' | 'before' | 'after';
const SRC = 'closure', RSRC = 'closure-reach';
const LAYERS = ['cl-stranded', 'cl-before', 'cl-after-glow', 'cl-after', 'cl-closed-case', 'cl-closed', 'cl-closed-dash', 'cl-stop', 'cl-stop-x'];
const MAX = 30 * 60;
// change bands: no change, +1–5, +5–15, +15 min or more, lost
const CHANGE = ['#9fb3c8', '#f2c94c', '#f2994a', '#d64545', '#7b1e5b'];
const BANDS = ['#253494', '#2c7fb8', '#41b6c4', '#a1dab4'];
const VERDICT: Record<string, [string, string]> = {
  cut: ['No way around', 'Some trips across it become impossible: nothing else connects the two sides.'],
  long: ['Long detour', 'Everything still connects, but the way round takes much longer.'],
  detour: ['Noticeable detour', 'There is another way, and it costs a few minutes.'],
  minor: ['Barely matters', 'Good alternatives nearby: trips take about as long as before.'],
  none: ['No trips affected', 'Nothing in the network depends on it: no route or line uses it.'],
};
const STATION_VERDICT: Record<string, string> = {
  cut: 'No other station can be reached on foot.', long: 'The next open station is a long walk away.', detour: 'The next open station is a few minutes further on foot.', minor: 'Another station is close by.',
};
const MODE_LABELS: Record<RMode, string> = { drive: 'Drive', transit: 'Transit', walk: 'Walk', bike: 'Cycle' };
// i18n-keys
void ['Cars can go round, but on foot there is no other way across.', 'You can still cross on foot, but cars have no other way.', 'No way around', 'Some trips across it become impossible: nothing else connects the two sides.', 'Long detour', 'Everything still connects, but the way round takes much longer.', 'Noticeable detour', 'There is another way, and it costs a few minutes.', 'Barely matters', 'Good alternatives nearby: trips take about as long as before.', 'No trips affected', 'Nothing in the network depends on it: no route or line uses it.', 'No other station can be reached on foot.', 'The next open station is a long walk away.', 'The next open station is a few minutes further on foot.', 'Another station is close by.', 'Drive', 'Transit', 'Walk', 'Cycle'];
void ['What if it closes?', 'Close', 'Tap a road, bridge, tunnel, railway or station on the map to close it.', 'Roads and bridges', 'Railways and tunnels', 'Stations', 'Pick another', 'This stretch', 'All of {name}',
  'Trips across it', 'Before', 'After', 'no route', '{n} min', '+{n} min', 'Trains run through without stopping', 'Cut here', 'Nearest open station', 'was {label}, {time}', '{time} walk', 'Cut off',
  '{len} of road can no longer be reached by car.', '{len} of path can no longer be reached on foot.', 'What can you reach in 30 minutes?', 'Reachable area', 'Drag the pin to start somewhere else.', 'Working it out…',
  'Change', 'Lost', 'No change', 'Closing it…', 'Nothing here can be closed. Try a road, railway or station.', 'by transit', 'on foot', 'via {via}', '{what} · {len}', '{what} · {len} · {n} tracks', '{what} · {len} · {n} carriageways',
  'Uses the export\'s network and the same routing as Directions. Lines through the closure are cut there; nothing reroutes them. No traffic or passenger numbers are involved: the export has none.',
  'No line runs here, so closing it changes no trip.', 'Station', 'Bus stop'];
// end i18n-keys
void VERDICT; void STATION_VERDICT;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const BARRIER = 'M4 9h16v6H4zm2 1.6v2.8h2.2l2.8-2.8zm6.2 0-2.8 2.8h3.6l2.8-2.8zm5.4 0-2.8 2.8H18v-2.8zM6 16h2v4H6zm10 0h2v4h-2zM6 4h2v4H6zm10 0h2v4h-2z';
export const CLOSURE_ICON = BARRIER;
const ICON: Record<string, string> = {
  drive: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v7a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zm2.2-1h9.6l-1-3H8.2zM7.5 12a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  walk: 'M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2.1 2.1 0 0 0-2.6-.8L6 8.3V13h2V9.6z',
  transit: 'M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h12v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 10H6V6h5zm2 0V6h5v4zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  bike: 'M15.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm5.8-10L13 8.3l.8.8A7 7 0 0 0 19 11V9a5 5 0 0 1-3.6-1.5l-1.9-1.9a2 2 0 0 0-2.8 0L7.5 8.8a2 2 0 0 0 0 2.8L10 14v5h2v-6.2zM19 12a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 8.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
};
const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${d}"/></svg>`;

// i18n-keys: closure notes
void ['Uses the export\'s network and the same routing as Directions. Lines through the closure are cut there; nothing reroutes them. No traffic or passenger numbers are involved: the export has none.', 'Uses the export\'s network and the same routing as Directions, with the traffic from your save as an estimate. Lines through the closure are cut there; nothing reroutes them.'];
// end i18n-keys
export function createClosure(map: MLMap, deps: { worker: Worker; land: () => DistrictField | null; night: () => boolean; onOpen: () => void; toast: (m: string) => void; traffic: () => boolean }) {
  /** traffic-aware routing (switched in Directions) changes the drive times shown here */
  const note = () => deps.traffic()
    ? t('Uses the export\'s network and the same routing as Directions, with the traffic from your save as an estimate. Lines through the closure are cut there; nothing reroutes them.')
    : t('Uses the export\'s network and the same routing as Directions. Lines through the closure are cut there; nothing reroutes them. No traffic or passenger numbers are involved: the export has none.');
  const st = {
    active: false, pick: null as ClosurePick | null, res: null as ClosureResult | null, busy: false, id: 0, sel: 0,
    rmode: 'drive' as RMode, view: 'change' as View, pin: null as LL | null, grids: null as { before: ReachGrid | null; after: ReachGrid | null } | null, rbusy: false, rid: 0, fit: false,
  };
  const el = document.createElement('div');
  el.id = 'closure'; el.className = 'card'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', t('What if it closes?'));
  document.body.appendChild(el);
  const sheet = bottomSheet(el, {
    scroll: () => el.querySelector<HTMLElement>('.cl-scroll') ?? el, snaps: ['peek', 'half', 'full'], publish: true,
    peek: () => { const v = el.querySelector<HTMLElement>('.cl-verdict') ?? el.querySelector<HTMLElement>('.cl-head'); return v ? v.offsetTop + v.offsetHeight + 12 : 130; },
    top: () => 56, onDismiss: () => close(),
  });
  const pinEl = document.createElement('div'); pinEl.className = 'cl-pin';
  const marker = new maplibregl.Marker({ element: pinEl, draggable: true, anchor: 'bottom' });
  marker.on('dragend', () => { const p = marker.getLngLat(); st.pin = [p.lng, p.lat]; requestReach(); });

  const mins = (s: number) => Math.max(1, Math.round(s / 60));
  const fmtLen = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
  const fmtArea = (m2: number) => (m2 < 1e6 ? `${(m2 / 1e4).toFixed(1)} ha` : `${(m2 / 1e6).toFixed(m2 < 1e7 ? 2 : 1)} km²`);
  const title = (r: ClosureResult) => (r.titleKey ? t(r.title) : r.title);

  // ---------------------------------------------------------------- panel
  function tripRow(tr: Trip, i: number, scale: number) {
    const lbl = tr.mode === 'transit' ? `${esc(tr.line!.name)} <span>${esc(tr.from!)} → ${esc(tr.to!)}</span>` : esc(t(tr.dir));
    const icon = tr.mode === 'transit' ? `<i class="cl-dot" style="background:${esc(tr.line!.color)}"></i>` : svg(ICON[tr.mode]);
    const b = tr.before ?? 0, a = tr.after;
    const wb = Math.max(4, (b / scale) * 100), wa = a === null ? 100 : Math.max(4, (a / scale) * 100);
    const diff = a === null ? `<b class="lost">${t('no route')}</b>` : a - b >= 30 ? `<b>${t('+{n} min', { n: Math.round((a - b) / 60) || '<1' })}</b>` : `<b class="same">${t('No change')}</b>`;
    const how = tr.mode === 'transit' && a !== null ? `<em>${tr.how === 'walk' ? t('on foot') : tr.via ? esc(t('via {via}', { via: tr.via })) : t('by transit')}</em>` : '';
    return `<li><button class="cl-trip${i === st.sel ? ' on' : ''}" data-trip="${i}" aria-pressed="${i === st.sel}">
      <span class="cl-trip-h"><span class="cl-trip-i">${icon}</span><span class="cl-trip-l">${lbl}</span>${diff}</span>
      <span class="cl-bars"><span class="cl-bar b" style="width:${wb}%"></span><span class="cl-n">${t('{n} min', { n: mins(b) })}</span></span>
      <span class="cl-bars"><span class="cl-bar a${a === null ? ' none' : ''}" style="width:${wa}%"></span><span class="cl-n">${a === null ? '—' : t('{n} min', { n: mins(a) })}</span></span>
      ${how}</button></li>`;
  }

  function render() {
    void ['Drive', 'Transit', 'Walk', 'Cycle'];
    const head = `<div class="cl-head"><span class="cl-mark">${svg(BARRIER)}</span><b>${t('What if it closes?')}</b>
      <button class="icon-btn" data-a="close" aria-label="${t('Close')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>`;
    const r = st.res;
    if (!r) {
      el.innerHTML = `${head}<div class="cl-scroll"><p class="cl-lede">${st.busy ? t('Closing it…') : t('Tap a road, bridge, tunnel, railway or station on the map to close it.')}</p>
        ${st.busy ? '' : `<ul class="cl-kinds"><li>${svg(ICON.drive)}${t('Roads and bridges')}</li><li>${svg(ICON.transit)}${t('Railways and tunnels')}</li><li><i class="cl-dot st"></i>${t('Stations')}</li></ul>`}
        <p class="cl-note">${note()}</p></div>`;
      return;
    }
    const [vh, vs] = VERDICT[r.verdict];
    // which modes lost their way across, so 'No way around' says who is stuck
    const lost = (m: string) => r.trips.some((x) => x.mode === m && x.before !== null && x.after === null);
    const kept = (m: string) => r.trips.some((x) => x.mode === m && x.after !== null);
    const cutWho = r.verdict === 'cut' && lost('walk') && !lost('drive') && kept('drive') ? 'Cars can go round, but on foot there is no other way across.'
      : r.verdict === 'cut' && lost('drive') && !lost('walk') && kept('walk') ? 'You can still cross on foot, but cars have no other way.' : '';
    const vsub0 = r.kind === 'station' && !r.trips.length ? STATION_VERDICT[r.verdict] ?? vs : r.verdict === 'none' && r.kind !== 'station' && !r.cutLines.length && r.kind === 'rail' ? 'No line runs here, so closing it changes no trip.' : vs;
    const vsub = cutWho || vsub0;
    const what = r.kind === 'station' ? t(r.what) : r.parts > 1 ? t(r.kind === 'rail' ? '{what} · {len} · {n} tracks' : '{what} · {len} · {n} carriageways', { what: t(r.what), len: fmtLen(r.len), n: r.parts }) : t('{what} · {len}', { what: t(r.what), len: fmtLen(r.len) });
    const scale = Math.max(60, ...r.trips.flatMap((x) => [x.before ?? 0, x.after ?? 0]));
    const scope = r.canWholeRoad ? `<div class="cl-seg" role="radiogroup"><button role="radio" aria-checked="${r.scope === 'stretch'}" data-scope="stretch">${t('This stretch')}</button><button role="radio" aria-checked="${r.scope === 'road'}" data-scope="road">${esc(t('All of {name}', { name: r.title }))}</button></div>` : '';
    const n = r.nearest;
    const station = n ? `<div class="cl-near"><span>${t('Nearest open station')}</span>${n.after ? `<b>${esc(n.after.label)}</b><em>${esc(t('{time} walk', { time: t('{n} min', { n: mins(n.after.time) }) }))}</em>` : `<b class="lost">${t('no route')}</b>`}
      ${n.before ? `<small>${esc(t('was {label}, {time}', { label: n.before.label, time: t('{n} min', { n: mins(n.before.time) }) }))}</small>` : ''}</div>` : '';
    const lineChips = (ls: { name: string; color: string }[]) => ls.map((l) => `<span class="cl-chip"><i style="background:${esc(l.color)}"></i>${esc(l.name)}</span>`).join('');
    const sd = r.stranded;
    const reachStats = (() => {
      const a = areas();
      if (!a) return st.rbusy ? `<p class="cl-muted">${t('Working it out…')}</p>` : '';
      const pct = a.before ? Math.round(((a.after - a.before) / a.before) * 100) : 0;
      return `<div class="cl-area"><span>${t('Reachable area')}</span><b>${fmtArea(a.before)}</b><span class="arr">→</span><b>${fmtArea(a.after)}</b>${pct ? `<em class="${pct < 0 ? 'down' : ''}">${pct > 0 ? '+' : ''}${pct}%</em>` : ''}</div>`;
    })();
    const legend = st.view === 'change'
      ? `<div class="cl-legend">${[t('No change'), '+1–5', '+5–15', '+15', t('Lost')].map((l, i) => `<span><i style="background:${CHANGE[i]}"></i>${esc(l)}</span>`).join('')}<em>${t('{n} min', { n: '' }).trim()}</em></div>`
      : `<div class="cl-legend">${BANDS.map((c, i) => `<span><i style="background:${c}"></i>${i * 7.5}–${(i + 1) * 7.5}</span>`).join('')}<em>${t('{n} min', { n: '' }).trim()}</em></div>`;
    el.innerHTML = `${head}
      <div class="cl-scroll">
      <div class="cl-what"><div><b>${esc(title(r))}</b><span>${esc(what)}</span></div><button class="pill" data-a="change">${t('Pick another')}</button></div>
      ${scope}
      <section class="cl-verdict" data-v="${r.verdict}"><b>${t(vh)}</b><p>${t(vsub)}</p></section>
      ${station}
      ${r.skipped.length ? `<div class="cl-lines"><span>${t('Trains run through without stopping')}</span>${lineChips(r.skipped)}</div>` : ''}
      ${r.cutLines.length ? `<div class="cl-lines"><span>${t('Cut here')}</span>${lineChips(r.cutLines)}</div>` : ''}
      ${r.trips.length ? `<h4>${t('Trips across it')}<span><i class="b"></i>${t('Before')}<i class="a"></i>${t('After')}</span></h4><ol class="cl-trips">${r.trips.map((x, i) => tripRow(x, i, scale)).join('')}</ol>` : ''}
      ${sd.drive > 20 || sd.walk > 20 ? `<div class="cl-cut"><b>${t('Cut off')}</b>${sd.drive > 20 ? `<p>${esc(t('{len} of road can no longer be reached by car.', { len: fmtLen(sd.drive) }))}</p>` : ''}${sd.walk > 20 ? `<p>${esc(t('{len} of path can no longer be reached on foot.', { len: fmtLen(sd.walk) }))}</p>` : ''}</div>` : ''}
      <h4>${t('What can you reach in 30 minutes?')}</h4>
      <div class="cl-seg modes" role="radiogroup">${(Object.keys(MODE_LABELS) as RMode[]).map((m) => `<button role="radio" aria-checked="${st.rmode === m}" data-mode="${m}">${svg(ICON[m])}<span>${t(MODE_LABELS[m])}</span></button>`).join('')}</div>
      <div class="cl-seg view" role="radiogroup">${(['before', 'after', 'change'] as View[]).map((v) => `<button role="radio" aria-checked="${st.view === v}" data-view="${v}">${t(v === 'change' ? 'Change' : v === 'before' ? 'Before' : 'After')}</button>`).join('')}</div>
      ${legend}${reachStats}
      <p class="cl-muted">${t('Drag the pin to start somewhere else.')}</p>
      <p class="cl-note">${note()}</p>
      </div>`;
  }

  // ---------------------------------------------------------------- map
  function ensure() {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const before = map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol');
    const add = (spec: any) => { if (!map.getLayer(spec.id)) map.addLayer(spec, before); };
    const w = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 11, a, 17, b];
    const f = (r: string) => ['==', ['get', 'r'], r];
    add({ id: 'cl-stranded', type: 'line', source: SRC, filter: f('stranded'), layout: { 'line-cap': 'round' }, paint: { 'line-color': '#7b1e5b', 'line-width': w(2, 5), 'line-dasharray': [1, 1.4], 'line-opacity': 0.85 } });
    add({ id: 'cl-before', type: 'line', source: SRC, filter: f('before'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#5f6368', 'line-width': w(2.5, 5), 'line-dasharray': [1.2, 1.4], 'line-opacity': 0.8 } });
    add({ id: 'cl-after-glow', type: 'line', source: SRC, filter: f('after'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#7c4dff', 'line-width': w(8, 16), 'line-opacity': 0.25, 'line-blur': 2 } });
    add({ id: 'cl-after', type: 'line', source: SRC, filter: f('after'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#6a3df0', 'line-width': w(3, 6) } });
    add({ id: 'cl-closed-case', type: 'line', source: SRC, filter: f('closed'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': w(7, 16) } });
    add({ id: 'cl-closed', type: 'line', source: SRC, filter: f('closed'), layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#d93025', 'line-width': w(5, 12) } });
    add({ id: 'cl-closed-dash', type: 'line', source: SRC, filter: f('closed'), layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#fff', 'line-width': w(1.5, 3.5), 'line-dasharray': [1.5, 1.5] } });
    add({ id: 'cl-stop', type: 'circle', source: SRC, filter: f('stop'), paint: { 'circle-color': '#d93025', 'circle-radius': w(6, 11), 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  }
  function drawLines() {
    if (!map.isStyleLoaded()) { map.once('idle', drawLines); return; }
    const r = st.active ? st.res : null;
    if (!r) { (map.getSource(SRC) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] }); return; }
    ensure();
    const line = (c: LL[], role: string) => ({ type: 'Feature' as const, properties: { r: role }, geometry: { type: 'LineString' as const, coordinates: c } });
    const tr = r.trips[st.sel];
    const feats = [
      ...r.stranded.geom.map((c) => line(c, 'stranded')),
      ...(tr && tr.beforePath.length > 1 ? [line(tr.beforePath, 'before')] : []),
      ...(tr && tr.afterPath.length > 1 ? [line(tr.afterPath, 'after')] : []),
      ...r.closed.map((c) => line(c, 'closed')),
      ...r.stops.map((p) => ({ type: 'Feature' as const, properties: { r: 'stop' }, geometry: { type: 'Point' as const, coordinates: p } })),
    ];
    (map.getSource(SRC) as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  const landAt = (f: DistrictField | null, x: number, z: number) => {
    if (!f) return true;
    const i = Math.floor((x + HALF) / f.cell), j = Math.floor((z + HALF) / f.cell);
    return i < 0 || j < 0 || i >= f.n || j >= f.n ? false : !!f.land[j * f.n + i];
  };
  /** both grids on one box: the union of their extents */
  function union() {
    const g = st.grids; if (!g || (!g.before && !g.after)) return null;
    const gs = [g.before, g.after].filter(Boolean) as ReachGrid[];
    const x0 = Math.min(...gs.map((q) => q.x0)), z0 = Math.min(...gs.map((q) => q.z0)), x1 = Math.max(...gs.map((q) => q.x0 + q.w)), z1 = Math.max(...gs.map((q) => q.z0 + q.h));
    const at = (q: ReachGrid | null, i: number, j: number) => { if (!q) return Infinity; const a = i - q.x0, b = j - q.z0; return a < 0 || b < 0 || a >= q.w || b >= q.h ? Infinity : q.t[b * q.w + a]; };
    return { x0, z0, w: x1 - x0, h: z1 - z0, cell: gs[0].cell, b: (i: number, j: number) => at(g.before, i, j), a: (i: number, j: number) => at(g.after, i, j) };
  }
  function areas() {
    const u = union(); if (!u) return null;
    const f = deps.land(); let b = 0, a = 0; const c2 = u.cell * u.cell;
    for (let j = u.z0; j < u.z0 + u.h; j++) for (let i = u.x0; i < u.x0 + u.w; i++) {
      if (!landAt(f, (i + 0.5) * u.cell - HALF, (j + 0.5) * u.cell - HALF)) continue;
      if (u.b(i, j) <= MAX) b += c2; if (u.a(i, j) <= MAX) a += c2;
    }
    return { before: b, after: a };
  }
  function drawReach() {
    if (!map.isStyleLoaded()) { map.once('idle', drawReach); return; }
    if (map.getLayer(RSRC)) map.removeLayer(RSRC);
    if (map.getSource(RSRC)) map.removeSource(RSRC);
    const u = st.active && st.res ? union() : null;
    if (!u) return;
    const f = deps.land(), alpha = Math.round(255 * (deps.night() ? 0.5 : 0.56));
    const hex = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    const C = CHANGE.map(hex), B = BANDS.map(hex);
    const small = document.createElement('canvas'); small.width = u.w; small.height = u.h;
    const sc = small.getContext('2d')!, img = sc.createImageData(u.w, u.h);
    for (let jj = 0; jj < u.h; jj++) for (let ii = 0; ii < u.w; ii++) {
      const i = u.x0 + ii, j = u.z0 + jj;
      const b = u.b(i, j), a = u.a(i, j);
      let col: number[] | null = null, op = alpha;
      if (st.view === 'change') {
        if (!(b <= MAX)) continue;
        const d = a <= MAX ? a - b : Infinity;
        const k = d === Infinity ? 4 : d < 60 ? 0 : d < 300 ? 1 : d < 900 ? 2 : 3;
        col = C[k]; if (k === 0) op = Math.round(alpha * 0.45);
      } else {
        const v = st.view === 'before' ? b : a;
        if (!(v <= MAX)) continue;
        col = B[Math.min(3, Math.floor((v / MAX) * 4))];
      }
      const x = (i + 0.5) * u.cell - HALF, z = (j + 0.5) * u.cell - HALF;
      if (!landAt(f, x, z)) continue;
      const o = ((u.h - 1 - jj) * u.w + ii) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = op;
    }
    sc.putImageData(img, 0, 0);
    const S = 4, cv = document.createElement('canvas'); cv.width = u.w * S; cv.height = u.h * S;
    const c = cv.getContext('2d')!; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(small, 0, 0, cv.width, cv.height);
    const X = (i: number) => i * u.cell - HALF, Z = (j: number) => j * u.cell - HALF;
    const corners: [XY, XY, XY, XY] = [toLngLat(X(u.x0), Z(u.z0 + u.h)), toLngLat(X(u.x0 + u.w), Z(u.z0 + u.h)), toLngLat(X(u.x0 + u.w), Z(u.z0)), toLngLat(X(u.x0), Z(u.z0))];
    map.addSource(RSRC, { type: 'image', url: cv.toDataURL('image/png'), coordinates: corners });
    map.addLayer({ id: RSRC, type: 'raster', source: RSRC, paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, map.getLayer('water') ? 'water' : undefined);
  }

  // ---------------------------------------------------------------- worker
  function analyze(p: ClosurePick) {
    st.pick = p; st.res = null; st.busy = true; st.grids = null; st.sel = 0; st.fit = true;
    render(); drawLines(); drawReach();
    deps.worker.postMessage({ type: 'closure', id: ++st.id, pick: p });
  }
  function requestReach() {
    if (!st.pick || !st.pin) return;
    st.rbusy = true; st.grids = null; render(); drawReach();
    deps.worker.postMessage({ type: 'closureReach', id: ++st.rid, pick: st.pick, from: fromLngLat(st.pin[0], st.pin[1]), mode: st.rmode, max: MAX });
  }
  function frame(r: ClosureResult) {
    const phone = isPhone();
    const [w, s, e, n] = r.bbox, pad = 0.004;
    map.fitBounds([[w - pad, s - pad], [e + pad, n + pad]], { padding: { top: 90, bottom: phone ? innerHeight * 0.45 : 60, left: phone ? 30 : 440, right: phone ? 30 : 70 }, maxZoom: 16, duration: 900 });
  }

  /** First reach result after a closure: widen the view to the closure plus everywhere trips got slower. */
  function frameChange() {
    const u = union(), r = st.res; if (!u || !r) return;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let j = u.z0; j < u.z0 + u.h; j++) for (let i = u.x0; i < u.x0 + u.w; i++) {
      const b = u.b(i, j); if (!(b <= MAX)) continue;
      const a = u.a(i, j); if (a <= MAX && a - b < 60) continue;
      x0 = Math.min(x0, i); z0 = Math.min(z0, j); x1 = Math.max(x1, i); z1 = Math.max(z1, j);
    }
    if (x0 === Infinity) return;
    const sw = toLngLat(x0 * u.cell - HALF, z0 * u.cell - HALF), ne = toLngLat((x1 + 1) * u.cell - HALF, (z1 + 1) * u.cell - HALF);
    const bb: [number, number, number, number] = [Math.min(sw[0], r.bbox[0]), Math.min(sw[1], r.bbox[1]), Math.max(ne[0], r.bbox[2]), Math.max(ne[1], r.bbox[3])];
    frame({ ...r, bbox: bb });
  }

  // ---------------------------------------------------------------- events
  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const a = tg.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'close') return close();
    if (a === 'change') { st.pick = null; st.res = null; st.grids = null; marker.remove(); render(); drawLines(); drawReach(); return; }
    const sc = tg.closest<HTMLElement>('[data-scope]')?.dataset.scope as 'stretch' | 'road' | undefined;
    if (sc && st.pick && st.res && sc !== st.res.scope) return analyze({ ...st.pick, scope: sc });
    const tr = tg.closest<HTMLElement>('[data-trip]')?.dataset.trip;
    if (tr !== undefined) { st.sel = +tr; render(); drawLines(); const p = st.res?.trips[st.sel]; if (p && p.afterPath.length) { const all = [...p.afterPath, ...p.beforePath]; map.fitBounds([[Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1]))], [Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))]], { padding: { top: 90, bottom: isPhone() ? innerHeight * 0.45 : 60, left: isPhone() ? 30 : 440, right: 70 }, maxZoom: 16, duration: 700 }); } return; }
    const m = tg.closest<HTMLElement>('[data-mode]')?.dataset.mode as RMode | undefined;
    if (m && m !== st.rmode) { st.rmode = m; return requestReach(); }
    const v = tg.closest<HTMLElement>('[data-view]')?.dataset.view as View | undefined;
    if (v && v !== st.view) { st.view = v; render(); drawReach(); }
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function open(p?: ClosurePick) {
    deps.onOpen();
    st.active = true; el.hidden = false;
    if (p) analyze(p); else { st.pick = null; st.res = null; render(); }
    if (isPhone()) sheet.show(p ? 'peek' : 'half');
    document.body.classList.add('closure-open');
  }
  function close() {
    if (!st.active) return;
    st.active = false; st.res = null; st.pick = null; st.grids = null; el.hidden = true; sheet.hide(); marker.remove();
    drawLines(); drawReach(); document.body.classList.remove('closure-open');
  }

  return {
    open, close,
    isActive: () => st.active,
    /** a click on the map while open: close what was clicked (main resolves the feature) */
    pick(p: ClosurePick) { analyze(p); if (isPhone()) sheet.show('peek'); },
    onMessage(m: any) {
      if (m.type === 'closure') {
        if (m.id !== st.id || !st.active) return;
        st.busy = false;
        if (!m.result) { st.pick = null; render(); deps.toast(t('Nothing here can be closed. Try a road, railway or station.')); return; }
        st.res = m.result as ClosureResult; st.rmode = st.res.mode; st.pin = st.res.pin;
        marker.setLngLat(st.pin).addTo(map);
        render(); drawLines(); frame(st.res); requestReach();
        if (isPhone()) sheet.show('peek');
      } else if (m.type === 'closureReach') {
        if (m.id !== st.rid || !st.active) return;
        st.rbusy = false; st.grids = { before: m.before, after: m.after }; render(); drawReach();
        if (st.fit) { st.fit = false; frameChange(); }
      }
    },
    /** redraw after a style or language change */
    refresh() { if (st.active) { render(); drawLines(); drawReach(); } },
    reset() { close(); },
  };
}
void LAYERS; void locale;
