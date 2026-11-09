import { parseCity } from './parse';
import { buildCity, buildContours } from './build';
import { Router } from './router';
import { inferOneWay } from './oneway';
import { detectTolls } from './tolls';
import { setLang } from './i18n';
import { bestSchematic } from './schematic-render';
import type { SchemInput } from './schematic';
import { reachGrid } from './reach';
import { discover } from './discover';
import { createClosures, segInfoFrom } from './closure';
import { cityKeys, scanExport, bornById, exportTime, type HistoryKeys } from './history';
import type { CityData } from './parse';
import { loadSim, transferables } from './sim';

let router: Router | null = null;
let closures: ReturnType<typeof createClosures> | null = null;
let schemInput: SchemInput | null = null;
const schemCache = new Map<string, unknown>();

let lastHeight: { h: Float32Array; size: number } | null = null;
let lastCity: CityData | null = null;
let history: HistoryKeys | null = null;

async function decode(buf: ArrayBuffer): Promise<string> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return new TextDecoder('utf-8').decode(buf);
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  const progress = (step: string, pct: number) => self.postMessage({ type: 'progress', step, pct });
  try {
    if (msg.type === 'load') {
      progress('Decoding file', 4);
      const xml = await decode(msg.buffer);
      // i18n-keys: progress steps, shown translated by the page
      const steps = ['Reading nodes', 'Reading segments', 'Reading buildings', 'Reading terrain', 'Classifying roads', 'Shaping buildings', 'Tracing transit lines', 'Tracing coastlines', 'Growing forests', 'Mapping built-up areas'];
      void ['Decoding file', 'Preparing directions', 'Finding discoveries', 'Rendering'];
      // end i18n-keys
      const p = (s: string) => progress(s, 8 + (steps.indexOf(s) + 1) * 8.5);
      const city = parseCity(xml, p);
      lastHeight = { h: city.height, size: city.terrainSize };
      lastCity = city; history = null;
      const oneway = inferOneWay(city);
      const tolls = detectTolls(city);
      const built = buildCity(city, p, oneway, tolls);
      progress('Finding discoveries', 92);
      // a record that throws must not stop the city from opening
      try { built.discoveries = discover(city, built); } catch (err) { console.warn('[atlas] discoveries failed', err); built.discoveries = null; }
      progress('Preparing directions', 94);
      router = new Router(city, built.stopNames ?? new Map(), oneway, tolls);
      closures = createClosures(city, router, segInfoFrom(built), built.stopNames ?? new Map());
      delete built.stopNames;
      schemInput = built.schem ?? null; schemCache.clear();
      delete built.schem;
      progress('Rendering', 96);
      const df = built.districtField;
      self.postMessage({ type: 'city', city: built }, { transfer: [built.dem.surface.buffer, ...(df ? [df.l1.buffer, df.d1.buffer, df.l2.buffer, df.d2.buffer, df.land.buffer] : [])] });
    } else if (msg.type === 'route') {
      const routes = router ? router.route(msg.from, msg.to, msg.mode, { avoidTolls: !!msg.avoidTolls }) : [];
      self.postMessage({ type: 'route', id: msg.id, mode: msg.mode, routes });
    } else if (msg.type === 'reach') {
      const grid = router ? reachGrid(router.nodePositions(), router.reachTimes(msg.from, msg.mode, msg.max), msg.max) : null;
      self.postMessage({ type: 'reach', id: msg.id, grid }, grid ? { transfer: [grid.t.buffer] } : {});
    } else if (msg.type === 'closure') {
      self.postMessage({ type: 'closure', id: msg.id, result: closures?.analyze(msg.pick) ?? null });
    } else if (msg.type === 'closureReach') {
      const r = router && closures?.reach(msg.pick, msg.from, msg.mode, msg.max);
      const before = r ? reachGrid(router!.nodePositions(), r.before, msg.max) : null, after = r ? reachGrid(router!.nodePositions(), r.after, msg.max) : null;
      self.postMessage({ type: 'closureReach', id: msg.id, before, after }, { transfer: [before?.t.buffer, after?.t.buffer].filter(Boolean) as ArrayBuffer[] });
    } else if (msg.type === 'historyStart' && lastCity) {
      history = cityKeys(lastCity, exportTime(lastCity.generated));
      self.postMessage({ type: 'historyStart', name: lastCity.name, time: exportTime(lastCity.generated) });
    } else if (msg.type === 'historyFile' && history) {
      const r = scanExport(await decode(msg.buffer), history);
      self.postMessage({ type: 'historyFile', id: msg.id, ...r });
    } else if (msg.type === 'historyDone' && history && lastCity) {
      const born = bornById(lastCity, history);
      history = null;
      self.postMessage({ type: 'history', ...born });
    } else if (msg.type === 'schematic') {
      // which modes exist, and the diagram for the requested ones (cached per mode set)
      const available = [...new Set((schemInput?.lines ?? []).map((l) => l.mode))];
      const modes = (msg.modes as string[]).filter((m) => available.includes(m)).sort();
      const k = modes.join(',');
      if (!schemCache.has(k)) schemCache.set(k, schemInput && modes.length ? bestSchematic(schemInput, modes) : null);
      self.postMessage({ type: 'schematic', id: msg.id, available, modes, layout: schemCache.get(k) });
    } else if (msg.type === 'sim') {
      // optional simulation data from a save; never touches the map built above
      // i18n-keys: sim progress steps, shown translated by the page
      void ['Reading save file', 'Checking it matches this map', 'Reading simulation data'];
      // end i18n-keys
      if (!lastCity) { self.postMessage({ type: 'sim', id: msg.id, result: { ok: false, code: 'corrupt', detail: 'no map open' } }); return; }
      const result = await loadSim(msg.buffer, lastCity, (step) => self.postMessage({ type: 'simProgress', id: msg.id, step }));
      self.postMessage({ type: 'sim', id: msg.id, result }, { transfer: transferables(result) });
    } else if (msg.type === 'lang') {
      setLang(msg.lang, false); // directions text is written in the UI language
    } else if (msg.type === 'contours' && lastHeight) {
      const fc = buildContours(lastHeight.h, lastHeight.size, msg.interval ?? 10, msg.major ?? 50);
      self.postMessage({ type: 'contours', fc });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
