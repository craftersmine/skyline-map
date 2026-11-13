// Navigation simulation: drive a calculated route virtually, with a follow camera, turn-by-turn banner,
// optional voice and playback controls. The timing and maneuvers come from nav.ts; this file draws them.
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, GeoJSONSource, LayerSpecification } from 'maplibre-gl';
import type { Route } from './router';
import { buildPlan, stateAt, timeAt, pointAt, bearing, spanAt, nextManeuver, type NavPlan, type Maneuver } from './nav';
import { toLngLat, type XY } from './geo';
import { maneuverIcon, fmtDist, fmtTime } from './directions';
import { isPhone } from './sheet';
import { t, applyStatic, getLang, locale } from './i18n';

export interface NavDeps {
  map: MLMap;
  /** translated road class ("Local street") for roads the export leaves unnamed */
  roadLabel: (cls: string) => string | undefined;
  onOpen: () => void; onClose: () => void;
}

const SPEEDS = [1, 2, 5, 10];
const TURNS = /^(turn|slight|ramp|exit)-|^uturn$|^merge$/;
const svg = (inner: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const I = {
  play: svg('<path d="M8 5.1v13.8a.6.6 0 0 0 .9.5l10.8-6.9a.6.6 0 0 0 0-1L8.9 4.6a.6.6 0 0 0-.9.5z"/>'),
  pause: svg('<path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/>'),
  restart: svg('<path d="M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>'),
  skip: svg('<path d="M5 6.2v11.6a.6.6 0 0 0 .9.5l8.2-5.8a.6.6 0 0 0 0-1L5.9 5.7a.6.6 0 0 0-.9.5zM16 6h2.5v12H16z"/>'),
  voiceOn: svg('<path d="M4 9v6h4l5 4.5v-15L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/>'),
  voiceOff: svg('<path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v2.2l2.5 2.5V12zm2.5 0c0 .9-.2 1.8-.5 2.6l1.5 1.5A9 9 0 0 0 14 3.2v2.1a7 7 0 0 1 5 6.7zM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8L19.7 21l1.3-1.3-9-9L4.3 3zM12 4 9.9 6.1 12 8.2V4z"/>'),
  close: svg('<path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/>'),
  center: svg('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/>'),
};
const PUCK = `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" fill="#fff"/><circle cx="24" cy="24" r="20" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="1"/><path d="M24 9 35 35l-11-6-11 6z" fill="#1a73e8"/></svg>`;
// i18n-keys
void ['Tunnel', 'Bridge / elevated', 'In {n} kilometers, {instruction}', 'In {n} meters, {instruction}'];
// end i18n-keys

export function createNav(d: NavDeps) {
  const { map } = d;
  const el = document.createElement('div');
  el.id = 'nav';
  el.hidden = true;
  el.innerHTML = `
    <div class="nav-top">
      <div class="nav-live" role="status" aria-live="polite"></div>
      <div class="nav-banner">
        <div class="nb-icon"></div>
        <div class="nb-main"><div class="nb-dist"></div><div class="nb-text"></div></div>
      </div>
      <div class="nav-then" hidden><span data-i18n="Then">Then</span><span class="nt-icon"></span></div>
      <div class="nav-badge" hidden></div>
    </div>
    <div class="nav-bar card">
      <div class="nav-side">
        <div class="nav-speed" title="Simulated speed" data-i18n-title="Simulated speed"><b></b><small>km/h</small></div>
        <div class="nav-limit" hidden><b></b></div>
      </div>
      <button class="nav-recenter pill" hidden>${I.center}<span data-i18n="Re-center">Re-center</span></button>
      <div class="nav-road"></div>
      <input class="nav-progress" type="range" min="0" max="1000" step="1" value="0" aria-label="Route progress" data-i18n-aria="Route progress" />
      <div class="nav-row">
        <button class="icon-btn nav-exit" title="Exit simulation" aria-label="Exit simulation" data-i18n-title="Exit simulation" data-i18n-aria="Exit simulation">${I.close}</button>
        <div class="nav-eta"><b class="ne-time"></b><span class="ne-sub"></span></div>
        <div class="nav-ctl">
          <button class="icon-btn nav-restart" title="Restart" aria-label="Restart" data-i18n-title="Restart" data-i18n-aria="Restart">${I.restart}</button>
          <button class="icon-btn nav-play" aria-label="Pause"></button>
          <button class="icon-btn nav-skip" title="Skip to the next maneuver" aria-label="Skip to the next maneuver" data-i18n-title="Skip to the next maneuver" data-i18n-aria="Skip to the next maneuver">${I.skip}</button>
          <div class="nav-speeds" role="radiogroup" aria-label="Playback speed" data-i18n-aria="Playback speed">${SPEEDS.map((x) => `<button role="radio" data-speed="${x}">${x}×</button>`).join('')}</div>
          <button class="icon-btn nav-voice" aria-pressed="false"></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  applyStatic(el);
  const $ = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const nb = { icon: $('.nb-icon'), dist: $('.nb-dist'), text: $('.nb-text'), banner: $('.nav-banner') };
  const H = { then: $('.nav-then'), thenIcon: $('.nt-icon'), badge: $('.nav-badge'), road: $('.nav-road'), limit: $('.nav-limit'), limitN: $('.nav-limit b'), speed: $('.nav-speed b'), eta: $('.ne-time'), sub: $('.ne-sub') };
  const progress = $<HTMLInputElement>('.nav-progress'), bar = $<HTMLElement>('.nav-bar'), live = $<HTMLElement>('.nav-live');

  const puckEl = document.createElement('div');
  puckEl.className = 'nav-puck';
  puckEl.innerHTML = PUCK;
  // turns with the road but stays upright on screen: laid flat on a 60° tilt it would be squashed to half height
  const puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'viewport', subpixelPositioning: true });

  // ---------------------------------------------------------------- state
  let plan: NavPlan | null = null, dest = '';
  let tp = 0;               // profile seconds driven (see nav.ts); route seconds = tp * plan.k
  let playing = false, speed = 1, follow = true, raf = 0, last = 0, entering = false, settling = false, session = 0;
  let camB = 0, camZ = 17, puckB = 0, camKey = '';
  let saved: { center: maplibregl.LngLat; zoom: number; bearing: number; pitch: number } | null = null;
  let hidRoute: string[] = [];
  let back: HTMLElement | null = null; // focus to return to on exit
  const shown: Record<string, string> = {};
  const set = (k: string, e: HTMLElement, v: string, html = false) => { if (shown[k] === v) return; shown[k] = v; if (html) e.innerHTML = v; else e.textContent = v; };

  // ---------------------------------------------------------------- map layers
  const LAYERS = ['nav-route-casing', 'nav-route-line', 'nav-turn-casing', 'nav-turn-line', 'nav-turn-head'];
  function addLayers(p: NavPlan) {
    const line = { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: p.pts.map((q) => toLngLat(q[0], q[1])) } };
    map.addSource('nav-route', { type: 'geojson', data: line, lineMetrics: true });
    map.addSource('nav-turn', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.hasImage('nav-head')) map.addImage('nav-head', arrowHead(), { pixelRatio: 2 });
    const w = (a: number, b: number) => ['interpolate', ['exponential', 1.5], ['zoom'], 13, a, 19, b];
    const layers = [
      { id: 'nav-route-casing', type: 'line', source: 'nav-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#174ea6', 'line-width': w(7, 26) } },
      { id: 'nav-route-line', type: 'line', source: 'nav-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#4285f4', 'line-width': w(4.5, 19), 'line-gradient': gradient(0) } },
      { id: 'nav-turn-casing', type: 'line', source: 'nav-turn', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#0b3d91', 'line-width': w(5, 17) } },
      { id: 'nav-turn-line', type: 'line', source: 'nav-turn', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'butt' }, paint: { 'line-color': '#ffffff', 'line-width': w(3, 11) } },
      { id: 'nav-turn-head', type: 'symbol', source: 'nav-turn', filter: ['==', ['geometry-type'], 'Point'], layout: { 'icon-image': 'nav-head', 'icon-rotate': ['get', 'b'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.35, 19, 1.4] } },
    ] as LayerSpecification[];
    for (const l of layers) map.addLayer(l);
    // the directions lines stay underneath, hidden while driving
    hidRoute = map.getLayersOrder().filter((id) => id.startsWith('route-') && map.getLayoutProperty(id, 'visibility') !== 'none');
    for (const id of hidRoute) map.setLayoutProperty(id, 'visibility', 'none');
  }
  function removeLayers() {
    for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    for (const s of ['nav-route', 'nav-turn']) if (map.getSource(s)) map.removeSource(s);
    for (const id of hidRoute) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible');
    hidRoute = [];
  }
  /** driven part grey, the rest blue */
  const gradient = (f: number): any => ['step', ['line-progress'], '#9aa0a6', Math.min(1, Math.max(1e-6, f)), '#4285f4'];
  let gradF = -1;
  function drawProgress(s: number) {
    // follow the car within a metre or so, whatever the route's length
    const f = s / plan!.total;
    if (f === gradF || (Math.abs(f - gradF) * plan!.total < 1.5 && f < 1)) return;
    gradF = f;
    map.setPaintProperty('nav-route-line', 'line-gradient', gradient(f));
  }
  /** the turn arrow painted on the road at the next maneuver */
  let turnFor = -1;
  function drawTurn(i: number, dist: number) {
    const m = plan!.maneuvers[i], want = m && TURNS.test(m.man) && dist < 450 ? i : -1;
    if (want === turnFor) return;
    turnFor = want;
    const src = map.getSource('nav-turn') as GeoJSONSource | undefined;
    if (!src) return;
    if (want < 0) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    const a = Math.max(0, m.at - 28), b = Math.min(plan!.total, m.at + 20);
    const pts: XY[] = [pointAt(plan!, a).xy];
    for (let k = 0; k < plan!.pts.length; k++) if (plan!.cum[k] > a && plan!.cum[k] < b) pts.push(plan!.pts[k]);
    const end = pointAt(plan!, b).xy;
    pts.push(end);
    src.setData({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((q) => toLngLat(q[0], q[1])) } },
      { type: 'Feature', properties: { b: bearing(plan!, b - 6, b) }, geometry: { type: 'Point', coordinates: toLngLat(end[0], end[1]) } },
    ] });
  }

  // ---------------------------------------------------------------- camera
  const pitch = () => (isPhone() ? 56 : 60);
  /** the car sits low in the space above the control bar, so the road ahead fills the screen */
  const padding = () => {
    const h = map.getContainer().clientHeight, bottom = Math.min(h * 0.5, bar.offsetHeight + 16);
    return { top: Math.round((h - bottom) * 0.55), bottom: Math.round(bottom), left: 0, right: 0 };
  };
  const kmh = (v: number) => (v / plan!.k) * 3.6;
  /** place the car and move the follow camera; true when the view changed */
  function camera(s: number, v: number, dt: number, snap: boolean): boolean {
    const p = plan!;
    const look = Math.min(110, 25 + kmh(v) * 0.9);
    const target = p.total - s > 3 ? bearing(p, s - 10, s + look) : camB;
    const tangent = p.total - s > 1 ? bearing(p, s - 8, s + 8) : puckB;
    // follow the road's direction with a soft lag; faster playback shortens the lag a little
    const ease = (tau: number) => (snap ? 1 : 1 - Math.exp(-dt / tau));
    camB += wrap(target - camB) * ease(0.6 / Math.sqrt(speed));
    if (v > 0.3 || snap) puckB += wrap(tangent - puckB) * ease(0.18);
    const mi = nextManeuver(p, s), toMan = p.maneuvers[mi].at - s;
    // wider view at speed, closer before a turn
    const z = 17.6 - 1.4 * Math.min(1, Math.max(0, (kmh(v) - 30) / 70)) + (toMan < 140 && TURNS.test(p.maneuvers[mi].man) ? 0.35 : 0);
    camZ += (z - camZ) * ease(1.4);
    const at = pointAt(p, s).xy, ll = toLngLat(at[0], at[1]);
    puck.setLngLat(ll).setRotation(puckB);
    puckEl.classList.toggle('tunnel', spanAt(p, s)?.brunnel === 'tunnel');
    // paused and settled: leave the map still instead of redrawing the same view every frame
    const key = `${ll[0]},${ll[1]},${camB.toFixed(1)},${camZ.toFixed(2)},${map.getContainer().clientHeight}`;
    if (follow && !entering && !settling && (key !== camKey || snap)) {
      camKey = key;
      map.jumpTo({ center: ll, bearing: camB, zoom: camZ, pitch: pitch(), padding: padding() });
      // draw the map now, in the same frame as the car marker; left to its own next frame the road lags the car and it shakes
      map.redraw();
      return true;
    }
    return false;
  }
  const wrap = (x: number) => ((x + 540) % 360) - 180;
  let clockAt = 0, clockText = '';
  const clock = (ms: number) => { if (ms !== clockAt) { clockAt = ms; clockText = new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }); } return clockText; };

  // ---------------------------------------------------------------- HUD
  function hud(s: number, v: number) {
    const p = plan!, mi = nextManeuver(p, s), m = p.maneuvers[mi], toMan = Math.max(0, m.at - s);
    const arrived = s >= p.total - 0.5;
    nb.banner.classList.toggle('arrived', arrived);
    if (arrived) {
      set('icon', nb.icon, maneuverIcon('arrive'), true);
      set('dist', nb.dist, t('You have arrived'));
      set('text', nb.text, dest);
    } else {
      set('icon', nb.icon, maneuverIcon(m.man), true);
      set('dist', nb.dist, fmtDist(toMan));
      set('text', nb.text, m.man === 'arrive' ? t('Arrive at your destination') + (dest ? ' · ' + dest : '') : m.text);
    }
    // screen readers hear each instruction once, not every distance tick
    set('live', live, arrived ? `${t('You have arrived')}. ${dest}` : nb.text.textContent ?? '');
    // a second maneuver close behind the next one
    const n2 = p.maneuvers[mi + 1], then = !arrived && n2 && n2.at - m.at < 250 && (TURNS.test(n2.man) || n2.man === 'arrive');
    H.then.hidden = !then;
    if (then) set('then', H.thenIcon, maneuverIcon(n2.man), true);
    const sp = spanAt(p, s);
    const badge = sp?.brunnel === 'tunnel' ? t('Tunnel') : sp?.brunnel === 'bridge' ? t('Bridge / elevated') : '';
    H.badge.hidden = !badge || arrived;
    set('badge', H.badge, badge);
    set('road', H.road, sp ? sp.name || d.roadLabel(sp.cls) || '' : '');
    H.limit.hidden = !sp?.limit;
    if (sp?.limit && shown.limit !== String(sp.limit)) { set('limit', H.limitN, String(sp.limit)); H.limit.title = t('Speed limit {n} km/h', { n: sp.limit }); }
    // the profile can run a touch faster than the route's estimate (k < 1): never show more than the posted limit
    set('speed', H.speed, String(Math.round(Math.min(kmh(v), sp?.limit ?? Infinity))));
    // remaining distance on the route card's scale, time on the route's own estimate
    const remD = Math.max(0, p.total - s) * (p.dist / p.total), remT = Math.max(0, p.physTime - tp) * p.k;
    set('eta', H.eta, arrived ? t('Arrived') : t('Arrive {time}', { time: clock(Math.round((Date.now() + remT * 1000) / 60000) * 60000) }));
    set('sub', H.sub, arrived ? fmtDist(p.dist) : `${fmtTime(remT)} · ${fmtDist(remD)}`);
    if (document.activeElement !== progress) progress.value = String(Math.round((s / p.total) * 1000));
    if (shown.vt !== shown.sub) { shown.vt = shown.sub; progress.setAttribute('aria-valuetext', shown.sub); }
  }
  function controls() {
    const pb = $<HTMLButtonElement>('.nav-play'), lab = playing ? t('Pause') : t('Play');
    pb.innerHTML = playing ? I.pause : I.play; pb.title = lab; pb.setAttribute('aria-label', lab);
    el.querySelectorAll<HTMLElement>('[data-speed]').forEach((b) => { const on = +b.dataset.speed! === speed; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    const vb = $<HTMLButtonElement>('.nav-voice'), ok = voice.available();
    vb.innerHTML = voice.on && ok ? I.voiceOn : I.voiceOff;
    vb.disabled = !ok;
    vb.setAttribute('aria-pressed', String(voice.on && ok));
    const vl = !ok ? t('No voice for this language on this device') : voice.on ? t('Voice guidance on') : t('Voice guidance off');
    vb.title = vl; vb.setAttribute('aria-label', vl);
  }

  // ---------------------------------------------------------------- voice
  const voice = {
    on: (() => { try { return localStorage.getItem('atlas:navVoice') === '1'; } catch { return false; } })(),
    said: new Map<number, number>(), // maneuver → 1 far prompt said, 2 near prompt said
    pick(): SpeechSynthesisVoice | null {
      if (typeof speechSynthesis === 'undefined') return null;
      const want = ({ en: 'en', ko: 'ko', ru: 'ru' } as Record<string, string>)[getLang()] ?? 'en';
      const vs = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(want));
      return vs.find((v) => v.default) ?? vs.find((v) => /premium|enhanced|natural/i.test(v.name)) ?? vs[0] ?? null;
    },
    available() { return !!this.pick(); },
    /** urgent prompts cut whatever is still being said; early ones wait their turn */
    say(text: string, urgent = true) {
      const v = this.pick();
      if (!this.on || !v || !text) return;
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v; u.lang = v.lang; u.rate = speed >= 5 ? 1.15 : 1.02;
      speechSynthesis.speak(u);
    },
    stop() { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); },
  };
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener?.('voiceschanged', () => { if (!el.hidden) controls(); });
  /** "turn left onto X" inside a sentence: English and Russian lower the first letter, Korean has none */
  const inner = (s: string) => (getLang() === 'ko' ? s : s.charAt(0).toLocaleLowerCase(locale()) + s.slice(1));
  const spokenDist = (m: number) => (m >= 950 ? { key: 'In {n} kilometers, {instruction}', n: Math.round(m / 100) / 10 } : { key: 'In {n} meters, {instruction}', n: m >= 300 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50) });
  const phrase = (m: Maneuver) => (m.man === 'arrive' ? t('You will arrive at your destination') : m.text);
  function speak(s: number, v: number) {
    const p = plan!, mi = nextManeuver(p, s), m = p.maneuvers[mi], toMan = m.at - s;
    if (s >= p.total - 0.5) { if (voice.said.get(-1) !== 2) { voice.said.set(-1, 2); voice.say(t('You have arrived')); } return; }
    const vs = Math.max(kmh(v) / 3.6, 8), state = voice.said.get(mi) ?? 0;
    const near = Math.max(45, vs * 7), far = vs > 20 ? 1000 : vs > 13 ? 500 : 300;
    const gap = m.at - (p.maneuvers[mi - 1]?.at ?? 0);
    if (state < 2 && toMan <= near) {
      voice.said.set(mi, 2);
      const n2 = p.maneuvers[mi + 1];
      const first = phrase(m), both = n2 && n2.at - m.at < 150 && (TURNS.test(n2.man) || n2.man === 'arrive');
      if (both) voice.said.set(mi + 1, Math.max(1, voice.said.get(mi + 1) ?? 0)); // already announced: skip its early prompt
      voice.say(both ? t('{first}, then {second}', { first, second: inner(phrase(n2)) }) : first);
    } else if (state < 1 && toMan <= far && toMan > near * 1.6 && gap > far * 0.6 && speed < 5) {
      voice.said.set(mi, 1);
      const sd = spokenDist(toMan);
      voice.say(t(sd.key, { n: sd.n, instruction: inner(phrase(m)) }), false);
    }
  }
  /** after a jump: maneuvers already behind count as said */
  function resetSaid(s: number) {
    voice.said.clear();
    plan!.maneuvers.forEach((m, i) => { if (m.at <= s) voice.said.set(i, 2); });
    voice.stop();
  }

  // ---------------------------------------------------------------- loop
  let lastIdle = '';
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    // long gaps (a hidden tab) don't jump the car; slow devices still drive in real time
    const dt = Math.min(0.25, (now - last) / 1000); last = now;
    const p = plan!;
    if (playing && !entering) tp = Math.min(p.physTime, tp + (dt * speed) / p.k);
    const { s, v } = stateAt(p, tp);
    if (playing && s >= p.total - 0.5) { playing = false; tp = p.physTime; controls(); }
    const moved = camera(s, v, dt, false);
    // paused with the camera settled: nothing changes but the arrival clock, once a minute
    const idle = `${tp},${moved},${Math.floor(Date.now() / 60000)}`;
    if (!playing && !moved && idle === lastIdle) return;
    lastIdle = idle;
    hud(s, v);
    drawProgress(s);
    drawTurn(nextManeuver(p, s), p.maneuvers[nextManeuver(p, s)].at - s);
    if (playing || s >= p.total - 0.5) speak(s, v);
  }
  function seekTo(s: number) {
    const p = plan!;
    tp = timeAt(p, Math.max(0, Math.min(p.total, s)));
    const st = stateAt(p, tp);
    resetSaid(st.s);
    camera(st.s, st.v, 0, true);
    turnFor = -2;
  }

  // ---------------------------------------------------------------- open / close
  function start(r: Route, destination: string): boolean {
    const p = buildPlan(r);
    if (!p) return false;
    if (plan) stop(false);
    plan = p; dest = destination; settling = false;
    const id = ++session;
    for (const k of Object.keys(shown)) delete shown[k];
    back = document.activeElement as HTMLElement | null;
    saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    d.onOpen();
    el.hidden = false; document.body.classList.add('nav-on');
    addLayers(p);
    tp = 0; follow = true; turnFor = -2; gradF = -1; playing = true;
    $('.nav-recenter').hidden = true;
    voice.said.clear();
    // face along the first stretch, then fly in before driving off
    camB = bearing(p, 0, Math.min(p.total, 60)); puckB = bearing(p, 0, Math.min(p.total, 8)); camZ = 17.6;
    const at = pointAt(p, 0).xy;
    puck.setLngLat(toLngLat(at[0], at[1])).setRotation(puckB).addTo(map);
    entering = true;
    // iOS only lets a page speak after speech starts inside a tap: start (silently) now, while the click is live
    if (voice.on && voice.available()) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.flyTo({ center: toLngLat(at[0], at[1]), bearing: camB, zoom: camZ, pitch: pitch(), padding: padding(), duration: reduce ? 0 : 1600, essential: true });
    const go = () => { if (id !== session || !plan) return; entering = false; if (p.maneuvers[0].at > 150) voice.say(r.legs[0].steps[0]?.text ?? ''); };
    if (reduce) go(); else map.once('moveend', go);
    controls();
    last = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    window.addEventListener('keydown', onKey);
    ($('.nav-play') as HTMLButtonElement).focus({ preventScroll: true });
    return true;
  }
  function stop(restore = true) {
    if (!plan) return;
    cancelAnimationFrame(raf); raf = 0; session++;
    voice.stop();
    puck.remove(); removeLayers();
    plan = null; playing = false; entering = false;
    el.hidden = true; document.body.classList.remove('nav-on');
    window.removeEventListener('keydown', onKey);
    if (restore && saved) map.easeTo({ ...saved, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 900 });
    else map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    saved = null;
    d.onClose();
    if (back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }

  // ---------------------------------------------------------------- input
  const togglePlay = () => {
    if (!plan) return;
    if (!playing && tp >= plan.physTime) { tp = 0; resetSaid(0); }
    playing = !playing;
    if (!playing) voice.stop();
    controls();
  };
  const skip = () => {
    const p = plan!, s = stateAt(p, tp).s;
    // to a few seconds before the next maneuver that isn't right here; always forward
    const m = p.maneuvers.find((x) => x.at > s + 20) ?? p.maneuvers[p.maneuvers.length - 1];
    const lead = Math.max(80, Math.min(300, (spanAt(p, m.at - 1)?.v ?? 14) * 8));
    seekTo(Math.min(p.total, Math.max(s + 0.5 * (m.at - s), m.at - lead)));
  };
  function onKey(e: KeyboardEvent) {
    if (!plan || (e.target as HTMLElement).matches?.('input:not([type=range]), textarea')) return;
    if (e.key === ' ' && !(e.target as HTMLElement).matches?.('button')) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' && (e.target as HTMLElement) !== progress) { e.preventDefault(); skip(); }
    else if (e.key === 'Escape') stop();
  }
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || !plan) return;
    if (b.classList.contains('nav-exit')) return stop();
    if (b.classList.contains('nav-play')) return togglePlay();
    if (b.classList.contains('nav-restart')) { seekTo(0); playing = true; controls(); return; }
    if (b.classList.contains('nav-skip')) return skip();
    if (b.classList.contains('nav-recenter')) {
      // glide back to the car, then follow again
      b.hidden = true; follow = true; camKey = ''; settling = true;
      const at = pointAt(plan, stateAt(plan, tp).s).xy, id = session;
      map.easeTo({ center: toLngLat(at[0], at[1]), bearing: camB, zoom: camZ, pitch: pitch(), padding: padding(), duration: 600 });
      map.once('moveend', () => { if (id === session) settling = false; });
      return;
    }
    if (b.dataset.speed) { speed = +b.dataset.speed; controls(); return; }
    if (b.classList.contains('nav-voice')) {
      voice.on = !voice.on;
      try { localStorage.setItem('atlas:navVoice', voice.on ? '1' : '0'); } catch { /* private mode */ }
      controls();
      if (voice.on && !entering) { const s = stateAt(plan, tp).s, m = plan.maneuvers[nextManeuver(plan, s)]; voice.say(s >= plan.total - 0.5 ? t('You have arrived') : t(spokenDist(m.at - s).key, { n: spokenDist(m.at - s).n, instruction: inner(phrase(m)) })); }
      else voice.stop();
    }
  });
  progress.addEventListener('input', () => { if (plan) seekTo((+progress.value / 1000) * plan.total); });
  progress.addEventListener('change', () => progress.blur());
  // moving the map yourself pauses the follow camera until Re-center
  const userMove = (e: { originalEvent?: unknown }) => { if (plan && e.originalEvent && !entering) { settling = false; follow = false; $('.nav-recenter').hidden = false; } };
  for (const ev of ['dragstart', 'zoomstart', 'rotatestart', 'pitchstart'] as const) map.on(ev, userMove);

  return {
    start, stop: () => stop(), isActive: () => !!plan,
    relang() { applyStatic(el); for (const k of Object.keys(shown)) delete shown[k]; clockAt = 0; if (plan) controls(); },
  };
}

/** White arrowhead with a dark edge, pointing north (rotated to the road by the layer). */
function arrowHead(): ImageData {
  const n = 64, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.beginPath(); g.moveTo(n / 2, 6); g.lineTo(n - 8, n - 14); g.lineTo(8, n - 14); g.closePath();
  g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#0b3d91'; g.stroke();
  g.fillStyle = '#ffffff'; g.fill();
  return g.getImageData(0, 0, n, n);
}
