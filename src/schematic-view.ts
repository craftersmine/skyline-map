// The schematic transit map screen: pan/zoom, mode filters, line legend,
// station and line selection, and journeys planned on (or sent to) the diagram.
import type { SchemLayout, SLine, SStation, Pt } from './schematic';
import { renderSchematic, CELL, linePath, lineWidth, textOn } from './schematic-render';
import type { Route } from './router';
import type { ContextStore } from './context-ui';
import { iconDataUrl } from './icons';
import { toLngLat } from './geo';
import { bottomSheet, isPhone } from './sheet';
import { t, tn, applyStatic } from './i18n';
import { fmtTime, fmtDist } from './directions';

type LL = [number, number];
interface Place { label: string; ll: LL }
export interface SchemDeps {
  worker: Worker; pricing: ContextStore;
  cityName: () => string;
  showStation: (p: Place) => void;
  showLine: (id: number) => void;
  directions: (from: Place, to: Place) => void;
  onOpen: () => void; onClose: () => void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const svgI = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
  back: 'M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z',
  close: 'M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z', minus: 'M19 13H5v-2h14z',
  fit: 'M5 15H3v4a2 2 0 0 0 2 2h4v-2H5v-4zM5 5h4V3H5a2 2 0 0 0-2 2v4h2V5zm14-2h-4v2h4v4h2V5a2 2 0 0 0-2-2zm0 16h-4v2h4a2 2 0 0 0 2-2v-4h-2v4z',
  list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
  dir: 'M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z',
  pin: 'M12 2a7 7 0 0 0-7 7c0 5.3 7 13 7 13s7-7.7 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z',
};
// i18n-keys
const MODE_NAMES: Record<string, string> = { train: 'Train', metro: 'Metro', monorail: 'Monorail', tram: 'Tram', ferry: 'Ferry', cablecar: 'Cable car', bus: 'Bus' };
// end i18n-keys
const MODE_ORDER = ['train', 'metro', 'monorail', 'tram', 'ferry', 'cablecar', 'bus'];
const DEFAULT_MODES = ['train', 'metro', 'monorail', 'tram', 'ferry', 'cablecar'];

