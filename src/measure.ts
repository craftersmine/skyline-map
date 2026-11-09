// Ruler tool, after Google Earth's: click to add points, drag them, click the
// first point to close a shape (area + perimeter). Distances are exact: the map
// projection keeps one game metre equal to one metre of map scale.
import type { Map as MLMap, GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import { fromLngLat, type XY } from './geo';
import { elevationAt } from './dem';
import { t } from './i18n';

type LL = [number, number];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function createMeasure(map: MLMap, hooks: { onOpen: () => void; onClose: () => void }) {
  const st = { active: false, pts: [] as LL[], closed: false, imperial: false, drag: -1, hover: null as LL | null };
  try { st.imperial = localStorage.getItem('atlas:units') === 'imperial'; } catch { /* storage blocked */ }

  const el = document.createElement('div');
  el.id = 'measure'; el.className = 'card'; el.hidden = true;
  document.body.appendChild(el);

  const xy = (p: LL): XY => fromLngLat(p[0], p[1]);
  const segLen = (a: LL, b: LL) => { const p = xy(a), q = xy(b); return Math.hypot(p[0] - q[0], p[1] - q[1]); };
  const ring = () => (st.closed ? [...st.pts, st.pts[0]] : st.pts);
  const total = () => { const r = ring(); let d = 0; for (let i = 1; i < r.length; i++) d += segLen(r[i - 1], r[i]); return d; };
  const area = () => { if (!st.closed || st.pts.length < 3) return 0; const p = st.pts.map(xy); let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]); return Math.abs(a / 2); };

  const fmtLen = (m: number) => st.imperial
    ? (m < 1609.344 * 0.1 ? `${Math.round(m * 3.28084).toLocaleString()} ft` : `${(m / 1609.344).toFixed(m < 16093 ? 2 : 1)} mi`)
    : (m < 1000 ? `${m < 100 ? m.toFixed(1) : Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);
  const fmtArea = (a: number) => st.imperial
    ? (a < 4046.86 * 0.5 ? `${Math.round(a * 10.7639).toLocaleString()} ft²` : a < 2589988 ? t('{n} acres', { n: (a / 4046.86).toFixed(2) }) : `${(a / 2589988).toFixed(2)} mi²`)
    : (a < 10000 ? `${Math.round(a).toLocaleString()} m²` : a < 1e6 ? `${(a / 10000).toFixed(2)} ha` : `${(a / 1e6).toFixed(2)} km²`);
  const fmtH = (m: number) => (st.imperial ? `${Math.round(m * 3.28084).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`);

  /** Elevation along the path, sampled every ~10 m. */
  function profile() {
    const r = ring();
    if (r.length < 2) return null;
    const out: { d: number; h: number }[] = [];
    let acc = 0;
    for (let i = 1; i < r.length; i++) {
      const a = xy(r[i - 1]), b = xy(r[i]), L = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const n = Math.max(1, Math.ceil(L / 10));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n, h = elevationAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (h === null) return null;
        out.push({ d: acc + L * t, h });
      }
      acc += L;
    }
    let up = 0, down = 0;
    for (let i = 1; i < out.length; i++) { const dh = out[i].h - out[i - 1].h; if (dh > 0) up += dh; else down -= dh; }
    return { pts: out, up, down, min: Math.min(...out.map((p) => p.h)), max: Math.max(...out.map((p) => p.h)) };
  }

  function chart(p: NonNullable<ReturnType<typeof profile>>) {
    const W = 300, H = 70, D = p.pts[p.pts.length - 1].d || 1, span = Math.max(5, p.max - p.min);
    const X = (d: number) => (d / D) * W, Y = (h: number) => H - 4 - ((h - p.min) / span) * (H - 10);
    const line = p.pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.d).toFixed(1)},${Y(q.h).toFixed(1)}`).join('');
    return `<svg class="m-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${t('Elevation profile')}">
      <path d="${line}L${W},${H}L0,${H}Z" class="m-area"/><path d="${line}" class="m-line"/></svg>
      <div class="m-axis"><span>0</span><span>${fmtLen(D)}</span></div>`;
  }

  function render() {
    const src = map.getSource('measure') as GeoJSONSource | undefined;
    const r = ring();
    const feats: any[] = [];
    if (st.closed && st.pts.length >= 3) feats.push({ type: 'Feature', properties: { kind: 'area' }, geometry: { type: 'Polygon', coordinates: [r] } });
    if (r.length >= 2) feats.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: r } });
    // rubber band from the last point to the cursor while drawing
    if (!st.closed && st.hover && st.pts.length && st.drag < 0) feats.push({ type: 'Feature', properties: { kind: 'preview' }, geometry: { type: 'LineString', coordinates: [st.pts[st.pts.length - 1], st.hover] } });
    // leg lengths at segment midpoints
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i];
      feats.push({ type: 'Feature', properties: { kind: 'label', text: fmtLen(segLen(a, b)) }, geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] } });
    }
    st.pts.forEach((p, i) => feats.push({ type: 'Feature', properties: { kind: 'vertex', i, first: i === 0 ? 1 : 0 }, geometry: { type: 'Point', coordinates: p } }));
    src?.setData({ type: 'FeatureCollection', features: feats });

    if (!st.active) { el.hidden = true; return; }
    const prof = st.pts.length >= 2 ? profile() : null;
    // i18n-keys
    void ['Click on the map to add a point', 'Drag points to adjust', 'Click to add points', 'Click to add points · click the first point to close'];
    // end i18n-keys
    const hint = t(!st.pts.length ? 'Click on the map to add a point' : st.closed ? 'Drag points to adjust' : st.pts.length < 3 ? 'Click to add points' : 'Click to add points · click the first point to close');
    el.innerHTML = `
      <div class="m-head"><b>${t('Measure')}</b>
        <div class="m-units" role="group" aria-label="${t('Units')}"><button data-u="m" class="${st.imperial ? '' : 'on'}">${t('Metric')}</button><button data-u="i" class="${st.imperial ? 'on' : ''}">${t('Imperial')}</button></div>
        <button class="icon-btn m-close" aria-label="${t('Close measure')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>
      <div class="m-stats">
        <div><span>${st.closed ? t('Perimeter') : t('Total distance')}</span><b>${fmtLen(total())}</b></div>
        ${st.closed ? `<div><span>${t('Area')}</span><b>${fmtArea(area())}</b></div>` : ''}
        ${prof ? `<div><span>${t('Elevation {min}–{max}', { min: fmtH(prof.min), max: fmtH(prof.max) })}</span><b class="m-small">↑ ${fmtH(prof.up)} · ↓ ${fmtH(prof.down)}</b></div>` : ''}
      </div>
      ${prof && !st.closed ? chart(prof) : ''}
      <div class="m-foot"><span class="muted small">${esc(hint)}</span>
        <span><button class="pill" data-a="undo" ${st.pts.length ? '' : 'disabled'}>${t('Undo')}</button> <button class="pill" data-a="clear" ${st.pts.length ? '' : 'disabled'}>${t('Clear')}</button></span></div>`;
    el.hidden = false;
  }

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.m-close')) return close();
    const u = (t.closest('[data-u]') as HTMLElement | null)?.dataset.u;
    if (u) { st.imperial = u === 'i'; try { localStorage.setItem('atlas:units', st.imperial ? 'imperial' : 'metric'); } catch { /* ignore */ } return render(); }
    const a = (t.closest('[data-a]') as HTMLElement | null)?.dataset.a;
    if (a === 'undo') undo();
    if (a === 'clear') { st.pts = []; st.closed = false; render(); }
  });

  function undo() { if (st.closed) st.closed = false; else st.pts.pop(); render(); }

  const vertexAt = (e: MapMouseEvent) => {
    const f = map.queryRenderedFeatures([[e.point.x - 7, e.point.y - 7], [e.point.x + 7, e.point.y + 7]], { layers: ['measure-vertex'] })[0];
    return f ? (f.properties as any).i as number : -1;
  };
  function click(e: MapMouseEvent) {
    if (st.closed) return;
    const v = vertexAt(e);
    if (v === 0 && st.pts.length >= 3) { st.closed = true; st.hover = null; return render(); }
    if (v >= 0) return;
    st.pts.push([e.lngLat.lng, e.lngLat.lat]);
    render();
  }
  const onDown = (e: MapMouseEvent) => {
    if (!st.active) return;
    const v = vertexAt(e);
    if (v < 0) return;
    e.preventDefault();
    st.drag = v; map.getCanvas().style.cursor = 'grabbing';
  };
  const onMove = (e: MapMouseEvent) => {
    if (!st.active) return;
    if (st.drag >= 0) { st.pts[st.drag] = [e.lngLat.lng, e.lngLat.lat]; render(); return; }
    st.hover = [e.lngLat.lng, e.lngLat.lat];
    map.getCanvas().style.cursor = vertexAt(e) >= 0 ? (vertexAt(e) === 0 && !st.closed && st.pts.length >= 3 ? 'pointer' : 'grab') : 'crosshair';
    if (!st.closed && st.pts.length) render();
  };
  const onUp = () => { if (st.drag >= 0) { st.drag = -1; map.getCanvas().style.cursor = 'crosshair'; render(); } };
  map.on('mousedown', onDown); map.on('mousemove', onMove); map.on('mouseup', onUp);
  window.addEventListener('keydown', (e) => {
    if (!st.active || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Escape') close();
    if (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undo(); }
  });

  function open(start?: LL) {
    st.active = true; st.pts = start ? [start] : []; st.closed = false; st.hover = null;
    map.getCanvas().style.cursor = 'crosshair';
    hooks.onOpen(); render();
  }
  function close() {
    st.active = false; st.pts = []; st.closed = false; st.hover = null;
    map.getCanvas().style.cursor = '';
    render(); hooks.onClose();
  }
  return { open, close, click, isActive: () => st.active, toggle: () => (st.active ? close() : open()), refresh: () => st.active && render() };
}
