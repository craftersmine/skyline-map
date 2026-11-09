import type { Map as MLMap } from 'maplibre-gl';

// Pictograms drawn on a 24-unit grid, white on a coloured badge.
const GLYPHS: Record<string, (c: CanvasRenderingContext2D) => void> = {
  cross: (c) => { c.fillRect(10, 6, 4, 12); c.fillRect(6, 10, 12, 4); },
  cap: (c) => { c.beginPath(); c.moveTo(12, 6); c.lineTo(20, 10); c.lineTo(12, 14); c.lineTo(4, 10); c.closePath(); c.fill(); c.fillRect(7.5, 12, 9, 4.5); c.fillRect(18.6, 10, 1.4, 6); },
  shield: (c) => { c.beginPath(); c.moveTo(12, 5); c.lineTo(18.5, 7.5); c.quadraticCurveTo(18.5, 15.5, 12, 19); c.quadraticCurveTo(5.5, 15.5, 5.5, 7.5); c.closePath(); c.fill(); },
  flame: (c) => { c.beginPath(); c.moveTo(12, 4.5); c.bezierCurveTo(16, 9, 18, 11.5, 18, 14.2); c.bezierCurveTo(18, 17.6, 15.3, 19.5, 12, 19.5); c.bezierCurveTo(8.7, 19.5, 6, 17.6, 6, 14.2); c.bezierCurveTo(6, 11.8, 8, 10.4, 9.2, 8.8); c.bezierCurveTo(9.6, 10.6, 10.4, 11.4, 11.2, 11.6); c.bezierCurveTo(11, 9, 11.3, 6.8, 12, 4.5); c.fill(); },
  star: (c) => { c.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? 3.4 : 7.6, a = -Math.PI / 2 + (i * Math.PI) / 5; c.lineTo(12 + r * Math.cos(a), 12.6 + r * Math.sin(a)); } c.closePath(); c.fill(); },
  tree: (c) => { c.beginPath(); c.arc(12, 10, 5.4, 0, Math.PI * 2); c.fill(); c.fillRect(11, 13, 2, 6.5); },
  mountain: (c) => { c.beginPath(); c.moveTo(3.5, 18.5); c.lineTo(9.5, 8); c.lineTo(13, 13.5); c.lineTo(15.5, 10.5); c.lineTo(20.5, 18.5); c.closePath(); c.fill(); },
  plane: (c) => { c.beginPath(); c.moveTo(12, 3.8); c.quadraticCurveTo(13.4, 4.2, 13.4, 7); c.lineTo(13.4, 10.2); c.lineTo(20, 14); c.lineTo(20, 15.8); c.lineTo(13.4, 13.6); c.lineTo(13.4, 17.2); c.lineTo(15.4, 18.8); c.lineTo(15.4, 20.2); c.lineTo(12, 19.2); c.lineTo(8.6, 20.2); c.lineTo(8.6, 18.8); c.lineTo(10.6, 17.2); c.lineTo(10.6, 13.6); c.lineTo(4, 15.8); c.lineTo(4, 14); c.lineTo(10.6, 10.2); c.lineTo(10.6, 7); c.quadraticCurveTo(10.6, 4.2, 12, 3.8); c.fill(); },
  factory: (c) => { c.beginPath(); c.moveTo(4.5, 19); c.lineTo(4.5, 10); c.lineTo(9, 13); c.lineTo(9, 10); c.lineTo(13.5, 13); c.lineTo(13.5, 6); c.lineTo(17, 6); c.lineTo(17, 13); c.lineTo(19.5, 13); c.lineTo(19.5, 19); c.closePath(); c.fill(); },
  ball: (c) => { c.lineWidth = 1.8; c.beginPath(); c.arc(12, 12, 6.2, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.moveTo(5.8, 12); c.lineTo(18.2, 12); c.moveTo(12, 5.8); c.quadraticCurveTo(8, 12, 12, 18.2); c.moveTo(12, 5.8); c.quadraticCurveTo(16, 12, 12, 18.2); c.stroke(); },
  train: (c) => { rr(c, 7, 4.5, 10, 12, 2.5); c.fill(); c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(8.6, 6.5, 6.8, 4); c.fillStyle = '#fff'; c.beginPath(); c.moveTo(8.5, 17); c.lineTo(6.5, 20); c.lineTo(8.3, 20); c.lineTo(10, 17.5); c.moveTo(15.5, 17); c.lineTo(17.5, 20); c.lineTo(15.7, 20); c.lineTo(14, 17.5); c.fill(); },
  metro: (c) => { c.font = 'bold 13px Pretendard, system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('M', 12, 12.8); },
  tram: (c) => { rr(c, 7.5, 6.5, 9, 11, 2.5); c.fill(); c.fillRect(11.3, 3.5, 1.4, 3); c.fillRect(8.5, 3.2, 7, 1.3); c.fillStyle = 'rgba(0,0,0,.28)'; c.fillRect(9, 8.3, 6, 3.5); c.fillStyle = '#fff'; c.fillRect(8.5, 18, 1.6, 2); c.fillRect(13.9, 18, 1.6, 2); },
  bus: (c) => { rr(c, 6.5, 5, 11, 12.5, 2.2); c.fill(); c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(8, 7, 8, 4.5); c.fillStyle = '#fff'; c.fillRect(7.5, 17.5, 2.2, 2.2); c.fillRect(14.3, 17.5, 2.2, 2.2); },
  ship: (c) => { c.beginPath(); c.moveTo(4.5, 13.5); c.lineTo(19.5, 13.5); c.lineTo(17, 18.5); c.lineTo(7, 18.5); c.closePath(); c.fill(); c.fillRect(8, 9.5, 8, 3); c.fillRect(11, 5.5, 2, 4); },
  cable: (c) => { c.lineWidth = 1.4; c.beginPath(); c.moveTo(3, 6); c.lineTo(21, 4); c.stroke(); c.fillRect(11.3, 5, 1.4, 4); rr(c, 7, 9, 10, 9, 2); c.fill(); },
  lock: (c) => { c.fillRect(7, 11, 10, 8); c.lineWidth = 2; c.beginPath(); c.arc(12, 10.5, 3.4, Math.PI, 0); c.stroke(); },
  cemetery: (c) => { c.fillRect(11, 5.5, 2, 13); c.fillRect(7.5, 9, 9, 2); },
  // toll booth: kiosk with a barrier arm
  toll: (c) => { c.fillRect(4.5, 7, 6, 11); c.fillStyle = 'rgba(0,0,0,.3)'; c.fillRect(6, 9, 3, 3); c.fillStyle = '#fff'; c.fillRect(10.5, 10, 9.5, 2.2); c.fillRect(18.5, 9, 1.5, 9); },
  dot: (c) => { c.beginPath(); c.arc(12, 12, 3.5, 0, Math.PI * 2); c.fill(); },
};

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

export const POI_STYLE: Record<string, { color: string; glyph: string; square?: boolean }> = {
  hospital: { color: '#e5534b', glyph: 'cross' },
  school: { color: '#7b61c9', glyph: 'cap' },
  campus: { color: '#7b61c9', glyph: 'cap' },
  police: { color: '#4f74d9', glyph: 'shield' },
  fire: { color: '#e5664b', glyph: 'flame' },
  prison: { color: '#7c8088', glyph: 'lock' },
  landmark: { color: '#11968f', glyph: 'star' },
  park: { color: '#34a05a', glyph: 'tree' },
  nature: { color: '#34a05a', glyph: 'mountain' },
  amusement: { color: '#34a05a', glyph: 'star' },
  zoo: { color: '#34a05a', glyph: 'tree' },
  sports: { color: '#34a05a', glyph: 'ball' },
  cemetery: { color: '#6f8f74', glyph: 'cemetery' },
  airport: { color: '#4a83e6', glyph: 'plane' },
  industry: { color: '#7c8088', glyph: 'factory' },
  train: { color: '#4f5d73', glyph: 'train', square: true },
  metro: { color: '#2f6fe0', glyph: 'metro', square: true },
  monorail: { color: '#2f6fe0', glyph: 'train', square: true },
  tram: { color: '#14957d', glyph: 'tram', square: true },
  ferry: { color: '#2f7fd6', glyph: 'ship', square: true },
  cablecar: { color: '#6a6f78', glyph: 'cable', square: true },
  bus: { color: '#2f6fe0', glyph: 'bus', square: true },
  toll: { color: '#d9822b', glyph: 'toll', square: true },
};

function badge(color: string, glyph: string, square: boolean, size: number, ring = '#ffffff'): ImageData {
  const pr = 2, px = size * pr;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const c = cv.getContext('2d')!;
  c.scale(pr, pr);
  const s = size / 24;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.25)'; c.shadowBlur = 1.5; c.shadowOffsetY = 0.5;
  c.fillStyle = ring;
  if (square) rr(c, 1, 1, size - 2, size - 2, size * 0.24); else { c.beginPath(); c.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2); }
  c.fill();
  c.restore();
  c.fillStyle = color;
  if (square) rr(c, 2.4, 2.4, size - 4.8, size - 4.8, size * 0.19); else { c.beginPath(); c.arc(size / 2, size / 2, size / 2 - 2.4, 0, Math.PI * 2); }
  c.fill();
  c.fillStyle = '#fff'; c.strokeStyle = '#fff';
  c.translate(size * 0.16, size * 0.16); c.scale(s * 0.68, s * 0.68);
  GLYPHS[glyph](c);
  return c.getImageData(0, 0, px, px);
}

