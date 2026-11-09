// Draws a schematic layout as SVG: rounded octilinear lines with casings,
// Seoul-style station markers (dots, interchange rings and capsules), terminus
// badges, and station names placed to avoid lines, markers and each other.
// Pure (string output), so the page and tools/schematic-check.ts share it.
import { layoutSchematic, type SchemLayout, type SchemInput, type LayoutParams, type SLine, type Pt, type Marker } from './schematic';

/** px per grid unit (station spacing): set per city from its name lengths, see useLayout */
export let CELL = 64;
const U = 40; // size unit for strokes, markers and text, independent of spacing
export interface RenderOpts { theme: 'light' | 'dark'; /** colour labels that still collide (review tool) */ debug?: boolean }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f = (v: number) => (Math.round(v * 10) / 10).toString();

/** approximate rendered width of `s` at font size `size` (Pretendard semibold) */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3040 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ? 0.93
      : ch === ' ' ? 0.27 : /[A-Z]/.test(ch) ? 0.67 : /[0-9]/.test(ch) ? 0.58 : /[iljI.,'|!:;()]/.test(ch) ? 0.3 : /[mwMW]/.test(ch) ? 0.85 : 0.55;
  }
  return w * size;
}
export function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#202124' : '#ffffff';
}

const WRAP = 118; // px: longer names break onto two lines
/** a station name as one or two lines (split at the space nearest the middle) */
export function wrapName(name: string, size: number): string[] {
  if (textWidth(name, size) <= WRAP || !name.includes(' ')) return [name];
  const words = name.split(' ');
  let best = [name], bw = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(textWidth(a, size), textWidth(b, size));
    if (w < bw) { bw = w; best = [a, b]; }
  }
  return best;
}
/** spacing for this city: wide enough for its typical name, so labels fit between stations */
export function useLayout(L: SchemLayout) {
  const ws = L.stations.filter((s) => s.name).map((s) => Math.max(...wrapName(s.name, 12).map((t) => textWidth(t, 12)))).sort((a, b) => a - b);
  const p70 = ws.length ? ws[Math.floor(ws.length * 0.7)] : 50;
  CELL = Math.round(Math.min(160, Math.max(64, p70 * 1.05 + 14)));
  return CELL;
}

