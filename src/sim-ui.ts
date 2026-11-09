// Simulation data: an optional Cities: Skylines save (.crp) laid over the open map. The worker reads the save
// and checks it shows the same city state (sim/validate.ts); this module shows the outcome, the map overlays
// (traffic, land value, noise, pollution, crime) and the extra rows in the info panels. Values appear only
// on objects the check matched; city-wide figures are labelled as covering the whole save.
import type { Map as MLMap, ExpressionSpecification } from 'maplibre-gl';
import type { BuiltCity } from './build';
import type { SimResult, SimData, SimFailure, SimLine } from './sim';

type TmSeg = NonNullable<SimData['tmpe']>['segs'][number];
import { toLngLat } from './geo';
import { roadWidth } from './style';
import { t, tn, locale } from './i18n';
import { bottomSheet } from './sheet';

type Layer = 'none' | 'traffic' | 'landValue' | 'noise' | 'pollution' | 'crime';
const LAYERS: Layer[] = ['none', 'traffic', 'landValue', 'noise', 'pollution', 'crime'];
const TRAFFIC = 'sim-traffic', RASTER = 'sim-grid', COVER = 'sim-cover';
const IMM_HALF = 128 * 38.4; // immaterial grid: 256 cells of 38.4 m, central 25 tiles only
const NAT_HALF = 256 * 33.75; // natural grid: 512 cells of 33.75 m, the whole map
const TRAFFIC_COLORS: [number, string][] = [[0, '#34a853'], [40, '#a8c530'], [60, '#f6bf26'], [80, '#f2853d'], [100, '#d93025']];
// sequential ramps (low → high); index 0 is the colour at the bottom of the scale
const RAMPS: Record<Exclude<Layer, 'none' | 'traffic'>, string[]> = {
  landValue: ['#f7fcb9', '#c2e699', '#78c679', '#31a354', '#006837'],
  noise: ['#efe7f6', '#cbb7e3', '#9e86c8', '#7350ae', '#4a1486'],
  pollution: ['#fff1d6', '#f3c78a', '#d9904a', '#a8582a', '#6e3510'],
  crime: ['#fff3c4', '#fdc77a', '#f88d4f', '#e04a3a', '#a50f2d'],
};
// i18n-keys
void ['Simulation data', 'Close', 'Enhance your map with real traffic, population, transit, and other data from your Cities: Skylines save.',
  'Choose a save (.crp)', 'Tip: in the CSLMapView mod options, turn on “Auto export on saving game”. Every time you save, the mod writes a map export of the same moment, so the save and the export always match.',
  'Saves are in the game\'s Saves folder:', 'Your files stay on this computer. Nothing is uploaded.',
  'Reading save file', 'Checking it matches this map', 'Reading simulation data', 'Reading {file}…',
  'Matches this map', 'Every road, junction and building on the map was found in the save, unchanged.',
  'Close match', 'Some objects differ between the two files: they were built, removed or changed in between. Simulation values appear only where the two match exactly.',
  '{roads} of {nroads} roads and {blds} of {nblds} buildings match.',
  'This save is from a different city', 'None of this map\'s roads or junctions appear in it. Open this save\'s own map export, or choose the save that belongs to this map.',
  'This save is too far apart in time', 'It is the same city, but only {pct}% of the map\'s roads and buildings are unchanged in the save. Choose the save made at the same time as this export.',
  'This map has nothing to compare against.',
  'This isn\'t a Cities: Skylines save', 'Choose a .crp file from the game\'s Saves folder.',
  'This .crp file isn\'t a saved game', 'It may be an asset, a map or a scenario. Choose a file from the Saves folder.',
  'This save is from an untested game version', 'Skyline Map reads saves from the current and the previous version of the game. This one uses save format {n}.',
  'This save file is incomplete', 'It may not have finished copying or downloading. Try the original file.',
  'This save file is damaged', 'Its contents don\'t match the checksum the game wrote into it. Try the original file, or save again in the game.',
  'This save couldn\'t be read', 'It may be damaged, or a mod changed how the game stores this data.',
  'Choose another save', 'Remove simulation data', 'Save: {city}', 'In game {date}', 'Saved {date}',
  'Map layer', 'Off', 'Traffic', 'Land value', 'Noise', 'Ground pollution', 'Crime',
  'Free-flowing', 'Jammed', 'Low', 'High', 'None', 'Matched roads only. The game\'s traffic view shows the same value.',
  'The game records this only for the central 25 tiles.', 'Whole map.',
  'Whole city, from the save', 'Population', 'Workers', 'Jobs', 'Unemployment', 'Education', 'Uneducated', 'Educated', 'Well educated', 'Highly educated',
  'Tourists', 'Happiness', 'Crime rate', 'Average land value', 'Taxes', 'Residential', 'Commercial', 'Industrial', 'Office', 'low', 'high',
  'Transit ridership', 'Passengers per week, as the game\'s line panel shows them.',
  'Some data couldn\'t be read from this save: {list}.', 'building occupancy', 'transit ridership', 'traffic rules', 'city statistics', 'map layers',
  'From your save', 'This object doesn\'t match the save, so no simulation data is shown for it.',
  'Residents', 'Households', 'Workers now', 'Students', 'Visitors now', 'Happiness', 'Traffic', 'Speed limit (TM:PE)', 'Default speed for this road type (TM:PE)', 'Parking', 'Not allowed', 'One side only', 'No limit',
  'Passengers per week', '{res} residents · {tour} tourists', 'Last full week', 'Car trips saved', 'as the game shows it',
  'Simulation data loaded', 'Simulation data removed', 'Used for directions',
  'Directions, reach and closures now follow the traffic rules in your save: {list}.', 'Left-hand traffic: one-way directions and per-direction rules aren\'t applied yet.', 'Traffic density is shown, never used as a speed.'];
