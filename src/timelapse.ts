// City time-lapse: older exports of the open city say when each road, building and transit line first
// appeared; a slider (and Play) then filters the map to what existed at each export. Only the open, newest
// export is drawn, so things demolished since never appear. See history.ts for the matching.
import type { Map as MLMap, GeoJSONSource, FilterSpecification } from 'maplibre-gl';
import type { BuiltCity } from './build';
import { t, locale, fmtFixed } from './i18n';

const TAGGED = ['roads', 'rails', 'lots', 'buildings', 'transit'];
const HIDDEN = ['places', 'roadLabels']; // labels of places that may not exist yet

export function createTimelapse(map: MLMap, deps: { worker: Worker; city: () => BuiltCity | null; currentFile: () => string; toast: (m: string) => void; onOpen: () => void }) {
  const st = { active: false, loading: false, times: [] as number[], i: 0, playing: 0, msg: '', dev: [] as string[] };
  const saved = new Map<string, { filter: unknown; vis: unknown }>();
  let waiters = new Map<string, (m: any) => void>();
  const wait = (key: string) => new Promise<any>((res) => waiters.set(key, res));

  const el = document.createElement('div');
  el.id = 'timelapse'; el.className = 'card'; el.hidden = true;
  document.body.appendChild(el);
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = '.cslmap,.gz'; input.hidden = true;
  document.body.appendChild(input);
  input.onchange = () => { const fs = [...(input.files ?? [])]; input.value = ''; if (fs.length) void load(fs.map((f) => ({ name: f.name, get: () => f.arrayBuffer() }))); };

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const fmtDate = (ms: number) => new Date(ms).toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function stats(T: number) {
    const c = deps.city();
    if (!c) return { blds: 0, km: 0 };
    const lots = c.sources.lots as any, roads = c.sources.roads as any;
    let blds = 0, m = 0;
    for (const f of lots.features) if ((f.properties.born ?? 0) <= T && !f.properties.part) blds++;
    for (const f of roads.features) if ((f.properties.born ?? 0) <= T && f.properties.lanes > 0) m += f.properties.len ?? 0; // roads with car lanes
    return { blds, km: m / 1000 };
  }

  function render() {
    void ['City time-lapse', 'Close', 'Watch {city} grow. Pick older exports of this city: the more saves, the smoother the time-lapse.', 'Choose older exports', 'Use {n} saves from the export folder', 'Tip: turn on timestamps in the CSLMapView settings so every export is kept.', 'Reading {i} of {n}…', 'Play', 'Pause', 'Buildings', 'Road length', 'Export {i} of {n}', 'Shows when today\'s roads, buildings and lines first appeared; things demolished since aren\'t shown.', 'Load other exports'];
    const city = deps.city()?.meta.name ?? '';
    const head = `<div class="m-head"><b>${t('City time-lapse')}</b><button class="icon-btn tl-close" aria-label="${t('Close')}"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button></div>`;
    if (st.times.length < 2) {
      el.innerHTML = `${head}
        <p class="tl-lede">${esc(t('Watch {city} grow. Pick older exports of this city: the more saves, the smoother the time-lapse.', { city }))}</p>
        ${st.loading ? `<p class="tl-msg">${esc(st.msg)}</p>` : `<div class="tl-actions"><button class="pill primary" data-a="pick">${t('Choose older exports')}</button>${st.dev.length ? `<button class="pill" data-a="dev">${esc(t('Use {n} saves from the export folder', { n: st.dev.length }))}</button>` : ''}</div>
        ${st.msg ? `<p class="tl-msg">${esc(st.msg)}</p>` : ''}<p class="tl-note">${t('Tip: turn on timestamps in the CSLMapView settings so every export is kept.')}</p>`}`;
      return;
    }
    const T = st.times[st.i], s = stats(T), n = st.times.length;
    el.innerHTML = `${head}
      <div class="tl-date"><b>${esc(fmtDate(T))}</b><span>${esc(t('Export {i} of {n}', { i: st.i + 1, n }))}</span></div>
      <div class="tl-row">
        <button class="icon-btn tl-play" aria-label="${st.playing ? t('Pause') : t('Play')}">${st.playing ? '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'}</button>
        <input class="tl-range" type="range" min="0" max="${n - 1}" step="1" value="${st.i}" aria-label="${esc(fmtDate(T))}" />
      </div>
      <div class="m-stats"><div><span>${t('Buildings')}</span><b>${s.blds.toLocaleString(locale())}</b></div><div><span>${t('Road length')}</span><b>${fmtFixed(s.km, 1)} km</b></div></div>
      <p class="tl-note">${t('Shows when today\'s roads, buildings and lines first appeared; things demolished since aren\'t shown.')} <button class="link-btn" data-a="pick">${t('Load other exports')}</button></p>`;
  }

  /** Filter the map to what existed at the current export. */
  function apply() {
    if (!st.active || st.times.length < 2) return;
    const T = st.times[st.i];
    for (const id of map.getLayersOrder()) {
      const l = map.getLayer(id) as { id: string; source?: string } | undefined;
      if (!l?.source) continue;
      if (TAGGED.includes(l.source)) {
        if (!saved.has(l.id)) saved.set(l.id, { filter: map.getFilter(l.id), vis: undefined });
        const orig = saved.get(l.id)!.filter as FilterSpecification | undefined;
        const cond: FilterSpecification = ['<=', ['coalesce', ['get', 'born'], 0], T];
        map.setFilter(l.id, orig ? ['all', orig, cond] as FilterSpecification : cond);
      } else if (HIDDEN.includes(l.source)) {
        if (!saved.has(l.id)) saved.set(l.id, { filter: undefined, vis: map.getLayoutProperty(l.id, 'visibility') });
        map.setLayoutProperty(l.id, 'visibility', 'none');
      }
    }
  }
  function restore() {
    for (const [id, s] of saved) {
      if (!map.getLayer(id)) continue;
      if (s.vis !== undefined || HIDDEN.includes((map.getLayer(id) as any).source)) map.setLayoutProperty(id, 'visibility', (s.vis as any) ?? 'visible');
      else map.setFilter(id, (s.filter as FilterSpecification) ?? null);
    }
    saved.clear();
  }

  function stop() { if (st.playing) { clearInterval(st.playing); st.playing = 0; } }
  function play() {
    if (st.i >= st.times.length - 1) st.i = 0;
    st.playing = window.setInterval(() => {
      if (st.i >= st.times.length - 1) { stop(); render(); return; }
      st.i++; apply(); render();
    }, 700);
    apply(); render();
  }

  async function load(files: { name: string; get: () => Promise<ArrayBuffer> }[]) {
    try { await loadAll(files); } catch (err) { st.loading = false; st.times = []; st.msg = (err as Error).message; render(); }
  }
  async function loadAll(files: { name: string; get: () => Promise<ArrayBuffer> }[]) {
    const c = deps.city();
    if (!c) return;
    stop(); restore(); st.times = []; st.loading = true; st.msg = ''; render();
    deps.worker.postMessage({ type: 'historyStart' });
    const start = await wait('historyStart');
    const times = new Set<number>([start.time]);
    let other = 0;
    for (let k = 0; k < files.length; k++) {
      st.msg = t('Reading {i} of {n}…', { i: k + 1, n: files.length }); render();
      try {
        const buf = await files[k].get();
        deps.worker.postMessage({ type: 'historyFile', id: k, buffer: buf }, [buf]);
        const r = await wait('historyFile');
        if (r.name !== start.name) other++;
        else if (Number.isFinite(r.time) && r.time <= start.time) times.add(r.time);
      } catch { /* unreadable file: skip */ }
    }
    deps.worker.postMessage({ type: 'historyDone' });
    const born = await wait('history');
    // tag the open city's features with first-seen times and redraw those sources
    const by = { seg: new Map<number, number>(born.seg), bld: new Map<number, number>(born.bld), line: new Map<number, number>(born.line) };
    const tag = (k: string, of: (f: any) => number | undefined) => {
      const fc = c.sources[k as keyof typeof c.sources] as any;
      for (const f of fc.features) { const v = of(f); if (v !== undefined) f.properties.born = v; }
      (map.getSource(k) as GeoJSONSource | undefined)?.setData(fc);
    };
    tag('roads', (f) => by.seg.get(f.properties.id)); tag('rails', (f) => by.seg.get(f.properties.id));
    tag('lots', (f) => by.bld.get(f.properties.id)); tag('buildings', (f) => by.bld.get(f.properties.id ?? f.id));
    tag('transit', (f) => by.line.get(f.properties.line));
    st.loading = false;
    st.times = [...times].sort((a, b) => a - b);
    st.i = 0;
    st.msg = other ? t('Skipped {n} files from other cities.', { n: other }) : '';
    if (st.times.length < 2) { st.msg = t('No older exports of {city} found.', { city: start.name }); render(); return; }
    if (other) deps.toast(st.msg);
    apply(); render();
  }

  async function findDev() {
    // dev server only: other saves of this city in the export folder
    st.dev = [];
    const cur = deps.currentFile(), base = cur.replace(/-\d{8}-\d{6}\.cslmap(\.gz)?$/i, '');
    if (!cur || base === cur) return;
    try {
      const r = await fetch('/api/maps');
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
      const j = await r.json();
      st.dev = (j.maps as { file: string }[]).map((m) => m.file).filter((f) => f !== cur && f.normalize('NFC').startsWith(base.normalize('NFC') + '-'));
    } catch { /* not the dev server */ }
  }

  el.addEventListener('click', (e) => {
    const tg = e.target as HTMLElement;
    if (tg.closest('.tl-close')) return close();
    if (tg.closest('.tl-play')) { if (st.playing) { stop(); render(); } else play(); return; }
    const a = tg.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'pick') input.click();
    if (a === 'dev') void load(st.dev.map((f) => ({ name: f, get: async () => { const r = await fetch('/api/maps/' + encodeURIComponent(f)); if (!r.ok) throw new Error(r.statusText); return r.arrayBuffer(); } })));
  });
  el.addEventListener('input', (e) => {
    const r = e.target as HTMLInputElement;
    if (!r.classList.contains('tl-range')) return;
    stop(); st.i = +r.value; apply();
    // update the text without rebuilding the slider under the pointer
    const T = st.times[st.i], s = stats(T);
    el.querySelector('.tl-date b')!.textContent = fmtDate(T);
    el.querySelector('.tl-date span')!.textContent = t('Export {i} of {n}', { i: st.i + 1, n: st.times.length });
    const b = el.querySelectorAll('.m-stats b'); b[0].textContent = s.blds.toLocaleString(locale()); b[1].textContent = fmtFixed(s.km, 1) + ' km';
    el.querySelector('.tl-play')!.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  });

  function open() {
    deps.onOpen();
    st.active = true; el.hidden = false;
    if (st.times.length >= 2) apply();
    render();
    void findDev().then(() => { if (st.active && st.times.length < 2 && !st.loading) render(); });
  }
  function close() { stop(); st.active = false; el.hidden = true; restore(); }

  deps.worker.addEventListener('message', (e) => {
    const m = e.data, w = waiters.get(m.type);
    if (w) { waiters.delete(m.type); w(m); }
  });

  return {
    open, close,
    isActive: () => st.active,
    /** a new city was opened: forget the old time-lapse */
    reset() { close(); st.times = []; st.msg = ''; waiters = new Map(); },
    /** after a style change, put the filters back */
    refresh() { if (st.active) apply(); }, // originals stay saved; this re-hides labels a style change showed
  };
}
