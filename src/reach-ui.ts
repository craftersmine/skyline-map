// "How far can I get?": pick a point and a way of travelling, and the map shades everywhere reachable within a
// time limit in four bands. Times come from the worker (same costs as Directions); see reach.ts.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap } from 'maplibre-gl';
import { HALF, toLngLat, fromLngLat, type XY } from './geo';
import { t, fmtFixed } from './i18n';
import { fmtArea } from './units';
import { MODES } from './directions';
import type { ReachGrid } from './reach';
import type { Mode } from './router';
import type { DistrictField } from './district-glow';

type LL = [number, number];
const SRC = 'reach', LAYER = 'reach';
const LIMITS = [15, 30, 45, 60];
// light to deep: the nearest band is the strongest (YlGnBu, readable on both map styles)
const BANDS = ['#253494', '#2c7fb8', '#41b6c4', '#a1dab4'];

export function createReach(map: MLMap, deps: { worker: Worker; land: () => DistrictField | null; night: () => boolean; onOpen: () => void; traffic: () => boolean }) {
  const st = { active: false, at: null as LL | null, mode: 'transit' as Mode, limit: 30, id: 0, grid: null as ReachGrid | null, busy: false };
  try { const s = JSON.parse(localStorage.getItem('atlas:reach') ?? 'null'); if (s) { st.mode = s.mode ?? st.mode; st.limit = s.limit ?? st.limit; } } catch { /* ignore */ }

  const el = document.createElement('div');
  el.id = 'reach'; el.className = 'card'; el.hidden = true;
  document.body.appendChild(el);
  const pin = document.createElement('div'); pin.className = 'reach-pin';
  const marker = new maplibregl.Marker({ element: pin, draggable: true, anchor: 'bottom' });
  marker.on('dragend', () => { const p = marker.getLngLat(); setPoint([p.lng, p.lat]); });


  function landAt(f: DistrictField | null, x: number, z: number) {
    if (!f) return true;
    const i = Math.floor((x + HALF) / f.cell), j = Math.floor((z + HALF) / f.cell);
    return i < 0 || j < 0 || i >= f.n || j >= f.n ? false : !!f.land[j * f.n + i];
  }

  function draw() {
    if (!map.isStyleLoaded()) { map.once('idle', draw); return; }
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SRC)) map.removeSource(SRC);
    const g = st.grid;
    if (!st.active || !g) return;
    const max = st.limit * 60, f = deps.land();
    const rgb = BANDS.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
    const small = document.createElement('canvas'); small.width = g.w; small.height = g.h;
    const sc = small.getContext('2d')!, img = sc.createImageData(g.w, g.h);
    const alpha = deps.night() ? 0.42 : 0.5;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const v = g.t[j * g.w + i];
      if (!(v <= max)) continue;
      const x = (g.x0 + i + 0.5) * g.cell - HALF, z = (g.z0 + j + 0.5) * g.cell - HALF;
      if (!landAt(f, x, z)) continue;
      const b = Math.min(3, Math.floor((v / max) * 4)), o = ((g.h - 1 - j) * g.w + i) * 4; // image row 0 = north
      img.data[o] = rgb[b][0]; img.data[o + 1] = rgb[b][1]; img.data[o + 2] = rgb[b][2]; img.data[o + 3] = Math.round(255 * alpha);
    }
    sc.putImageData(img, 0, 0);
    // smooth upscale so band edges read as soft contours, not 30 m squares
    const S = 4, cv = document.createElement('canvas'); cv.width = g.w * S; cv.height = g.h * S;
    const c = cv.getContext('2d')!; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(small, 0, 0, cv.width, cv.height);
    const X = (i: number) => i * g.cell - HALF, Z = (j: number) => j * g.cell - HALF;
    const corners: [XY, XY, XY, XY] = [toLngLat(X(g.x0), Z(g.z0 + g.h)), toLngLat(X(g.x0 + g.w), Z(g.z0 + g.h)), toLngLat(X(g.x0 + g.w), Z(g.z0)), toLngLat(X(g.x0), Z(g.z0))];
    map.addSource(SRC, { type: 'image', url: cv.toDataURL('image/png'), coordinates: corners });
    map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, map.getLayer('water') ? 'water' : undefined);
  }

  /** Reachable land area per band, m². */
  function areas() {
    const g = st.grid, out = [0, 0, 0, 0];
    if (!g) return out;
    const max = st.limit * 60, f = deps.land(), a = g.cell * g.cell;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const v = g.t[j * g.w + i];
      if (!(v <= max) || !landAt(f, (g.x0 + i + 0.5) * g.cell - HALF, (g.z0 + j + 0.5) * g.cell - HALF)) continue;
      out[Math.min(3, Math.floor((v / max) * 4))] += a;
    }
    return out;
  }

  function render() {
    void ['How far can I get?', 'Close', 'Minutes', 'Reachable area', 'Click the map or drag the pin to move the start.', 'Working out travel times…', 'Nothing reachable from here by this mode.', 'Estimated from the road and transit network; transit includes average waits.', 'Driving times include the traffic from your save, as an estimate.'];
    const ar = areas(), total = ar.reduce((s, x) => s + x, 0), q = st.limit / 4;
    el.innerHTML = `
      <div class="m-head"><b>${t('How far can I get?')}</b>
        <button class="icon-btn r-close" aria-label="${t('Close')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>
      <div class="r-modes" role="radiogroup">${MODES.map((m) => `<button role="radio" aria-checked="${m.id === st.mode}" data-mode="${m.id}" title="${t(m.label)}"><svg viewBox="0 0 24 24">${m.icon}</svg><span>${t(m.label)}</span></button>`).join('')}</div>
      <div class="r-limits" role="radiogroup" aria-label="${t('Minutes')}">${LIMITS.map((n) => `<button role="radio" aria-checked="${n === st.limit}" data-limit="${n}">${t('{n} min', { n })}</button>`).join('')}</div>
      <div class="r-legend">${BANDS.map((c, i) => `<span><i style="background:${c}"></i>${Math.round(i * q)}–${Math.round((i + 1) * q)}</span>`).join('')}<em>${t('{n} min', { n: '' }).trim()}</em></div>
      <p class="r-stat">${st.busy ? t('Working out travel times…') : st.grid && total ? `${t('Reachable area')}: <b>${fmtArea(total)}</b>` : st.at ? t('Nothing reachable from here by this mode.') : ''}</p>
      <p class="r-hint">${t('Click the map or drag the pin to move the start.')}</p>
      <p class="r-note">${t('Estimated from the road and transit network; transit includes average waits.')}${st.mode === 'drive' && deps.traffic() ? ' ' + t('Driving times include the traffic from your save, as an estimate.') : ''}</p>`;
  }

  function request() {
    if (!st.active || !st.at) return;
    st.busy = true; render();
    const id = ++st.id;
    deps.worker.postMessage({ type: 'reach', id, from: fromLngLat(st.at[0], st.at[1]), mode: st.mode, max: 60 * 60 });
  }
  function setPoint(ll: LL) { st.at = ll; marker.setLngLat(ll).addTo(map); request(); }
  const save = () => { try { localStorage.setItem('atlas:reach', JSON.stringify({ mode: st.mode, limit: st.limit })); } catch { /* ignore */ } };

  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.closest('.r-close')) return close();
    const m = tg.closest<HTMLElement>('[data-mode]')?.dataset.mode as Mode | undefined;
    if (m && m !== st.mode) { st.mode = m; save(); return request(); }
    const l = tg.closest<HTMLElement>('[data-limit]')?.dataset.limit;
    if (l) { st.limit = +l; save(); render(); draw(); }
  });

  function open(ll: LL) {
    deps.onOpen();
    st.active = true; el.hidden = false;
    setPoint(ll);
  }
  function close() {
    st.active = false; st.grid = null; el.hidden = true; marker.remove(); draw();
  }

  return {
    open, close,
    isActive: () => st.active,
    click(ll: LL) { setPoint(ll); },
    /** worker result; ignores answers to superseded requests */
    onResult(m: { id: number; grid: ReachGrid | null }) {
      if (m.id !== st.id || !st.active) return;
      st.busy = false; st.grid = m.grid; render(); draw();
    },
    /** redraw after a style change (layers are rebuilt) */
    refresh() { if (st.active) { render(); draw(); } },
  };
}