export function addIcons(map: MLMap, stationColors: string[]) {
  const add = (id: string, img: ImageData) => { if (map.hasImage(id)) map.removeImage(id); map.addImage(id, img, { pixelRatio: 2 }); };
  for (const [k, v] of Object.entries(POI_STYLE)) {
    add('poi-' + k, badge(v.color, v.glyph, !!v.square, v.square ? 20 : 22));
    add('poi-sm-' + k, badge(v.color, v.glyph, !!v.square, 15));
  }
  for (const col of stationColors) {
    for (const m of ['train', 'metro', 'tram', 'monorail', 'ferry', 'cablecar']) add(`st-${m}-${col}`, badge(col, POI_STYLE[m].glyph, true, 20));
  }
  // one-way arrow, pointing along the line's drawing direction (east); rotated 180° for reversed segments
  {
    const a = document.createElement('canvas'); a.width = 36; a.height = 20;
    const g = a.getContext('2d')!;
    g.fillStyle = '#5c6370'; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(4, 8); g.lineTo(20, 8); g.lineTo(20, 3); g.lineTo(32, 10); g.lineTo(20, 17); g.lineTo(20, 12); g.lineTo(4, 12); g.closePath();
    g.stroke(); g.fill();
    add('oneway', g.getImageData(0, 0, 36, 20));
  }
  // small round stop marker used at high zoom on lines
  const cv = document.createElement('canvas'); cv.width = cv.height = 20;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#fff'; c.strokeStyle = '#4b5563'; c.lineWidth = 3; c.beginPath(); c.arc(10, 10, 7, 0, Math.PI * 2); c.fill(); c.stroke();
  add('stop-dot', c.getImageData(0, 0, 20, 20));
}

/** Badge as a data URL, used in the UI (search results, info panel). */
export function iconDataUrl(kind: string, color?: string): string {
  const v = POI_STYLE[kind] ?? { color: '#7c8088', glyph: 'dot' };
  const img = badge(color ?? v.color, v.glyph, !!v.square, 24);
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv.toDataURL();
}