export function createSchematic(d: SchemDeps) {
  const el = document.createElement('div');
  el.id = 'schem'; el.hidden = true;
  el.innerHTML = `
    <header class="sm-head">
      <button class="icon-btn" data-close aria-label="Close" data-i18n-aria="Close">${svgI(ICON.back)}</button>
      <div class="sm-title"><b data-i18n="Transit map">Transit map</b><span class="sm-city"></span></div>
      <div class="sm-modes" role="group" aria-label="Transport modes" data-i18n-aria="Transport modes"></div>
      <button class="icon-btn sm-legend-btn" data-legend aria-label="Lines" data-i18n-aria="Lines" title="Lines" data-i18n-title="Lines">${svgI(ICON.list)}</button>
    </header>
    <div class="sm-view"><div class="sm-canvas"></div><div class="sm-empty" hidden></div><div class="sm-busy" hidden><span></span></div></div>
    <div class="sm-zoom"><button class="ctl" data-zoom="1" aria-label="Zoom in" data-i18n-aria="Zoom in">${svgI(ICON.plus)}</button><button class="ctl" data-zoom="-1" aria-label="Zoom out" data-i18n-aria="Zoom out">${svgI(ICON.minus)}</button><button class="ctl" data-fit aria-label="Show whole map" data-i18n-aria="Show whole map">${svgI(ICON.fit)}</button></div>
    <aside class="sm-legend card"></aside>
    <aside class="sm-card card" hidden><button class="icon-btn sm-card-close" data-card-close aria-label="Close" data-i18n-aria="Close">${svgI(ICON.close)}</button><div class="sm-card-body"></div></aside>`;
  document.body.appendChild(el);
  applyStatic(el);
  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const view = $<HTMLElement>('.sm-view'), canvas = $<HTMLElement>('.sm-canvas'), card = $<HTMLElement>('.sm-card'), cardBody = $<HTMLElement>('.sm-card-body'), legend = $<HTMLElement>('.sm-legend');
  const sheet = bottomSheet(card, { scroll: card, snaps: ['peek', 'half', 'full'], peek: () => { const h = card.querySelector<HTMLElement>('.smc-head'); return h ? h.offsetTop + h.offsetHeight + 70 : 160; }, onDismiss: () => clearSelection() });

  let savedModes: string[] | null = null;
  try { savedModes = JSON.parse(localStorage.getItem('atlas:schem-modes') ?? 'null'); } catch { /* storage blocked */ }
  const st = {
    layout: null as SchemLayout | null, available: [] as string[], modes: savedModes ?? DEFAULT_MODES,
    req: 0, routeReq: 2_000_000, view: { x: 0, y: 0, k: 1 }, svgW: 1, svgH: 1, vb: [0, 0, 1, 1] as number[],
    sel: null as null | { kind: 'station'; id: number } | { kind: 'line'; id: number } | { kind: 'route' },
    from: null as number | null, to: null as number | null, route: null as Route | null, pendingRoute: null as Route | null, legendOpen: !isPhone(),
  };
  const stations = () => new Map((st.layout?.stations ?? []).map((s) => [s.id, s]));
  const lineById = () => new Map((st.layout?.lines ?? []).map((l) => [l.id, l]));
  const placeOf = (s: SStation): Place => ({ label: s.name || t('Unnamed stop'), ll: toLngLat(s.gx, s.gz) as LL });

  // ---------------------------------------------------------------- data
  function request() {
    $<HTMLElement>('.sm-busy').hidden = false;
    d.worker.postMessage({ type: 'schematic', id: ++st.req, modes: st.modes });
  }
  function onMessage(m: { id: number; available: string[]; modes: string[]; layout: SchemLayout | null }) {
    if (m.id !== st.req) return;
    $<HTMLElement>('.sm-busy').hidden = true;
    st.available = m.available;
    // nothing but buses in this city: show the buses rather than an empty map
    if (!m.layout && m.available.length && !st.modes.some((x) => m.available.includes(x) && x !== 'bus') && !st.modes.includes('bus') && m.available.includes('bus')) { st.modes = [...st.modes, 'bus']; request(); return; }
    st.layout = m.layout;
    draw(true);
  }

  // ---------------------------------------------------------------- drawing
  function draw(fit: boolean) {
    renderModes();
    const L = st.layout;
    const empty = $<HTMLElement>('.sm-empty');
    if (!L || !L.lines.length) {
      canvas.innerHTML = ''; legend.innerHTML = '';
      empty.hidden = false;
      empty.textContent = st.available.length ? t('No lines for the selected modes.') : t('This city has no transit lines.');
      return;
    }
    empty.hidden = true;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    canvas.innerHTML = renderSchematic(L, { theme });
    const svg = canvas.querySelector('svg')!;
    st.vb = svg.getAttribute('viewBox')!.split(' ').map(Number);
    st.svgW = st.vb[2]; st.svgH = st.vb[3];
    // route overlay above the lines but under the station markers; pins and halo under the names
    svg.querySelector('.sm-links')!.insertAdjacentHTML('beforebegin', '<g class="sm-overlay"></g>');
    svg.querySelector('.sm-labels')!.insertAdjacentHTML('beforebegin', '<g class="sm-pins"></g>');
    renderLegend();
    if (fit) fitTo();
    applySelection();
  }
  function renderModes() {
    $<HTMLElement>('.sm-modes').innerHTML = MODE_ORDER.filter((m) => st.available.includes(m)).map((m) => `<button class="chip${st.modes.includes(m) ? ' on' : ''}" data-mode="${m}" aria-pressed="${st.modes.includes(m)}"><img src="${iconDataUrl(m)}" alt="">${esc(t(MODE_NAMES[m]))}</button>`).join('');
  }
  function renderLegend() {
    const L = st.layout!;
    const groups = MODE_ORDER.filter((m) => L.lines.some((l) => l.mode === m));
    legend.innerHTML = `<div class="sml-head"><b>${t('Lines')}</b><button class="icon-btn" data-legend aria-label="${t('Close')}">${svgI(ICON.close)}</button></div>` + groups.map((m) => `<div class="sml-group"><div class="sml-mode">${esc(t(MODE_NAMES[m]))}</div>${L.lines.filter((l) => l.mode === m).map((l) => `<button class="sml-line" data-line="${l.id}"><span class="sml-sw${l.mode === 'ferry' ? ' dash' : ''}" style="--c:${l.color}"></span><span>${esc(l.name)}</span></button>`).join('')}</div>`).join('');
    legend.hidden = !st.legendOpen;
  }

  // ---------------------------------------------------------------- pan / zoom
  const applyView = () => { canvas.style.transform = `translate(${st.view.x}px, ${st.view.y}px) scale(${st.view.k})`; };
  function fitTo(box?: [number, number, number, number]) {
    const r = view.getBoundingClientRect();
    const padTop = 16, padBottom = isPhone() && !card.hidden ? r.height * 0.42 : 24, padLeft = !isPhone() && st.legendOpen && !legend.hidden ? 280 : 16, padRight = isPhone() ? 16 : !card.hidden ? 380 : 70;
    const [bx, by, bw, bh] = box ?? [st.vb[0], st.vb[1], st.svgW, st.svgH];
    let k = Math.min((r.width - padLeft - padRight) / bw, (r.height - padTop - padBottom) / bh, box ? 1.6 : 1.2);
    // a phone opens at a zoom where names can be read (pan for the rest) rather than a postage stamp
    if (isPhone() && !box) k = Math.max(k, Math.min(0.5, (r.height - padTop - padBottom) / bh));
    st.view.k = Math.max(0.05, k);
    // canvas px = (svg units - viewBox origin), since the svg is drawn at its natural size
    st.view.x = padLeft + (r.width - padLeft - padRight - bw * st.view.k) / 2 - (bx - st.vb[0]) * st.view.k;
    st.view.y = padTop + (r.height - padTop - padBottom - bh * st.view.k) / 2 - (by - st.vb[1]) * st.view.k;
    canvas.style.transition = 'transform .35s ease'; applyView();
    setTimeout(() => (canvas.style.transition = ''), 360);
  }
  function zoomAt(cx: number, cy: number, f: number) {
    const k = Math.min(4, Math.max(0.05, st.view.k * f)), r = k / st.view.k;
    st.view.x = cx - (cx - st.view.x) * r; st.view.y = cy - (cy - st.view.y) * r; st.view.k = k;
    applyView();
  }
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = 0, pinch: { d: number; k: number } | null = null, lastTap = 0;
  view.addEventListener('pointerdown', (e) => {
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0;
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: st.view.k }; }
  });
  view.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()], dd = Math.hypot(a.x - b.x, a.y - b.y), r = view.getBoundingClientRect();
      zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, (pinch.k * dd) / pinch.d / st.view.k);
      moved += 10;
    } else if (pointers.size === 1) { st.view.x += dx; st.view.y += dy; moved += Math.abs(dx) + Math.abs(dy); applyView(); }
  });
  const up = (e: PointerEvent) => {
    const was = pointers.has(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!was || moved > 6 || pointers.size) return;
    // a tap: double tap zooms in, a single tap selects
    const r = view.getBoundingClientRect();
    if (e.timeStamp - lastTap < 300) { zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8); lastTap = 0; return; }
    lastTap = e.timeStamp;
    tap(e.clientX, e.clientY);
  };
  view.addEventListener('pointerup', up);
  view.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; });
  view.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6 && e.deltaMode === 0 && Math.abs(e.deltaX) > 2) { st.view.x -= e.deltaX; st.view.y -= e.deltaY; applyView(); return; }
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022)));
  }, { passive: false });

  // ---------------------------------------------------------------- picking
  function tap(x: number, y: number) {
    // pick within a finger's reach: stations first, then lines
    const hit = (sel: string) => { for (const r of [0, 8, 16]) for (const [ox, oy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) { const e = document.elementFromPoint(x + ox, y + oy)?.closest(sel) as HTMLElement | null; if (e && el.contains(e)) return e; if (!r) break; } return null; };
    const s = hit('[data-station]');
    if (s) return selectStation(+s.dataset.station!);
    const l = hit('.sm-line[data-line], .sm-badge[data-line]');
    if (l) return selectLine(+l.dataset.line!);
    if (st.sel) clearSelection();
  }

  // ---------------------------------------------------------------- selection
  function applySelection() {
    const svg = canvas.querySelector('svg');
    if (!svg) return;
    const overlay = svg.querySelector('.sm-overlay')!, pins = svg.querySelector('.sm-pins')!;
    overlay.innerHTML = ''; pins.innerHTML = '';
    svg.querySelectorAll('.on').forEach((e) => e.classList.remove('on'));
    svg.classList.toggle('focus', !!st.sel && st.sel.kind !== 'station');
    const S = stations();
    if (st.sel?.kind === 'line') {
      const l = lineById().get(st.sel.id);
      if (l) {
        svg.querySelectorAll(`[data-line="${l.id}"]`).forEach((e) => e.classList.add('on'));
        for (const sid of new Set(l.route)) svg.querySelectorAll(`[data-station="${sid}"]`).forEach((e) => e.classList.add('on'));
      }
    }
    if (st.sel?.kind === 'route' && st.route) drawRoute(overlay);
    if (st.sel?.kind === 'station') {
      const s = S.get(st.sel.id);
      if (s) pins.insertAdjacentHTML('beforeend', `<circle class="sm-halo" cx="${s.x * CELL}" cy="${s.y * CELL}" r="${haloR(s)}"/>`);
    }
    // journey ends chosen on the diagram
    for (const [id, cls] of [[st.from, 'a'], [st.to, 'b']] as const) {
      const s = id !== null ? S.get(id) : undefined;
      if (s) pins.insertAdjacentHTML('beforeend', `<g class="sm-pin ${cls}" transform="translate(${s.x * CELL} ${s.y * CELL - haloR(s)})"><path d="M0 0c-9-11-13-16-13-22a13 13 0 0 1 26 0c0 6-4 11-13 22z"/><circle cy="-22" r="5"/></g>`);
    }
  }
  const haloR = (s: SStation) => (s.marker.kind === 'ring' ? s.marker.r * CELL + 14 : s.marker.kind === 'pill' ? Math.hypot(s.marker.x2 - s.marker.x1, s.marker.y2 - s.marker.y1) * CELL / 2 + 14 : 12);

  function selectStation(id: number) {
    const s = stations().get(id);
    if (!s) return;
    st.sel = { kind: 'station', id };
    const lines = lineById();
    const pills = s.lines.map((lid) => lines.get(lid)).filter((l): l is SLine => !!l).map((l) => linePill(l)).join('');
    const nearby = (st.layout?.links ?? []).filter((k) => k.a === id || k.b === id).map((k) => stations().get(k.a === id ? k.b : k.a)).filter((x): x is SStation => !!x);
    showCard(`<div class="smc-head"><div class="smc-title">${esc(s.name || t('Unnamed stop'))}</div><div class="smc-sub">${s.transfer ? esc(t('Interchange')) + ' · ' : ''}${tn(s.lines.length, '{n} line', '{n} lines')}</div></div>
      <div class="smc-pills">${pills}</div>
      ${nearby.length ? `<div class="smc-near">${esc(t('Walking transfer to'))} ${nearby.map((n) => `<button class="link-btn" data-station="${n.id}">${esc(n.name || t('Unnamed stop'))}</button>`).join(', ')}</div>` : ''}
      <div class="smc-actions"><button class="pill primary" data-plan="to">${svgI(ICON.dir)}${t('To here')}</button><button class="pill" data-plan="from">${t('From here')}</button><button class="pill" data-map-station="${s.id}">${svgI(ICON.pin)}${t('Show on map')}</button></div>
      ${planHint()}`);
    applySelection();
  }
  function selectLine(id: number) {
    const l = lineById().get(id);
    if (!l) return;
    st.sel = { kind: 'line', id };
    const S = stations();
    const names = l.route.map((sid) => S.get(sid)).filter((x): x is SStation => !!x);
    const ends = l.loop ? t('Circular line') : `${esc(names[0]?.name || '?')} ↔ ${esc(names[names.length - 1]?.name || '?')}`;
    const stops = l.loop ? names.slice(0, -1) : names;
    showCard(`<div class="smc-head">${linePill(l, true)}<div class="smc-sub">${esc(t(MODE_NAMES[l.mode] ?? l.mode))} · ${tn(stops.length, '{n} stop', '{n} stops')} · ${ends}</div></div>
      <div class="smc-actions"><button class="pill" data-map-line="${l.id}">${svgI(ICON.pin)}${t('Show on map')}</button></div>
      <ol class="smc-stops" style="--c:${l.color}">${stops.map((s) => `<li><button data-station="${s.id}">${esc(s.name || t('Unnamed stop'))}</button></li>`).join('')}</ol>`);
    applySelection();
    // bring the line into view
    const pts = l.hops.flatMap((h) => h.pts);
    if (pts.length) fitBox(pts);
  }
  function fitBox(pts: Pt[]) {
    const xs = pts.map((p) => p[0] * CELL), ys = pts.map((p) => p[1] * CELL);
    const px = 130, py = 60; // room for the names beside the stations
    fitTo([Math.min(...xs) - px, Math.min(...ys) - py, Math.max(...xs) - Math.min(...xs) + px * 2, Math.max(...ys) - Math.min(...ys) + py * 2]);
  }
  function clearSelection() {
    st.sel = null; card.hidden = true; sheet.hide();
    applySelection();
  }
  const linePill = (l: SLine, big = false) => `<button class="line-pill${big ? ' big' : ''}" data-line="${l.id}" style="background:${l.color};color:${textOn(l.color)}"><img src="${iconDataUrl(l.mode, l.color)}" alt="">${esc(l.name)}</button>`;
  function showCard(html: string) {
    cardBody.innerHTML = html;
    const wasHidden = card.hidden;
    card.hidden = false;
    if (wasHidden) sheet.show('half'); else sheet.refresh();
  }
  function planHint() {
    const S = stations();
    if (st.from === null && st.to === null) return '';
    const a = st.from !== null ? S.get(st.from)?.name || t('Unnamed stop') : null, b = st.to !== null ? S.get(st.to)?.name || t('Unnamed stop') : null;
    return `<div class="smc-plan"><span class="dotA"></span>${esc(a ?? t('Choose a starting station'))}<span class="arrow">→</span><span class="dotB"></span>${esc(b ?? t('Choose a destination station'))}<button class="link-btn" data-plan-clear>${t('Clear')}</button></div>`;
  }

  // ---------------------------------------------------------------- journeys
  function plan() {
    const S = stations();
    if (st.from === null || st.to === null) { applySelection(); return; }
    const a = S.get(st.from)!, b = S.get(st.to)!;
    st.routeReq++;
    st.sel = { kind: 'route' }; st.route = null;
    showCard(`<div class="smc-head"><div class="smc-title">${esc(a.name || t('Unnamed stop'))} → ${esc(b.name || t('Unnamed stop'))}</div><div class="smc-sub">${t('Finding a route…')}</div></div>`);
    d.worker.postMessage({ type: 'route', id: st.routeReq, mode: 'transit', from: [a.gx, a.gz], to: [b.gx, b.gz] });
  }
  /** a route reply for the diagram (true) or for someone else (false) */
  function onRoute(m: { id: number; routes: Route[] }) {
    if (m.id < 2_000_000) return false;
    if (m.id !== st.routeReq) return true;
    const r = m.routes[0];
    if (!r) { showCard(`<div class="smc-head"><div class="smc-title">${t('No transit route')}</div><div class="smc-sub">${t('No transit route — it may be quicker to walk, or no line serves these places.')}</div></div>${planHint()}`); return true; }
    showRoute(r);
    return true;
  }
  function showRoute(r: Route) {
    st.route = r; st.sel = { kind: 'route' };
    ensureModes(r);
    const lines = lineById(), S = stations(), ss = st.layout?.stopStation ?? {};
    const fc = d.pricing.fareCost(r);
    const fare = fc && fc.missing.length < fc.rides.length ? ` · ${d.pricing.money(fc.total)}${fc.missing.length ? '+' : ''}` : '';
    const rides = r.legs.filter((l) => l.kind === 'ride');
    const legRows = rides.map((l) => {
      const sl = l.line ? lines.get(l.line.id) : undefined;
      const a = l.stopIds?.length ? S.get(ss[l.stopIds[0]]) : undefined, b = l.stopIds?.length ? S.get(ss[l.stopIds[l.stopIds.length - 1]]) : undefined;
      return `<li>${sl ? linePill(sl) : `<span class="line-pill" style="background:${l.line!.color};color:${textOn(l.line!.color)}">${esc(l.line!.name)}</span>`}<span>${esc(a?.name || l.from || '')} → ${esc(b?.name || l.to || '')}</span><small>${tn(l.stops ?? 0, '{n} stop', '{n} stops')}</small></li>`;
    }).join('');
    const transfers = rides.length - 1, walk = r.legs.filter((l) => l.kind === 'walk').reduce((s, l) => s + l.dist, 0);
    const first = rides[0]?.stopIds?.[0], last = rides[rides.length - 1]?.stopIds?.at(-1);
    const A = first !== undefined ? S.get(ss[first]) : undefined, B = last !== undefined ? S.get(ss[last]) : undefined;
    showCard(`<div class="smc-head"><div class="smc-title">${fmtTime(r.time)}<span class="smc-fare">${fare}</span></div><div class="smc-sub">${transfers > 0 ? tn(transfers, '{n} transfer', '{n} transfers') + ' · ' : ''}${t('{dist} walk', { dist: fmtDist(walk) })}</div></div>
      <ol class="smc-legs">${legRows}</ol>
      <div class="smc-actions">${A && B ? `<button class="pill primary" data-open-dir>${svgI(ICON.dir)}${t('Open in directions')}</button>` : ''}<button class="pill" data-plan-clear>${t('Clear')}</button></div>`);
    applySelection();
    const pts: Pt[] = [];
    for (const l of rides) for (const sid of l.stopIds ?? []) { const s = S.get(ss[sid]); if (s) pts.push([s.x, s.y]); }
    if (pts.length) fitBox(pts);
  }
  /** a route shown from the directions panel may use modes hidden here: switch them on */
  function ensureModes(r: Route) {
    const need = [...new Set(r.legs.filter((l) => l.kind === 'ride' && l.line).map((l) => l.line!.mode))].filter((m) => !st.modes.includes(m));
    if (need.length) { st.modes = [...st.modes, ...need]; st.pendingRoute = r; request(); }
  }
  function drawRoute(overlay: Element) {
    const r = st.route!, lines = lineById(), S = stations(), ss = st.layout?.stopStation ?? {};
    const parts: string[] = [];
    let prevEnd: SStation | undefined;
    for (const leg of r.legs) {
      if (leg.kind !== 'ride' || !leg.line) continue;
      const l = lines.get(leg.line.id);
      const seq = (leg.stopIds ?? []).map((sid) => ss[sid]).filter((x, i, a) => x !== undefined && (i === 0 || x !== a[i - 1]));
      const first = S.get(seq[0]), last = S.get(seq[seq.length - 1]);
      if (prevEnd && first && prevEnd.id !== first.id) parts.push(`<line class="sm-walk" x1="${prevEnd.x * CELL}" y1="${prevEnd.y * CELL}" x2="${first.x * CELL}" y2="${first.y * CELL}"/>`);
      if (l) {
        const pts: Pt[] = [];
        for (let i = 1; i < seq.length; i++) {
          const h = l.hops.find((x) => x.a === seq[i - 1] && x.b === seq[i]) ?? (() => { const back = l.hops.find((x) => x.a === seq[i] && x.b === seq[i - 1]); return back ? { ...back, pts: [...back.pts].reverse() } : undefined; })();
          if (h) for (const p of h.pts) pts.push(p);
        }
        if (pts.length) {
          const fake: SLine = { ...l, hops: [{ a: 0, b: 0, pts }] };
          const dpath = linePath(fake);
          parts.push(`<path class="sm-route-case" d="${dpath}" stroke-width="${lineWidth(l.mode) + 9}"/><path class="sm-route" d="${dpath}" stroke="${l.color}" stroke-width="${lineWidth(l.mode) + 3}"/>`);
        }
        for (const sid of seq) canvas.querySelectorAll(`[data-station="${sid}"]`).forEach((e) => e.classList.add('on'));
      }
      prevEnd = last;
    }
    overlay.insertAdjacentHTML('afterbegin', parts.join(''));
  }

  // ---------------------------------------------------------------- events
  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.closest('[data-close]')) return close();
    if (tg.closest('[data-legend]')) { st.legendOpen = !st.legendOpen; legend.hidden = !st.legendOpen; return; }
    if (tg.closest('[data-fit]')) return fitTo();
    const z = (tg.closest('[data-zoom]') as HTMLElement | null)?.dataset.zoom;
    if (z) { const r = view.getBoundingClientRect(); return zoomAt(r.width / 2, r.height / 2, z === '1' ? 1.5 : 1 / 1.5); }
    const mode = (tg.closest('[data-mode]') as HTMLElement | null)?.dataset.mode;
    if (mode) {
      st.modes = st.modes.includes(mode) ? st.modes.filter((x) => x !== mode) : [...st.modes, mode];
      try { localStorage.setItem('atlas:schem-modes', JSON.stringify(st.modes)); } catch { /* ignore */ }
      st.sel = null; card.hidden = true; sheet.hide();
      return request();
    }
    if (tg.closest('[data-card-close]')) return clearSelection();
    if (!el.contains(tg) || tg.closest('.sm-view')) return;
    const lid = (tg.closest('[data-line]') as HTMLElement | null)?.dataset.line;
    if (lid) { if (isPhone() && tg.closest('.sm-legend')) { st.legendOpen = false; legend.hidden = true; } return selectLine(+lid); }
    const sid = (tg.closest('[data-station]') as HTMLElement | null)?.dataset.station;
    if (sid) { selectStation(+sid); const s = stations().get(+sid); if (s) fitBox([[s.x - 3, s.y - 3], [s.x + 3, s.y + 3]]); return; }
    const pl = (tg.closest('[data-plan]') as HTMLElement | null)?.dataset.plan;
    if (pl && st.sel?.kind === 'station') {
      if (pl === 'from') st.from = st.sel.id; else st.to = st.sel.id;
      if (st.from === st.to) { if (pl === 'from') st.to = null; else st.from = null; }
      if (st.from !== null && st.to !== null) return plan();
      return selectStation(st.sel.id);
    }
    if (tg.closest('[data-plan-clear]')) { st.from = st.to = null; st.route = null; return clearSelection(); }
    const ms = (tg.closest('[data-map-station]') as HTMLElement | null)?.dataset.mapStation;
    if (ms) { const s = stations().get(+ms); if (s) { close(); d.showStation(placeOf(s)); } return; }
    const ml = (tg.closest('[data-map-line]') as HTMLElement | null)?.dataset.mapLine;
    if (ml) { close(); d.showLine(+ml); return; }
    if (tg.closest('[data-open-dir]') && st.route) {
      const S = stations(), ss = st.layout?.stopStation ?? {}, rides = st.route.legs.filter((l) => l.kind === 'ride');
      const A = st.from !== null ? S.get(st.from) : S.get(ss[rides[0]?.stopIds?.[0] ?? -1]);
      const B = st.to !== null ? S.get(st.to) : S.get(ss[rides[rides.length - 1]?.stopIds?.at(-1) ?? -1]);
      if (A && B) { close(); d.directions(placeOf(A), placeOf(B)); }
    }
  });
  window.addEventListener('keydown', (e) => {
    if (el.hidden || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'Escape') { if (st.sel) clearSelection(); else close(); }
    if (e.key === '+' || e.key === '=') { const r = view.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.4); }
    if (e.key === '-') { const r = view.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.4); }
  });
  // follow the map's light / night theme
  new MutationObserver(() => { if (!el.hidden && st.layout) draw(false); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function open(opts: { route?: Route } = {}) {
    el.hidden = false; d.onOpen();
    if (isPhone()) st.legendOpen = false; // on a phone the legend is a sheet, opened on demand
    legend.hidden = !st.legendOpen;
    $<HTMLElement>('.sm-city').textContent = d.cityName();
    if (opts.route) { st.pendingRoute = opts.route; st.from = st.to = null; }
    if (!st.layout) request();
    else { draw(!opts.route); if (opts.route) { const r = opts.route; st.pendingRoute = null; showRoute(r); } }
  }
  function close() { el.hidden = true; card.hidden = true; sheet.hide(); d.onClose(); }
  return {
    open, close, isOpen: () => !el.hidden, onRoute,
    onMessage(m: Parameters<typeof onMessage>[0]) {
      onMessage(m);
      if (st.pendingRoute && st.layout) { const r = st.pendingRoute; st.pendingRoute = null; showRoute(r); }
    },
    /** a new city: forget the old diagram */
    reset() { try { st.modes = JSON.parse(localStorage.getItem('atlas:schem-modes') ?? 'null') ?? DEFAULT_MODES; } catch { st.modes = DEFAULT_MODES; } st.layout = null; st.sel = null; st.from = st.to = null; st.route = null; st.available = []; if (!el.hidden) request(); },
    relang() { applyStatic(el); if (!el.hidden && st.layout) { renderModes(); renderLegend(); if (st.sel?.kind === 'station') selectStation(st.sel.id); else if (st.sel?.kind === 'line') selectLine(st.sel.id); else if (st.sel?.kind === 'route' && st.route) showRoute(st.route); } },
  };
}
