import { parseCity } from './parse';
import { buildCity, buildContours } from './build';
import { Router } from './router';
import { inferOneWay } from './oneway';
import { detectTolls } from './tolls';
import { setLang } from './i18n';
import { bestSchematic } from './schematic-render';
import type { SchemInput } from './schematic';

let router: Router | null = null;
let schemInput: SchemInput | null = null;
const schemCache = new Map<string, unknown>();

let lastHeight: { h: Float32Array; size: number } | null = null;

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
      void ['Decoding file', 'Preparing directions', 'Rendering'];
      // end i18n-keys
      const p = (s: string) => progress(s, 8 + (steps.indexOf(s) + 1) * 8.5);
      const city = parseCity(xml, p);
      lastHeight = { h: city.height, size: city.terrainSize };
      const oneway = inferOneWay(city);
      const tolls = detectTolls(city);
      const built = buildCity(city, p, oneway, tolls);
      progress('Preparing directions', 94);
      router = new Router(city, built.stopNames ?? new Map(), oneway, tolls);
      delete built.stopNames;
      schemInput = built.schem ?? null; schemCache.clear();
      delete built.schem;
      progress('Rendering', 96);
      const df = built.districtField;
      self.postMessage({ type: 'city', city: built }, { transfer: [built.dem.surface.buffer, ...(df ? [df.l1.buffer, df.d1.buffer, df.l2.buffer, df.d2.buffer, df.land.buffer] : [])] });
    } else if (msg.type === 'route') {
      const routes = router ? router.route(msg.from, msg.to, msg.mode, { avoidTolls: !!msg.avoidTolls }) : [];
      self.postMessage({ type: 'route', id: msg.id, mode: msg.mode, routes });
    } else if (msg.type === 'schematic') {
      // which modes exist, and the diagram for the requested ones (cached per mode set)
      const available = [...new Set((schemInput?.lines ?? []).map((l) => l.mode))];
      const modes = (msg.modes as string[]).filter((m) => available.includes(m)).sort();
      const k = modes.join(',');
      if (!schemCache.has(k)) schemCache.set(k, schemInput && modes.length ? bestSchematic(schemInput, modes) : null);
      self.postMessage({ type: 'schematic', id: msg.id, available, modes, layout: schemCache.get(k) });
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