// end i18n-keys

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (v: number) => v.toLocaleString(locale());
const pct = (v: number) => `${v.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;

export function createSim(map: MLMap, deps: { worker: Worker; city: () => BuiltCity | null; onOpen: () => void; selectLine: (id: number) => void; toast: (m: string) => void; onRules: () => void }) {
  const st = {
    open: false, busy: false, step: '', file: '', id: 0,
    data: null as SimData | null, fail: null as SimFailure | null,
    layer: 'none' as Layer,
    traffic: new Map<number, number>(), bld: new Map<number, number>(), tm: new Map<number, TmSeg>(), lines: new Map<number, SimLine>(),
  };

  const el = document.createElement('div');
  el.id = 'sim'; el.className = 'card'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', t('Simulation data'));
  document.body.appendChild(el);
  const sheet = bottomSheet(el, {
    scroll: () => el.querySelector<HTMLElement>('.sim-scroll') ?? el, snaps: ['peek', 'half', 'full'], publish: true,
    peek: () => { const v = el.querySelector<HTMLElement>('.sim-status') ?? el.querySelector<HTMLElement>('.m-head'); return v ? v.offsetTop + v.offsetHeight + 12 : 130; },
    top: () => 56, onDismiss: () => close(),
  });
  const legendChip = document.createElement('button');
  legendChip.id = 'simLegend'; legendChip.className = 'card'; legendChip.hidden = true;
  document.body.appendChild(legendChip);
  legendChip.onclick = () => open();
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.crp,.gz'; input.hidden = true;
  document.body.appendChild(input);
  input.onchange = () => { const f = input.files?.[0]; input.value = ''; if (f) void load(f); };

  // ---------------------------------------------------------------- loading
  async function load(f: File) {
    if (!deps.city()) return;
    // a new attempt replaces the old data, so a failed load never leaves the previous save's values showing
    clear();
    st.busy = true; st.fail = null; st.file = f.name; st.step = ''; render();
    const buf = await f.arrayBuffer();
    deps.worker.postMessage({ type: 'sim', id: ++st.id, buffer: buf }, [buf]);
  }
  function onMessage(m: { type: string; id: number; step?: string; result?: SimResult }) {
    if (m.id !== st.id) return;
    if (m.type === 'simProgress') { st.step = m.step ?? ''; render(); return; }
    st.busy = false;
    const r = m.result!;
    if (r.ok) { apply(r); deps.toast(t('Simulation data loaded')); if (r.rulesSummary) deps.onRules(); }
    else { st.fail = r; }
    render();
  }

  function apply(r: SimData) {
    // the worker applied this save's rules itself just before replying; only reset what the page shows
    clearView();
    st.data = r; st.fail = null;
    if (r.traffic) for (let i = 0; i < r.traffic.ids.length; i++) st.traffic.set(r.traffic.ids[i], r.traffic.pct[i]);
    if (r.buildings) for (let i = 0; i < r.buildings.ids.length; i++) st.bld.set(r.buildings.ids[i], i);
    if (r.tmpe) for (const s of r.tmpe.segs) st.tm.set(s.id, s);
    if (r.lines) for (const l of r.lines) st.lines.set(l.id, l);
    if (st.layer !== 'none') draw();
  }
  function clearView() {
    st.data = null; st.traffic.clear(); st.bld.clear(); st.tm.clear(); st.lines.clear();
    removeLayers();
  }
  /** drop the save entirely: what the page shows and the traffic rules in the worker's router */
  function clear() {
    const hadRules = !!st.data?.rulesSummary;
    clearView();
    deps.worker.postMessage({ type: 'simClear' });
    if (hadRules) deps.onRules();
  }

  // ---------------------------------------------------------------- map layers
  function before() { return map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol'); }
  /** heat grids sit on the ground: under roads and buildings, over land and lots */
  function firstRoadLayer() { return map.getLayersOrder().find((id) => (map.getLayer(id) as { source?: string } | undefined)?.source === 'roads'); }
  function removeLayers() {
    for (const id of [TRAFFIC, RASTER, COVER + '-line']) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [RASTER, COVER]) if (map.getSource(id)) map.removeSource(id);
    if (map.getSource('roads')) map.removeFeatureState({ source: 'roads' });
  }
  let drawQueued = false;
  function draw() {
    // the style can still be loading (first seconds, background tabs): draw once it's ready, like applyStyle
    if (!(map as unknown as { style?: { _loaded?: boolean } }).style?._loaded) {
      if (!drawQueued) { drawQueued = true; map.once('idle', () => { drawQueued = false; draw(); }); }
      return;
    }
    removeLayers();
    const d = st.data;
    if (!d || st.layer === 'none') { syncChip(); return; }
    if (st.layer === 'traffic') {
      if (!d.traffic) return;
      for (const [id, v] of st.traffic) map.setFeatureState({ source: 'roads', id }, { t: v });
      const tv = ['coalesce', ['feature-state', 't'], -1] as ExpressionSpecification;
      map.addLayer({
        id: TRAFFIC, type: 'line', source: 'roads', filter: ['>', ['coalesce', ['get', 'lanes'], 0], 0],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['interpolate', ['linear'], tv, ...TRAFFIC_COLORS.flat()] as ExpressionSpecification,
          'line-width': roadWidth([0.5, 0.8, 1.2, 1.6]),
          'line-opacity': ['case', ['<', tv, 0], 0, ['==', ['get', 'brunnel'], 'tunnel'], 0.45, 0.95] as ExpressionSpecification,
        },
      }, before());
    } else {
      const g = d.grids;
      if (!g) return;
      const imm = st.layer !== 'pollution';
      const half = imm ? IMM_HALF : NAT_HALF, res = imm ? 256 : 512;
      const vals: ArrayLike<number> = st.layer === 'landValue' ? g.landValue : st.layer === 'noise' ? g.noise : st.layer === 'crime' ? g.crime : g.pollution;
      // scale tops: land value and noise views reach full colour at 100 (ImmaterialResourceManager.UpdateTexture),
      // pollution is 0..255, crime is shown against the game's 70 "high" threshold
      const top = st.layer === 'pollution' ? 255 : st.layer === 'crime' ? 70 : 100;
      const ramp = RAMPS[st.layer].map(hexRgb);
      const small = document.createElement('canvas'); small.width = res; small.height = res;
      const c = small.getContext('2d')!; const img = c.createImageData(res, res);
      const zeroClear = st.layer !== 'landValue'; // 0 noise/pollution/crime = none: leave the map visible
      for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) {
        const v = vals[z * res + x], o = ((res - 1 - z) * res + x) * 4; // image row 0 = north (+z)
        if (zeroClear && v === 0) continue;
        const k = Math.min(1, Math.sqrt(v / top)), col = rampAt(ramp, k);
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 150 + Math.round(70 * k);
      }
      c.putImageData(img, 0, 0);
      const S = imm ? 4 : 2, cv = document.createElement('canvas'); cv.width = res * S; cv.height = res * S;
      const cc = cv.getContext('2d')!; cc.imageSmoothingEnabled = true; cc.imageSmoothingQuality = 'high'; cc.drawImage(small, 0, 0, cv.width, cv.height);
      const corners = [toLngLat(-half, half), toLngLat(half, half), toLngLat(half, -half), toLngLat(-half, -half)] as [[number, number], [number, number], [number, number], [number, number]];
      map.addSource(RASTER, { type: 'image', url: cv.toDataURL('image/png'), coordinates: corners });
      map.addLayer({ id: RASTER, type: 'raster', source: RASTER, paint: { 'raster-opacity': 0.85, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, firstRoadLayer() ?? before());
      if (imm) {
        // outline of the area the game keeps this grid for
        const ring = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]].map(([x, z]) => toLngLat(x, z));
        map.addSource(COVER, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } } });
        map.addLayer({ id: COVER + '-line', type: 'line', source: COVER, paint: { 'line-color': '#5f6368', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } }, before());
      }
    }
    syncChip();
  }
  function hexRgb(h: string): [number, number, number] { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function rampAt(r: [number, number, number][], k: number): [number, number, number] {
    const p = k * (r.length - 1), i = Math.min(r.length - 2, Math.floor(p)), f = p - i;
    return [0, 1, 2].map((j) => Math.round(r[i][j] + (r[i + 1][j] - r[i][j]) * f)) as [number, number, number];
  }
  function layerName(l: Layer) { return t(l === 'none' ? 'Off' : l === 'traffic' ? 'Traffic' : l === 'landValue' ? 'Land value' : l === 'noise' ? 'Noise' : l === 'pollution' ? 'Ground pollution' : 'Crime'); }
  function syncChip() {
    legendChip.hidden = st.open || !st.data || st.layer === 'none';
    if (!legendChip.hidden) legendChip.innerHTML = `${legendBar(st.layer, true)}<span>${esc(layerName(st.layer))}</span>`;
  }
  function legendBar(l: Layer, mini = false) {
    if (l === 'none') return '';
    const cols = l === 'traffic' ? TRAFFIC_COLORS.map(([, c]) => c) : RAMPS[l];
    return `<i class="sim-ramp${mini ? ' mini' : ''}" style="background:linear-gradient(90deg,${cols.join(',')})"></i>`;
  }
  function legend(l: Layer) {
    if (l === 'none') return '';
    const [lo, hi] = l === 'traffic' ? [t('Free-flowing'), t('Jammed')] : [l === 'landValue' ? t('Low') : t('None'), t('High')];
    const note = l === 'traffic' ? t('Matched roads only. The game\'s traffic view shows the same value.') : l === 'pollution' ? t('Whole map.') : t('The game records this only for the central 25 tiles.');
    return `<div class="sim-legend">${legendBar(l)}<div class="sim-legend-ends"><span>${esc(lo)}</span><span>${esc(hi)}</span></div><p class="sim-note">${esc(note)}</p></div>`;
  }

  // ---------------------------------------------------------------- panel
  const close = () => { st.open = false; el.hidden = true; sheet.hide(); syncChip(); };
  function open() {
    if (!deps.city()) return;
    deps.onOpen();
    st.open = true; el.hidden = false; render(); sheet.show('half'); syncChip();
  }
  const head = `<div class="m-head"><b>${t('Simulation data')}</b><button class="icon-btn" data-a="close" aria-label="${t('Close')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>`;
  function fmtDate(raw: string | null, time = false) {
    if (!raw) return '';
    const d = new Date(raw.replace(/(\.\d{3})\d+/, '$1'));
    return isNaN(+d) ? raw : d.toLocaleString(locale(), time ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
  }
  function intro() {
    return `<p class="sim-lede">${t('Enhance your map with real traffic, population, transit, and other data from your Cities: Skylines save.')}</p>
      <div class="tl-actions"><button class="pill primary" data-a="pick">${t('Choose a save (.crp)')}</button></div>
      <p class="sim-tip">${t('Tip: in the CSLMapView mod options, turn on “Auto export on saving game”. Every time you save, the mod writes a map export of the same moment, so the save and the export always match.')}</p>
      <p class="sim-note">${t('Saves are in the game\'s Saves folder:')}<br><code>~/Library/Application Support/Colossal Order/Cities_Skylines/Saves</code><br><code>%LOCALAPPDATA%\\Colossal Order\\Cities_Skylines\\Saves</code></p>
      <p class="sim-note">${t('Your files stay on this computer. Nothing is uploaded.')}</p>`;
  }
  function failure(f: SimFailure) {
    const v = f.v;
    const [title, body] =
      f.code === 'incompatible' ? (v?.reason === 'different-city' ? [t('This save is from a different city'), t('None of this map\'s roads or junctions appear in it. Open this save\'s own map export, or choose the save that belongs to this map.')]
        : v?.reason === 'empty' ? [t('This save couldn\'t be read'), t('This map has nothing to compare against.')]
        : [t('This save is too far apart in time'), t('It is the same city, but only {pct}% of the map\'s roads and buildings are unchanged in the save. Choose the save made at the same time as this export.', { pct: Math.floor(100 * Math.min(v?.share.segments ?? 0, v?.share.buildings ?? 0)) })])
      : f.code === 'not-crp' ? [t('This isn\'t a Cities: Skylines save'), t('Choose a .crp file from the game\'s Saves folder.')]
      : f.code === 'not-save' ? [t('This .crp file isn\'t a saved game'), t('It may be an asset, a map or a scenario. Choose a file from the Saves folder.')]
      : f.code === 'unsupported-version' ? [t('This save is from an untested game version'), t('Skyline Map reads saves from the current and the previous version of the game. This one uses save format {n}.', { n: String(f.save?.format ?? '?') })]
      : f.code === 'truncated' ? [t('This save file is incomplete'), t('It may not have finished copying or downloading. Try the original file.')]
      : f.code === 'damaged' ? [t('This save file is damaged'), t('Its contents don\'t match the checksum the game wrote into it. Try the original file, or save again in the game.')]
      : [t('This save couldn\'t be read'), t('It may be damaged, or a mod changed how the game stores this data.')];
    return `<div class="sim-status bad"><b>${esc(title)}</b><p>${esc(body)}</p>${f.save?.city ? `<p class="sim-note">${esc(t('Save: {city}', { city: f.save.city }))}${f.save.gameDate ? ' · ' + esc(t('In game {date}', { date: fmtDate(f.save.gameDate) })) : ''}</p>` : ''}</div>
      <div class="tl-actions"><button class="pill primary" data-a="pick">${t('Choose another save')}</button></div>
      <p class="sim-tip">${t('Tip: in the CSLMapView mod options, turn on “Auto export on saving game”. Every time you save, the mod writes a map export of the same moment, so the save and the export always match.')}</p>`;
  }
  function status(d: SimData) {
    const v = d.v;
    const near = v.verdict === 'near';
    return `<div class="sim-status ${near ? 'near' : 'ok'}"><b>${t(near ? 'Close match' : 'Matches this map')}</b>
      <p>${esc(near ? t('Some objects differ between the two files: they were built, removed or changed in between. Simulation values appear only where the two match exactly.') : t('Every road, junction and building on the map was found in the save, unchanged.'))}</p>
      ${near ? `<p class="sim-note">${esc(t('{roads} of {nroads} roads and {blds} of {nblds} buildings match.', { roads: num(v.segments.verified), nroads: num(v.segments.exported), blds: num(v.buildings.verified), nblds: num(v.buildings.exported) }))}</p>` : ''}
      <p class="sim-note">${[d.save.city ? esc(t('Save: {city}', { city: d.save.city })) : '', d.save.gameDate ? esc(t('In game {date}', { date: fmtDate(d.save.gameDate) })) : '', d.save.savedAt ? esc(t('Saved {date}', { date: fmtDate(d.save.savedAt, true) })) : ''].filter(Boolean).join(' · ')}</p></div>`;
  }
  function rulesInfo(d: SimData) {
    const r = d.rulesSummary;
    if (!r) return '';
    const parts = [
      r.oneway ? tn(r.oneway, '{n} one-way road', '{n} one-way roads') : '',
      r.speed ? tn(r.speed, '{n} road with a TM:PE speed limit', '{n} roads with TM:PE speed limits') : '',
      r.carBan ? tn(r.carBan, '{n} road closed to cars in a direction', '{n} roads closed to cars in a direction') : '',
      r.uturnBan ? tn(r.uturnBan, '{n} no-U-turn rule', '{n} no-U-turn rules') : '',
      r.track ? tn(r.track, '{n} track or road with a TM:PE limit for transit', '{n} tracks or roads with TM:PE limits for transit') : '',
    ].filter(Boolean);
    if (!parts.length) return '';
    return `<h4>${t('Used for directions')}</h4><p class="sim-note sim-rules">${esc(t('Directions, reach and closures now follow the traffic rules in your save: {list}.', { list: parts.join(', ') }))}${r.leftHand ? ' ' + esc(t('Left-hand traffic: one-way directions and per-direction rules aren\'t applied yet.')) : ''} ${esc(t('Traffic density is shown, never used as a speed.'))}</p>`;
  }
  function layerPicker(d: SimData) {
    const avail = (l: Layer) => l === 'none' || (l === 'traffic' ? !!d.traffic : !!d.grids);
    return `<h4>${t('Map layer')}</h4><div class="sim-layers" role="radiogroup">${LAYERS.filter(avail).map((l) => `<button role="radio" aria-checked="${st.layer === l}" data-layer="${l}">${esc(layerName(l))}</button>`).join('')}</div>${legend(st.layer)}`;
  }
  function cityStats(d: SimData) {
    const c = d.city;
    if (!c) return '';
    const edu = ['Uneducated', 'Educated', 'Well educated', 'Highly educated'];
    const tax = c.taxRates;
    const stat = (k: string, v: string, sub = '') => `<div><span>${esc(t(k))}</span><b>${esc(v)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
    return `<h4>${t('Whole city, from the save')}</h4>
      <div class="m-stats sim-stats">
        ${stat('Population', num(c.population))}${stat('Workers', num(c.workers))}${stat('Jobs', num(c.workplaces))}${stat('Unemployment', pct(c.unemploymentPct), t('as the game shows it'))}
        ${stat('Tourists', num(c.tourists), t('as the game shows it'))}${stat('Happiness', pct(c.happiness))}${stat('Crime rate', pct(c.crimeRatePct))}${stat('Average land value', '₡' + num(c.landValue))}${stat('Ground pollution', pct(c.groundPollutionPct))}
      </div>
      <div class="sim-bars">${t('Education')}${c.educationLevels.map((n, i) => `<div class="sim-bar"><span>${esc(t(edu[i]))}</span><i style="--w:${c.educationShares[i]}%"></i><b>${pct(c.educationShares[i])}</b></div>`).join('')}</div>
      <div class="sim-tax"><span>${t('Taxes')}</span>${[['Residential', tax.residentialLow, tax.residentialHigh], ['Commercial', tax.commercialLow, tax.commercialHigh]].map(([k, lo, hi]) => `<div><span>${esc(t(k as string))}</span><b>${lo}% <small>${t('low')}</small> · ${hi}% <small>${t('high')}</small></b></div>`).join('')}<div><span>${t('Industrial')}</span><b>${tax.industrial}%</b></div><div><span>${t('Office')}</span><b>${tax.office}%</b></div></div>`;
  }
  function ridership(d: SimData) {
    const c = deps.city();
    if (!d.lines?.length || !c) return '';
    const rows = d.lines.map((l) => ({ l, m: c.meta.lines.find((x) => x.id === l.id) })).filter((x) => x.m && x.m.type !== 'air').sort((a, b) => (b.l.residents + b.l.tourists) - (a.l.residents + a.l.tourists));
    if (!rows.length) return '';
    const max = Math.max(1, ...rows.map((r) => r.l.residents + r.l.tourists));
    return `<h4>${t('Transit ridership')}</h4><p class="sim-note">${t('Passengers per week, as the game\'s line panel shows them.')}</p>
      <div class="sim-lines">${rows.map(({ l, m }) => { const tot = l.residents + l.tourists; return `<button class="sim-line" data-line="${l.id}"><i class="dot" style="background:${m!.color}"></i><span class="nm">${esc(m!.name)}</span><span class="bar"><i style="width:${(tot / max) * 100}%;background:${m!.color}"></i></span><b>${num(tot)}</b></button>`; }).join('')}</div>`;
  }
  function render() {
    syncChip();
    if (!st.open) return;
    let body: string;
    if (st.busy) body = `<p class="sim-lede">${esc(t('Reading {file}…', { file: st.file }))}</p><p class="tl-msg">${esc(st.step ? t(st.step) + '…' : '')}</p><div class="sim-progress"><i></i></div>`;
    else if (st.fail) body = failure(st.fail);
    else if (!st.data) body = intro();
    else {
      const d = st.data;
      const un = d.unavailable.map((k) => t(k === 'buildings' ? 'building occupancy' : k === 'transit' ? 'transit ridership' : k === 'tmpe' ? 'traffic rules' : k === 'city' ? 'city statistics' : 'map layers'));
      body = status(d) + rulesInfo(d) + layerPicker(d) + cityStats(d) + ridership(d) +
        (un.length ? `<p class="sim-note">${esc(t('Some data couldn\'t be read from this save: {list}.', { list: un.join(', ') }))}</p>` : '') +
        `<div class="tl-actions sim-foot"><button class="pill" data-a="pick">${t('Choose another save')}</button><button class="pill" data-a="remove">${t('Remove simulation data')}</button></div>`;
    }
    el.innerHTML = `${head}<div class="sim-scroll">${body}</div>`;
    sheet.refresh();
  }
  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    const a = (tg.closest('[data-a]') as HTMLElement | null)?.dataset.a;
    if (a === 'close') return close();
    if (a === 'pick') return input.click();
    if (a === 'remove') { clear(); st.fail = null; st.layer = 'none'; render(); deps.toast(t('Simulation data removed')); return; }
    const l = (tg.closest('[data-layer]') as HTMLElement | null)?.dataset.layer as Layer | undefined;
    if (l) { st.layer = l; draw(); render(); return; }
    const line = (tg.closest('[data-line]') as HTMLElement | null)?.dataset.line;
    if (line) deps.selectLine(+line);
  });

  // ---------------------------------------------------------------- info panel rows
  const row = (k: string, v: string) => `<div class="p-row"><span>${esc(t(k))}</span><span>${esc(v)}</span></div>`;
  const section = (rows: string) => rows ? `<div class="p-sim"><div class="p-sim-h">${t('From your save')}${st.data?.save.gameDate ? ` · ${esc(t('In game {date}', { date: fmtDate(st.data.save.gameDate) }))}` : ''}</div>${rows}</div>` : '';
  const unmatched = () => `<div class="p-sim muted"><div class="p-sim-h">${t('From your save')}</div><p>${t('This object doesn\'t match the save, so no simulation data is shown for it.')}</p></div>`;

  function buildingHtml(id: number) {
    const d = st.data;
    if (!d?.buildings) return '';
    const i = st.bld.get(id);
    if (i === undefined) return unmatched();
    const b = d.buildings, has = (a: Int32Array) => a[i] >= 0;
    let rows = '';
    if (has(b.residents)) rows += row('Residents', num(b.residents[i]));
    if (has(b.homes) && b.homes[i] > 0) rows += row('Households', `${num(b.households[i])} / ${num(b.homes[i])}`);
    if (has(b.workers)) rows += row('Workers now', num(b.workers[i]));
    if (has(b.students)) rows += row('Students', num(b.students[i]));
    if (has(b.visitors)) rows += row('Visitors now', num(b.visitors[i]));
    if (has(b.residents) || has(b.workers)) rows += row('Happiness', pct(b.happiness[i]));
    return section(rows);
  }
  function roadHtml(id: number) {
    const d = st.data;
    if (!d) return '';
    const tv = st.traffic.get(id);
    if (tv === undefined) return unmatched();
    let rows = row('Traffic', pct(tv));
    const tm = st.tm.get(id);
    if (tm) {
      if (tm.kmh.length) rows += row('Speed limit (TM:PE)', tm.kmh.map((k) => (k >= 1000 ? t('No limit') : `${k} km/h`)).join(' · '));
      else if (tm.typeDefault !== null) rows += row('Default speed for this road type (TM:PE)', `${tm.typeDefault} km/h`);
      if (tm.parking && !(tm.parking[0] && tm.parking[1])) rows += row('Parking', tm.parking[0] || tm.parking[1] ? t('One side only') : t('Not allowed'));
    }
    return section(rows);
  }
  function lineHtml(id: number) {
    const d = st.data;
    if (!d?.lines) return '';
    const l = st.lines.get(id);
    if (!l) return unmatched();
    let rows = row('Passengers per week', num(l.residents + l.tourists)) + `<div class="p-row sub"><span></span><span>${esc(t('{res} residents · {tour} tourists', { res: num(l.residents), tour: num(l.tourists) }))}</span></div>`;
    rows += row('Last full week', num(l.lastResidents + l.lastTourists));
    if (l.tripsSaved !== null) rows += row('Car trips saved', pct(l.tripsSaved));
    return section(rows);
  }

  return {
    open, close, onMessage, buildingHtml, roadHtml, lineHtml,
    isOpen: () => st.open,
    /** the worker's router follows this save's traffic rules */
    hasRules: () => !!st.data?.rulesSummary,
    loaded: () => !!st.data,
    /** a new map was opened: simulation data belonged to the old one */
    reset() { clear(); st.fail = null; st.busy = false; st.id++; st.layer = 'none'; close(); },
    /** re-draw overlays after the style changed */
    refresh() { if (st.data && st.layer !== 'none' && !map.getLayer(st.layer === 'traffic' ? TRAFFIC : RASTER)) draw(); },
    pick: () => { open(); input.click(); },
  };
}