/** a polyline as an SVG path with rounded corners */
function rounded(pts: Pt[], r: number, closed = false): string {
  const p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.01);
  if (p.length < 2) return '';
  // drop vertices that don't turn, so corners are rounded with the full radius
  const s: Pt[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = s[s.length - 1], b = p[i], c = p[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) > 1e-6 || dot < 0) s.push(b);
  }
  s.push(p[p.length - 1]);
  let d = `M${f(s[0][0])} ${f(s[0][1])}`;
  for (let i = 1; i < s.length - 1; i++) {
    const a = s[i - 1], b = s[i], c = s[i + 1];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const k = Math.min(r, l1 / 2, l2 / 2);
    const p1: Pt = [b[0] + ((a[0] - b[0]) / l1) * k, b[1] + ((a[1] - b[1]) / l1) * k];
    const p2: Pt = [b[0] + ((c[0] - b[0]) / l2) * k, b[1] + ((c[1] - b[1]) / l2) * k];
    d += `L${f(p1[0])} ${f(p1[1])}Q${f(b[0])} ${f(b[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  d += `L${f(s[s.length - 1][0])} ${f(s[s.length - 1][1])}`;
  return closed ? d + 'Z' : d;
}

/** points of a line, hop after hop, in px */
export function linePoints(l: SLine, from = 0, to = l.hops.length): Pt[] {
  const out: Pt[] = [];
  for (const h of l.hops.slice(from, to)) for (const [x, y] of h.pts) out.push([x * CELL, y * CELL]);
  return out;
}
export const linePath = (l: SLine, from = 0, to = l.hops.length) => rounded(linePoints(l, from, to), U * 0.75);
const WIDTH: Record<string, number> = { train: 0.17, metro: 0.15, monorail: 0.14, tram: 0.11, ferry: 0.1, cablecar: 0.07, bus: 0.075 };
export const lineWidth = (mode: string) => (WIDTH[mode] ?? 0.12) * U;

// ------------------------------------------------------------------ label placement (oriented boxes, SAT)
interface Box { cx: number; cy: number; hw: number; hh: number; a: number }
function overlap(p: Box, q: Box) {
  const axes = [p.a, p.a + Math.PI / 2, q.a, q.a + Math.PI / 2];
  for (const ax of axes) {
    const ux = Math.cos(ax), uy = Math.sin(ax);
    const proj = (b: Box) => { const c = b.cx * ux + b.cy * uy; const r = Math.abs(b.hw * Math.cos(b.a - ax)) + Math.abs(b.hh * Math.sin(b.a - ax)); return [c - r, c + r]; };
    const [a0, a1] = proj(p), [b0, b1] = proj(q);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}
class Index {
  private m = new Map<string, Box[]>();
  constructor(private s = U * 2) {}
  private keys(b: Box) {
    const r = Math.hypot(b.hw, b.hh), out: string[] = [];
    for (let x = Math.floor((b.cx - r) / this.s); x <= Math.floor((b.cx + r) / this.s); x++) for (let y = Math.floor((b.cy - r) / this.s); y <= Math.floor((b.cy + r) / this.s); y++) out.push(x + ',' + y);
    return out;
  }
  add(b: Box) { for (const k of this.keys(b)) { const l = this.m.get(k); if (l) l.push(b); else this.m.set(k, [b]); } }
  hits(b: Box) { const seen = new Set<Box>(); let n = 0; for (const k of this.keys(b)) for (const o of this.m.get(k) ?? []) if (!seen.has(o)) { seen.add(o); if (overlap(b, o)) n++; } return n; }
}
const segBox = (a: Pt, b: Pt, half: number): Box => ({ cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, hw: Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, hh: half, a: Math.atan2(b[1] - a[1], b[0] - a[0]) });
const markerBox = (m: Marker, pad: number): Box => m.kind === 'pill'
  ? segBox([m.x1 * CELL, m.y1 * CELL], [m.x2 * CELL, m.y2 * CELL], U * 0.19 + pad)
  : { cx: m.x * CELL, cy: m.y * CELL, hw: (m.kind === 'ring' ? m.r * CELL + U * 0.19 : U * 0.13) + pad, hh: (m.kind === 'ring' ? m.r * CELL + U * 0.19 : U * 0.13) + pad, a: 0 };

export interface PlacedLabel { lines: string[]; station: number; x: number; y: number; anchor: 'start' | 'middle' | 'end'; rot: number; size: number; bold: boolean; box: Box; /** collisions left: lines/markers, other labels */ hits: [number, number] }
export interface Badge { line: number; x: number; y: number; w: number; h: number; text: string; color: string }

export function placeLabels(L: SchemLayout): { labels: PlacedLabel[]; badges: Badge[] } {
  useLayout(L);
  const obstacles = new Index(), placed = new Index();
  for (const l of L.lines) {
    const pts = linePoints(l), half = lineWidth(l.mode) / 2 + 1;
    for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) > 0.5) obstacles.add(segBox(pts[i - 1], pts[i], half));
  }
  for (const s of L.stations) obstacles.add(markerBox(s.marker, 1));
  const byIdL = new Map(L.stations.map((s) => [s.id, s]));
  for (const k of L.links) { const a = byIdL.get(k.a), b = byIdL.get(k.b); if (a && b) obstacles.add(segBox([a.x * CELL, a.y * CELL], [b.x * CELL, b.y * CELL], U * 0.12)); }
  const labels: PlacedLabel[] = [];
  const order = [...L.stations].filter((s) => s.name).sort((a, b) => Number(b.transfer) - Number(a.transfer) || Number(b.key) - Number(a.key) || a.y - b.y || a.x - b.x);
  for (const s of order) {
    const bold = s.transfer;
    let size = CELL * (bold ? 0.32 : 0.3);
    const m = s.marker, mb = markerBox(m, 0);
    const reach = Math.max(mb.hw, mb.hh) + U * 0.16;
    const cx = s.x * CELL, cy = s.y * CELL;
    let best: PlacedLabel | null = null, bestCost = Infinity;
    for (const shrink of [1, 0.86]) {
      const sz = size * shrink, txt = wrapName(s.name, sz), tw = Math.max(...txt.map((t) => textWidth(t, sz))), th = sz * 1.18 * txt.length;
      const dirs = new Set(s.dirs);
      const pref = (k: string) => {
        // prefer the side away from the track: above/below a horizontal run, beside a vertical one
        const h = dirs.has(0), v = dirs.has(2), d1 = dirs.has(1), d3 = dirs.has(3);
        let c = 0;
        if ((k === 'E' || k === 'W') && h) c += 2;
        if ((k === 'N' || k === 'S') && v) c += 2;
        if ((k === 'NE' || k === 'SW') && d1) c += 2;
        if ((k === 'NW' || k === 'SE') && d3) c += 2;
        if ((k === 'E' || k === 'W' || k === 'N' || k === 'S') && (d1 || d3) && !h && !v) c += 1;
        if (k === 'W') c += 0.25;
        if (k.length === 2) c += 0.6;
        if (k.startsWith('R')) c += txt.length > 1 ? 99 : 3.5;
        return c;
      };
      const c45 = Math.SQRT1_2;
      const cands: [string, number, number, 'start' | 'middle' | 'end', number][] = [
        ['E', cx + reach, cy, 'start', 0], ['W', cx - reach, cy, 'end', 0],
        ['N', cx, cy - reach - th * 0.5, 'middle', 0], ['S', cx, cy + reach + th * 0.5, 'middle', 0],
        ['NE', cx + reach * c45, cy - reach * c45 - th * 0.3, 'start', 0], ['NW', cx - reach * c45, cy - reach * c45 - th * 0.3, 'end', 0],
        ['SE', cx + reach * c45, cy + reach * c45 + th * 0.35, 'start', 0], ['SW', cx - reach * c45, cy + reach * c45 + th * 0.35, 'end', 0],
        ['RNE', cx + reach * c45, cy - reach * c45, 'start', -45], ['RSE', cx + reach * c45, cy + reach * c45, 'start', 45],
        ['RNW', cx - reach * c45, cy - reach * c45, 'end', 45], ['RSW', cx - reach * c45, cy + reach * c45, 'end', -45],
      ];
      for (const [k, x, y, anchor, rot] of cands) {
        const a = (rot * Math.PI) / 180;
        const dirx = anchor === 'start' ? 1 : anchor === 'end' ? -1 : 0;
        const bx = x + Math.cos(a) * dirx * tw / 2, by = y + Math.sin(a) * dirx * tw / 2;
        const box: Box = { cx: bx, cy: by, hw: tw / 2 + 2, hh: th / 2, a };
        let cost = pref(k) + (shrink < 1 ? 3 : 0);
        cost += obstacles.hits(box) * 14 + placed.hits(box) * 40;
        if (cost < bestCost) { bestCost = cost; best = { lines: txt, station: s.id, x, y, anchor, rot, size: sz, bold, box, hits: [obstacles.hits(box), placed.hits(box)] }; }
      }
      if (bestCost < 10) break;
    }
    if (best) { labels.push(best); placed.add(best.box); }
  }

  // terminus badges with the line's name, where there's room
  const badges: Badge[] = [];
  const st = new Map(L.stations.map((s) => [s.id, s]));
  for (const l of L.lines) {
    if (l.loop || !l.hops.length) continue;
    const ends: [number, Pt, Pt][] = [];
    const h0 = l.hops[0], hl = l.hops[l.hops.length - 1];
    ends.push([h0.a, h0.pts[0], h0.pts[1]]);
    ends.push([hl.b, hl.pts[hl.pts.length - 1], hl.pts[hl.pts.length - 2]]);
    for (const [sid, p, q] of ends) {
      const s = st.get(sid);
      if (!s || !q) continue;
      const size = U * 0.27, w = textWidth(l.name, size) + U * 0.36, h = U * 0.44;
      const dx = p[0] - q[0], dy = p[1] - q[1], dl = Math.hypot(dx, dy) || 1;
      const ux = dx / dl, uy = dy / dl;
      const mb = markerBox(s.marker, 0), reach = Math.max(mb.hw, mb.hh) / CELL + 0.25;
      for (const [vx, vy] of [[ux, uy], [-uy, ux], [uy, -ux]]) {
        // the badge's near edge sits `reach` beyond the station, along (vx, vy)
        const ext = Math.abs(vx) * w / 2 + Math.abs(vy) * h / 2;
        const bx = s.x * CELL + vx * (reach * CELL + ext), by = s.y * CELL + vy * (reach * CELL + ext);
        const box: Box = { cx: bx, cy: by, hw: w / 2 + 2, hh: h / 2 + 2, a: 0 };
        if (obstacles.hits(box) || placed.hits(box)) continue;
        placed.add(box); badges.push({ line: l.id, x: bx, y: by, w, h, text: l.name, color: l.color });
        break;
      }
    }
  }
  return { labels, badges };
}

/** extent of lines, markers, labels and badges, with a margin */
export function drawnBounds(L: SchemLayout, labels: PlacedLabel[], badges: Badge[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const l of L.lines) for (const p of linePoints(l)) add(p[0], p[1]);
  for (const s of L.stations) add(s.x * CELL, s.y * CELL);
  for (const { box: q } of labels) { const r = Math.hypot(q.hw, q.hh); const ca = Math.abs(Math.cos(q.a)), sa = Math.abs(Math.sin(q.a)); const ex = q.hw * ca + q.hh * sa, ey = q.hw * sa + q.hh * ca; void r; add(q.cx - ex, q.cy - ey); add(q.cx + ex, q.cy + ey); }
  for (const g of badges) { add(g.x - g.w / 2, g.y - g.h / 2); add(g.x + g.w / 2, g.y + g.h / 2); }
  const m = U * 0.8;
  return [x0 - m, y0 - m, x1 + m, y1 + m];
}

export function renderSchematic(L: SchemLayout, o: RenderOpts): string {
  const dark = o.theme === 'dark';
  const bg = dark ? '#1f2023' : '#ffffff', ink = dark ? '#e8eaed' : '#1f1f1f';
  const { labels, badges } = placeLabels(L);
  const b = drawnBounds(L, labels, badges);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="sm-svg" viewBox="${f(b[0])} ${f(b[1])} ${f(b[2] - b[0])} ${f(b[3] - b[1])}" width="${f(b[2] - b[0])}" height="${f(b[3] - b[1])}" font-family="Pretendard, 'Apple SD Gothic Neo', sans-serif">`);
  parts.push(`<rect class="sm-bg" x="${f(b[0])}" y="${f(b[1])}" width="${f(b[2] - b[0])}" height="${f(b[3] - b[1])}" fill="${bg}"/>`);
  // casings first (bg colour) so crossings read clearly, then the lines
  const order = [...L.lines].reverse(); // busiest modes on top
  parts.push('<g class="sm-casings" fill="none" stroke-linecap="round" stroke-linejoin="round">');
  for (const l of order) parts.push(`<path d="${linePath(l)}" stroke="${bg}" stroke-width="${f(lineWidth(l.mode) + 5)}"/>`);
  parts.push('</g><g class="sm-lines" fill="none" stroke-linecap="round" stroke-linejoin="round">');
  for (const l of order) {
    const dash = l.mode === 'ferry' ? ` stroke-dasharray="${f(U * 0.32)} ${f(U * 0.2)}"` : l.mode === 'cablecar' ? ` stroke-dasharray="${f(U * 0.12)} ${f(U * 0.12)}"` : '';
    parts.push(`<path class="sm-line" data-line="${l.id}" d="${linePath(l)}" stroke="${l.color}" stroke-width="${f(lineWidth(l.mode))}"${dash}/>`);
  }
  // walking transfers between nearby stations: a slim capsule under the markers
  parts.push('</g><g class="sm-links" stroke-linecap="round">');
  const sts = new Map(L.stations.map((s) => [s.id, s]));
  for (const k of L.links) {
    const a = sts.get(k.a), b = sts.get(k.b);
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > 2.6) continue; // only draw links that stayed short
    const xy = `x1="${f(a.x * CELL)}" y1="${f(a.y * CELL)}" x2="${f(b.x * CELL)}" y2="${f(b.y * CELL)}"`;
    parts.push(`<g class="sm-link" data-a="${k.a}" data-b="${k.b}"><line ${xy} stroke="${ink}" stroke-width="${f(U * 0.22)}"/><line ${xy} stroke="${bg}" stroke-width="${f(U * 0.1)}"/></g>`);
  }
  parts.push('</g><g class="sm-stations">');
  for (const s of L.stations) {
    const m = s.marker, cls = `sm-st${s.transfer ? ' x' : ''}`;
    if (m.kind === 'dot') parts.push(`<circle class="${cls}" data-station="${s.id}" cx="${f(m.x * CELL)}" cy="${f(m.y * CELL)}" r="${f(U * 0.12)}" fill="${bg}" stroke="${m.color}" stroke-width="${f(U * 0.06)}"/>`);
    else if (m.kind === 'ring') parts.push(`<circle class="${cls}" data-station="${s.id}" cx="${f(m.x * CELL)}" cy="${f(m.y * CELL)}" r="${f(m.r * CELL + U * 0.17)}" fill="${bg}" stroke="${ink}" stroke-width="${f(U * 0.065)}"/>`);
    else parts.push(`<g class="${cls}" data-station="${s.id}"><line x1="${f(m.x1 * CELL)}" y1="${f(m.y1 * CELL)}" x2="${f(m.x2 * CELL)}" y2="${f(m.y2 * CELL)}" stroke="${ink}" stroke-width="${f(U * 0.37)}" stroke-linecap="round"/><line x1="${f(m.x1 * CELL)}" y1="${f(m.y1 * CELL)}" x2="${f(m.x2 * CELL)}" y2="${f(m.y2 * CELL)}" stroke="${bg}" stroke-width="${f(U * 0.24)}" stroke-linecap="round"/></g>`);
  }
  parts.push('</g><g class="sm-badges">');
  for (const b of badges) parts.push(`<g class="sm-badge" data-line="${b.line}"><rect x="${f(b.x - b.w / 2)}" y="${f(b.y - b.h / 2)}" width="${f(b.w)}" height="${f(b.h)}" rx="${f(b.h / 2)}" fill="${b.color}"/><text x="${f(b.x)}" y="${f(b.y)}" dy="0.35em" text-anchor="middle" font-size="${f(U * 0.27)}" font-weight="700" fill="${textOn(b.color)}">${esc(b.text)}</text></g>`);
  parts.push(`</g><g class="sm-labels" fill="${ink}" stroke="${bg}" stroke-width="${f(U * 0.11)}" stroke-linejoin="round" paint-order="stroke">`);
  const byId = new Map(L.stations.map((s) => [s.id, s]));
  for (const lb of labels) {
    const s = byId.get(lb.station)!;
    const rot = lb.rot ? ` transform="rotate(${lb.rot} ${f(lb.x)} ${f(lb.y)})"` : '';
    const body = lb.lines.length === 1 ? esc(s.name) : lb.lines.map((t, i) => `<tspan x="${f(lb.x)}" dy="${i ? '1.18em' : '-0.24em'}">${esc(t)}</tspan>`).join('');
    parts.push(`<text class="sm-label" data-station="${s.id}" x="${f(lb.x)}" y="${f(lb.y)}" dy="${lb.lines.length === 1 ? '0.35em' : '0'}" text-anchor="${lb.anchor}" font-size="${f(lb.size)}" font-weight="${lb.bold ? 700 : 600}"${rot}${o.debug && (lb.hits[0] || lb.hits[1]) ? ` fill="${lb.hits[1] ? '#d00' : '#e67e00'}"` : ''}>${body}</text>`);
  }
  parts.push('</g></svg>');
  return parts.join('');
}

// ------------------------------------------------------------------ pick the most readable of a few layouts
const VARIANTS: Partial<LayoutParams>[] = [
  {}, { diag: 1.6 }, { diag: 1.6, near: 1.8 }, { geo: 0.3 }, { geo: 0.9 }, { near: 0.5 }, { diag: 1.4, geo: 0.35, near: 1.6 }, { diag: 1.1, near: 1.5 },
];
/** readability score (lower is better): label conflicts, bends, fallbacks, stretched walking links */
export function scoreLayout(L: SchemLayout): number {
  const { labels } = placeLabels(L);
  const st = new Map(L.stations.map((s) => [s.id, s]));
  let stretch = 0;
  for (const k of L.links) { const a = st.get(k.a), b = st.get(k.b); if (a && b) stretch += Math.max(0, Math.hypot(a.x - b.x, a.y - b.y) - 1.5); }
  return labels.filter((l) => l.hits[0]).length * 3 + labels.filter((l) => l.hits[1]).length * 10 + labels.filter((l) => l.rot).length * 3
    + L.bends * 0.25 + L.fallbacks * 30 + stretch * 3 + L.length * 0.08;
}
export function bestSchematic(input: SchemInput, modes: string[]): SchemLayout & { score: number; variant: number } {
  let best: (SchemLayout & { score: number; variant: number }) | null = null;
  VARIANTS.forEach((v, i) => {
    const L = layoutSchematic(input, modes, v);
    const sc = L.lines.length ? scoreLayout(L) : 0;
    if (!best || sc < best.score) best = { ...L, score: sc, variant: i };
  });
  return best!;
}
