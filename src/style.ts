import { t } from './i18n';
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from 'maplibre-gl';

export type Theme = 'light' | 'dark';
export interface StyleOptions { theme: Theme; terrain: boolean; transit: boolean; bus: boolean; cycling: boolean; buildings3d: boolean; grid: boolean; labels: boolean; contours: boolean }

type E = ExpressionSpecification;

const PAL = {
  light: {
    outside: '#e4e2dd', land: '#eceee4', urban: '#f4f3f0', forest: '#d3e8c9', forestDense: '#c6e1ba', park: '#c8e7cc',
    water: '#a2cdf3', waterLine: '#8fc0ec', waterText: '#4d7fb3',
    lot: { residential: '#efeeea', residential_high: '#eceae6', commercial: '#fbf1e7', office: '#eef0f6', industrial: '#ebe9f1', education: '#efebf8', health: '#fde9e8', civic: '#ecedf1', landmark: '#f4ecdc', transport: '#e9eaef', park_building: '#cfe9d2', plaza: '#e3efdf', cemetery: '#d6e8d3', sports: '#cfe9d2', utility: '#e9e8e4', utility_open: '#e4e6e9', apron: '#d9dbe0', other: '#ecebe8' } as Record<string, string>,
    bld: '#e2e2e5', bldLine: '#d2d3d8', bldCommercial: '#f2e6da', bldEdu: '#e6e0f2', bldHealth: '#f6dcdc', bldLandmark: '#eadfc8',
    ext: '#e6e7eb', extCommercial: '#efe4d8', extLandmark: '#e6dcc6',
    casing: { motorway: '#e3a63a', motorway_link: '#e3a63a', trunk: '#e2b555', primary: '#e3cf8f', secondary: '#d3d6db', tertiary: '#d6d9de', minor: '#d9dce1', service: '#dfe1e5', track: '#d8cfb8', raceway: '#c9ccd2', pedestrian: '#d9dbdf' } as Record<string, string>,
    fill: { motorway: '#fbd36a', motorway_link: '#fcd97c', trunk: '#fde699', primary: '#fff5cf', secondary: '#ffffff', tertiary: '#ffffff', minor: '#ffffff', service: '#ffffff', track: '#f3ecdc', raceway: '#e9eaee', pedestrian: '#f7f7f8' } as Record<string, string>,
    lowRoad: '#ffffff',
    bridgeCasing: '#b9bcc3', tunnelFill: '#f7f7f7',
    path: '#b4bac4', pathCasing: '#ffffff',
    rail: '#acb0b8', railDash: '#ffffff', subway: '#b6bac2',
    runway: '#c9ccd3', taxiway: '#d5d8de', airport: '#e7e8ee',
    ferry: '#6aa2e2',
    text: '#5b6067', textStrong: '#3c4043', halo: '#ffffff', station: '#1f3f73', district: '#6b6f76', parkText: '#2f7d47', road: '#5d6167', highwayText: '#6b5320',
    contour: 'rgba(140,108,66,0.32)', contourMajor: 'rgba(128,92,48,0.55)', contourText: '#8a7357',
    grid: 'rgba(60,64,67,0.22)', shadow: '#4c5a66', highlight: '#ffffff', accent: '#d9e3d0',
    sel: '#1a73e8',
  },
  dark: {
    outside: '#15171a', land: '#1f2326', urban: '#25282c', forest: '#1d2b22', forestDense: '#1b2a20', park: '#1f3527',
    water: '#122436', waterLine: '#17304a', waterText: '#6d93bf',
    lot: { residential: '#26292d', residential_high: '#282b30', commercial: '#2e2a27', office: '#262a31', industrial: '#29282f', education: '#2a2832', health: '#302628', civic: '#272a2f', landmark: '#2f2b24', transport: '#272930', park_building: '#203427', plaza: '#24302a', cemetery: '#223027', sports: '#203427', utility: '#28292b', utility_open: '#26282b', apron: '#3a3d43', other: '#27292c' } as Record<string, string>,
    bld: '#33363b', bldLine: '#3d4046', bldCommercial: '#3b3530', bldEdu: '#36333e', bldHealth: '#3c3234', bldLandmark: '#3d382d',
    ext: '#383b41', extCommercial: '#403a33', extLandmark: '#433d31',
    casing: { motorway: '#7d6430', motorway_link: '#7d6430', trunk: '#6b5a35', primary: '#4d4a3e', secondary: '#3a3e45', tertiary: '#383c43', minor: '#363a40', service: '#33373c', track: '#3a362c', raceway: '#3c3f45', pedestrian: '#33363b' } as Record<string, string>,
    fill: { motorway: '#a4843f', motorway_link: '#977a3c', trunk: '#81703f', primary: '#5b574a', secondary: '#4a4e55', tertiary: '#464a51', minor: '#43474e', service: '#3d4147', track: '#3d3a32', raceway: '#3d4046', pedestrian: '#3a3d42' } as Record<string, string>,
    lowRoad: '#4a4e55',
    bridgeCasing: '#16181b', tunnelFill: '#30333a',
    path: '#5a5f68', pathCasing: '#2b2e33',
    rail: '#5d626b', railDash: '#2a2d32', subway: '#555a63',
    runway: '#44474e', taxiway: '#3c3f45', airport: '#26282e',
    ferry: '#3f74b0',
    text: '#b9bec6', textStrong: '#e2e5e9', halo: '#17191c', station: '#c6d8f5', district: '#9aa0a8', parkText: '#6fbf87', road: '#a9aeb6', highwayText: '#e0c88f',
    contour: 'rgba(200,180,140,0.18)', contourMajor: 'rgba(210,185,140,0.34)', contourText: '#a9977b',
    grid: 'rgba(220,220,220,0.18)', shadow: '#000000', highlight: '#3d4a52', accent: '#1f2622',
    sel: '#8ab4f8',
  },
};

// px per metre at a given zoom (512 px tiles, Web Mercator at the equator)
const K = (z: number) => 2 ** z / 78271.517;

const CLASSES = ['motorway', 'motorway_link', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'raceway', 'pedestrian'];
// minimum on-screen width (px) per class at z10 / z13 / z16; above z16 roads use their real width
const MINW: Record<string, [number, number, number]> = {
  motorway: [1.4, 2.6, 5.5], motorway_link: [0.6, 1.4, 3.6], trunk: [1.1, 2.2, 4.8], primary: [0.8, 2, 5.2], secondary: [0.5, 1.6, 4.4],
  tertiary: [0.35, 1.3, 4], minor: [0, 0.8, 3.2], service: [0, 0.4, 2], track: [0, 0.5, 1.4], raceway: [0, 0.8, 3], pedestrian: [0, 0.6, 2.4],
};

const byClass = (vals: Record<string, string | number>, fallback: string | number): E =>
  ['match', ['get', 'cls'], ...CLASSES.flatMap((c) => [c, vals[c] ?? fallback]), fallback] as unknown as E;

function roadWidth(extra: [number, number, number, number] = [0, 0, 0, 0]): E {
  const minAt = (i: number) => byClass(Object.fromEntries(CLASSES.map((c) => [c, MINW[c][i]])), 0);
  const phys = (z: number): E => ['*', ['get', 'w'], K(z)];
  return ['interpolate', ['exponential', 2], ['zoom'],
    10, ['+', minAt(0), extra[0] * 0.5],
    13, ['+', ['max', minAt(1), phys(13)], extra[1]],
    16, ['+', ['max', minAt(2), phys(16)], extra[2]],
    18, ['+', ['max', minAt(2), phys(18)], extra[3]],
    22, ['+', phys(22), extra[3] * 2],
  ] as unknown as E;
}

const CASING: [number, number, number, number] = [0.6, 1.2, 2, 2.6];

export function buildStyle(o: StyleOptions, fontBase: string): StyleSpecification {
  const p = PAL[o.theme];
  const font = (w: 'Regular' | 'Medium' | 'SemiBold' | 'Bold') => [`Pretendard ${w}`];
  const vis = (on: boolean) => (on ? 'visible' : 'none') as 'visible' | 'none';
  const lbl = vis(o.labels);
  const groundRoad: E = ['all', ['==', ['get', 'brunnel'], ''], ['in', ['get', 'cls'], ['literal', CLASSES]]] as unknown as E;
  const bridgeRoad: E = ['all', ['==', ['get', 'brunnel'], 'bridge'], ['in', ['get', 'cls'], ['literal', CLASSES]]] as unknown as E;
  const tunnelRoad: E = ['all', ['==', ['get', 'brunnel'], 'tunnel'], ['in', ['get', 'cls'], ['literal', CLASSES]]] as unknown as E;
  const isPath: E = ['in', ['get', 'cls'], ['literal', ['footway', 'trail']]] as unknown as E;

  const roadOpacity: E = ['interpolate', ['linear'], ['zoom'], 11, ['match', ['get', 'cls'], ['motorway', 'trunk', 'primary', 'motorway_link'], 1, ['secondary', 'tertiary'], 0.75, 0], 13, ['match', ['get', 'cls'], ['service', 'track', 'pedestrian'], 0, 1], 14.5, 1] as unknown as E;

  const casingLayer = (id: string, filter: E, color: E | string, dash?: number[]): LayerSpecification => ({
    id, type: 'line', source: 'roads', filter,
    layout: { 'line-cap': dash ? 'butt' : 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rank'] },
    paint: {
      'line-color': color, 'line-width': roadWidth(CASING), 'line-opacity': roadOpacity,
      ...(dash ? { 'line-dasharray': dash } : {}),
    },
  } as LayerSpecification);
  const fillLayer = (id: string, filter: E, color: E | string, opacity?: E | number): LayerSpecification => ({
    id, type: 'line', source: 'roads', filter,
    layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'rank'] },
    paint: { 'line-color': color, 'line-width': roadWidth(), 'line-opacity': opacity ?? roadOpacity },
  } as LayerSpecification);

  // At low zoom minor roads render as soft gray strokes with no casing (Google-like)
  const casingColor: E = ['interpolate', ['linear'], ['zoom'], 12, byClass({ ...p.casing, secondary: p.casing.secondary, tertiary: p.casing.tertiary, minor: p.casing.minor }, p.casing.minor), 15, byClass(p.casing, p.casing.minor)] as unknown as E;
  const fillColor = byClass(p.fill, p.fill.minor);

  const railWidth: E = ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.8, 14, 1.6, 17, 3, 20, 6];
  const railLayers = (prefix: string, filter: E, extra: Record<string, unknown> = {}): LayerSpecification[] => [
    { id: `${prefix}-rail`, type: 'line', source: 'rails', filter: ['all', filter, ['==', ['get', 'cls'], 'rail']] as unknown as E, minzoom: 10, paint: { 'line-color': p.rail, 'line-width': railWidth, ...extra } } as LayerSpecification,
    { id: `${prefix}-rail-dash`, type: 'line', source: 'rails', filter: ['all', filter, ['==', ['get', 'cls'], 'rail']] as unknown as E, minzoom: 14, paint: { 'line-color': p.railDash, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 14, 0.6, 17, 1.6, 20, 3.4], 'line-dasharray': [2, 3] } } as LayerSpecification,
    { id: `${prefix}-subway`, type: 'line', source: 'rails', filter: ['all', filter, ['in', ['get', 'cls'], ['literal', ['subway', 'monorail']]]] as unknown as E, minzoom: 12, paint: { 'line-color': p.subway, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.6, 15, 1.4, 18, 2.8, 20, 4], ...extra } } as LayerSpecification,
    { id: `${prefix}-tram`, type: 'line', source: 'rails', filter: ['all', filter, ['==', ['get', 'cls'], 'tram']] as unknown as E, minzoom: 14, paint: { 'line-color': p.subway, 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 18, 1.4], ...extra } } as LayerSpecification,
    { id: `${prefix}-cable`, type: 'line', source: 'rails', filter: ['all', filter, ['==', ['get', 'cls'], 'cablecar']] as unknown as E, minzoom: 13, paint: { 'line-color': p.text, 'line-width': 1, 'line-dasharray': [6, 2] } } as LayerSpecification,
  ];

  const lotFill: E = ['match', ['get', 'cat'], ...Object.entries(p.lot).flat(), p.lot.other] as unknown as E;
  const bldFill: E = ['match', ['get', 'cat'], 'commercial', p.bldCommercial, 'education', p.bldEdu, 'health', p.bldHealth, 'landmark', p.bldLandmark, p.bld] as unknown as E;
  const extFill: E = ['match', ['get', 'cat'], 'commercial', p.extCommercial, 'landmark', p.extLandmark, 'education', p.bldEdu, 'health', p.bldHealth, p.ext] as unknown as E;

  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': p.outside } },
    { id: 'land', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'land'], paint: { 'fill-color': p.land } },
    {
      id: 'relief', type: 'color-relief', source: 'dem', layout: { visibility: vis(o.terrain) },
      paint: {
        'color-relief-opacity': o.theme === 'light' ? 0.55 : 0.35,
        'color-relief-color': ['interpolate', ['linear'], ['elevation'],
          0, o.theme === 'light' ? '#dfeacf' : '#1e2a22', 80, o.theme === 'light' ? '#e7eccf' : '#232a22', 200, o.theme === 'light' ? '#efe9cc' : '#2b2a22',
          400, o.theme === 'light' ? '#ead9b8' : '#30291f', 650, o.theme === 'light' ? '#ddc6a3' : '#352b22', 900, o.theme === 'light' ? '#ecebe8' : '#3a3936'],
      },
    } as LayerSpecification,
    { id: 'urban', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'urban'], paint: { 'fill-color': p.urban, 'fill-opacity': o.terrain ? 0.75 : 1, 'fill-antialias': true } },
    { id: 'forest', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'forest'], paint: { 'fill-color': p.forest, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 1] } },
    { id: 'forest-dense', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'forest_dense'], paint: { 'fill-color': p.forestDense } },
    {
      id: 'hillshade', type: 'hillshade', source: 'dem',
      paint: {
        'hillshade-method': 'igor',
        'hillshade-exaggeration': (o.terrain ? 0.75 : 0.35) * (o.theme === 'dark' ? 0.6 : 1),
        'hillshade-shadow-color': o.terrain ? (o.theme === 'light' ? '#56616b' : '#000000') : p.shadow,
        'hillshade-highlight-color': o.terrain && o.theme === 'light' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0)',
        'hillshade-accent-color': p.shadow,
        'hillshade-illumination-direction': 315,
      },
    } as LayerSpecification,
    { id: 'airport', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'airport'], minzoom: 10, paint: { 'fill-color': p.airport, 'fill-opacity': 0.9 } },
    { id: 'outside-mask', type: 'fill', source: 'land', filter: ['==', ['get', 'kind'], 'outside'], paint: { 'fill-color': p.outside } },
    { id: 'lots', type: 'fill', source: 'lots', minzoom: 12, paint: { 'fill-color': lotFill, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13.5, 1] } },
    { id: 'contours', type: 'line', source: 'contours', minzoom: 11, layout: { visibility: vis(o.contours), 'line-join': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'major'], 1], p.contourMajor, p.contour], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['case', ['==', ['get', 'major'], 1], 0.7, 0.4], 16, ['case', ['==', ['get', 'major'], 1], 1.5, 0.8]], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, ['case', ['==', ['get', 'major'], 1], 1, 0], 13.5, 1] } } as LayerSpecification,
    { id: 'water', type: 'fill', source: 'water', filter: ['==', ['get', 'kind'], 'water'], paint: { 'fill-color': p.water } },
    { id: 'water-canal', type: 'line', source: 'water', filter: ['==', ['get', 'cls'], 'canal'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': p.water, 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, ['*', ['get', 'w'], K(12)], 22, ['*', ['get', 'w'], K(22)]] } },
    { id: 'water-edge', type: 'line', source: 'water', filter: ['==', ['get', 'kind'], 'water'], minzoom: 13, paint: { 'line-color': p.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 18, 1.2], 'line-opacity': 0.8 } },

    { id: 'runway', type: 'line', source: 'roads', filter: ['in', ['get', 'cls'], ['literal', ['runway', 'taxiway']]], minzoom: 11, layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'cls'], 'runway', p.runway, p.taxiway], 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, ['max', 1, ['*', ['get', 'w'], K(11)]], 22, ['*', ['get', 'w'], K(22)]] } },
    { id: 'runway-center', type: 'line', source: 'roads', filter: ['==', ['get', 'cls'], 'runway'], minzoom: 15, paint: { 'line-color': o.theme === 'light' ? '#ffffff' : '#5a5e66', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 19, 2], 'line-dasharray': [6, 6] } },

    // ---- tunnels
    casingLayer('tunnel-casing', tunnelRoad, casingColor, [0.6, 0.4]),
    fillLayer('tunnel-fill', tunnelRoad, p.tunnelFill, ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.75] as unknown as E),
    ...railLayers('tunnel', ['==', ['get', 'brunnel'], 'tunnel'] as unknown as E, { 'line-opacity': 0.35 }).filter((l) => !l.id.includes('subway') && !l.id.includes('dash')),

    // ---- ground level
    { id: 'path-casing', type: 'line', source: 'roads', filter: ['all', isPath, ['!=', ['get', 'brunnel'], 'tunnel']], minzoom: 16, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': p.pathCasing, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 16, 3, 20, 9], 'line-opacity': 0.9 } } as LayerSpecification,
    { id: 'path', type: 'line', source: 'roads', filter: ['all', isPath, ['!=', ['get', 'brunnel'], 'tunnel']], minzoom: 14.5, layout: { 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'cls'], 'trail', o.theme === 'light' ? '#c3b393' : '#6b604c', p.path], 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 14.5, 0.8, 17, 1.4, 20, 2.6], 'line-dasharray': [2, 1.6] } } as LayerSpecification,
    casingLayer('road-casing', groundRoad, casingColor),
    fillLayer('road-fill', groundRoad, fillColor),
    ...railLayers('ground', ['==', ['get', 'brunnel'], ''] as unknown as E),

    // ---- buildings
    { id: 'building', type: 'fill', source: 'buildings', minzoom: 14, paint: { 'fill-color': bldFill, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1] } },
    { id: 'building-line', type: 'line', source: 'buildings', minzoom: 15, paint: { 'line-color': p.bldLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.4, 19, 1.2], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 1] } },
    {
      id: 'building-3d', type: 'fill-extrusion', source: 'buildings', minzoom: 15, layout: { visibility: vis(o.buildings3d) },
      paint: {
        'fill-extrusion-color': extFill,
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'h']],
        'fill-extrusion-opacity': 0.92,
        'fill-extrusion-vertical-gradient': true,
      },
    } as LayerSpecification,

    // ---- bridges (drawn above buildings' footprints)
    ...railLayers('bridge', ['==', ['get', 'brunnel'], 'bridge'] as unknown as E).map((l) => (l.id === 'bridge-rail' ? { ...l, paint: { ...(l as any).paint, 'line-color': p.rail } } : l)),
    casingLayer('bridge-casing', bridgeRoad, p.bridgeCasing),
    fillLayer('bridge-fill', bridgeRoad, fillColor),

    {
      // one-way arrows only where the direction is confirmed by transit routes or the keep-right rule
      id: 'oneway-arrow', type: 'symbol', source: 'roads', minzoom: 16,
      filter: ['all', ['!=', ['get', 'ow'], 0], ['==', ['get', 'owSure'], 1], ['!=', ['get', 'brunnel'], 'tunnel'], ['in', ['get', 'cls'], ['literal', ['motorway_link', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']]]],
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 16, 90, 19, 160], 'icon-image': 'oneway',
        'icon-rotate': ['case', ['==', ['get', 'ow'], -1], 180, 0], 'icon-rotation-alignment': 'map', 'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 1, 19, 1.7],
        'icon-padding': 0, 'icon-allow-overlap': false, 'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], 16, 0, 16.5, 0.95] },
    } as LayerSpecification,
    { id: 'ferry', type: 'line', source: 'roads', filter: ['==', ['get', 'cls'], 'ferry'], minzoom: 12, paint: { 'line-color': p.ferry, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1.2], 'line-dasharray': [3, 3], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 0.45, 16, 0.6] } } as LayerSpecification,

    // ---- transit overlay
    {
      id: 'transit-casing', type: 'line', source: 'transit', layout: { visibility: vis(o.transit), 'line-join': 'round', 'line-cap': 'round' },
      filter: ['in', ['get', 'mode'], ['literal', o.bus ? ['metro', 'train', 'tram', 'monorail', 'cablecar', 'ferry', 'bus'] : ['metro', 'train', 'tram', 'monorail', 'cablecar']]],
      paint: {
        'line-color': p.halo,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['match', ['get', 'mode'], 'bus', 2, 3.4], 15, ['match', ['get', 'mode'], 'bus', 3.6, 6], 18, ['match', ['get', 'mode'], 'bus', 5, 8]],
        'line-offset': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 'offset'], 1.8], 15, ['*', ['get', 'offset'], ['match', ['get', 'mode'], 'bus', 2.4, 3.6]], 18, ['*', ['get', 'offset'], ['match', ['get', 'mode'], 'bus', 3.4, 5]]],
        'line-opacity': ['match', ['get', 'mode'], 'bus', 0.7, 0.9],
      },
    } as LayerSpecification,
    {
      id: 'transit-line', type: 'line', source: 'transit', layout: { visibility: vis(o.transit), 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['match', ['get', 'mode'], 'bus', 0, 1] },
      filter: ['in', ['get', 'mode'], ['literal', o.bus ? ['metro', 'train', 'tram', 'monorail', 'cablecar', 'ferry', 'bus'] : ['metro', 'train', 'tram', 'monorail', 'cablecar']]],
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, ['match', ['get', 'mode'], 'bus', 1, 1.8], 15, ['match', ['get', 'mode'], 'bus', 2, 3.6], 18, ['match', ['get', 'mode'], 'bus', 3, 5]],
        'line-offset': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 'offset'], 1.8], 15, ['*', ['get', 'offset'], ['match', ['get', 'mode'], 'bus', 2.4, 3.6]], 18, ['*', ['get', 'offset'], ['match', ['get', 'mode'], 'bus', 3.4, 5]]],
        'line-opacity': ['match', ['get', 'mode'], 'bus', 0.85, 1],
      },
    } as LayerSpecification,

    {
      id: 'cycling', type: 'line', source: 'roads', layout: { visibility: vis(o.cycling), 'line-join': 'round', 'line-cap': 'round' },
      filter: ['any', ['==', ['get', 'bike'], 1], ['all', ['==', ['get', 'cls'], 'footway'], ['in', 'Bicycle', ['get', 'type']]]],
      paint: { 'line-color': o.theme === 'light' ? '#1e8e3e' : '#5bb974', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.4, 16, 3, 19, 5], 'line-opacity': 0.9 },
    } as LayerSpecification,
    { id: 'grid', type: 'line', source: 'grid', layout: { visibility: vis(o.grid) }, paint: { 'line-color': p.grid, 'line-width': 1, 'line-dasharray': [4, 3] } },

    // ---- selection highlight
    { id: 'sel-fill', type: 'fill', source: 'selection', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': p.sel, 'fill-opacity': 0.18 } },
    { id: 'sel-line', type: 'line', source: 'selection', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': p.sel, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 18, 5], 'line-opacity': 0.85 } },

    // ---- measure tool (drawn above everything but labels)
    { id: 'measure-area', type: 'fill', source: 'measure', filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.14 } } as LayerSpecification,
    { id: 'measure-casing', type: 'line', source: 'measure', filter: ['in', ['get', 'kind'], ['literal', ['line', 'preview']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5.5 } } as LayerSpecification,
    { id: 'measure-line', type: 'line', source: 'measure', filter: ['==', ['get', 'kind'], 'line'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#202124', 'line-width': 2.5 } } as LayerSpecification,
    { id: 'measure-preview', type: 'line', source: 'measure', filter: ['==', ['get', 'kind'], 'preview'], paint: { 'line-color': '#202124', 'line-width': 2, 'line-dasharray': [2, 2] } } as LayerSpecification,
    { id: 'measure-vertex', type: 'circle', source: 'measure', filter: ['==', ['get', 'kind'], 'vertex'], paint: { 'circle-radius': ['case', ['==', ['get', 'first'], 1], 6.5, 5], 'circle-color': '#ffffff', 'circle-stroke-color': '#202124', 'circle-stroke-width': 2.5 } } as LayerSpecification,
    {
      id: 'measure-label', type: 'symbol', source: 'measure', filter: ['==', ['get', 'kind'], 'label'],
      layout: { 'text-field': ['get', 'text'], 'text-font': font('SemiBold'), 'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-offset': [0, -0.9] },
      paint: { 'text-color': '#202124', 'text-halo-color': '#ffffff', 'text-halo-width': 2.2 },
    } as LayerSpecification,

    // ---- directions
    { id: 'route-link', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'link'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#7c8ba1', 'line-width': 2.5, 'line-dasharray': [0, 2] } } as LayerSpecification,
    { id: 'route-alt-casing', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alt'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': o.theme === 'light' ? '#8fa3c0' : '#4a5a72', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 10, 19, 14] } } as LayerSpecification,
    { id: 'route-alt', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'alt'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': o.theme === 'light' ? '#bccbe2' : '#61738f', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 7, 19, 10] } } as LayerSpecification,
    { id: 'route-casing', type: 'line', source: 'route', filter: ['in', ['get', 'role'], ['literal', ['main', 'ride']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'role'], 'ride'], '#ffffff', '#174ea6'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 7, 16, 11, 19, 15] } } as LayerSpecification,
    { id: 'route-line', type: 'line', source: 'route', filter: ['in', ['get', 'role'], ['literal', ['main', 'ride']]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'role'], 'ride'], ['get', 'color'], '#4285f4'], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 4.5, 16, 7.5, 19, 11] } } as LayerSpecification,
    { id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'role'], 'walk'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#4285f4', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3.5, 16, 6, 19, 8], 'line-dasharray': [0, 1.6] } } as LayerSpecification,
    { id: 'route-stop', type: 'circle', source: 'route', filter: ['==', ['get', 'role'], 'stop'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 6], 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 } } as LayerSpecification,

    // ---- labels
    {
      id: 'contour-label', type: 'symbol', source: 'contours', minzoom: 13.5, filter: ['==', ['get', 'major'], 1],
      layout: { visibility: o.contours && o.labels ? 'visible' : 'none', 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-font': font('Medium'), 'text-size': 10, 'symbol-spacing': 400, 'text-padding': 8 },
      paint: { 'text-color': p.contourText, 'text-halo-color': p.halo, 'text-halo-width': 1.4 },
    } as LayerSpecification,
    {
      id: 'road-label-minor', type: 'symbol', source: 'roadLabels', minzoom: 13.5, filter: ['all', ['<', ['get', 'rank'], 7], ['any', ['>=', ['get', 'rank'], 5], ['>=', ['zoom'], 14.8]]],
      layout: {
        visibility: lbl, 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font('Medium'),
        'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, ['match', ['get', 'rank'], [5, 6], 11, 10.5], 18, ['match', ['get', 'rank'], [5, 6], 15, 13.5]],
        'symbol-spacing': 320, 'text-max-angle': 28, 'text-padding': 3, 'symbol-sort-key': ['-', 10, ['get', 'rank']], 'text-letter-spacing': 0.02,
      },
      paint: { 'text-color': p.road, 'text-halo-color': p.halo, 'text-halo-width': 1.8, 'text-halo-blur': 0.4 },
    } as LayerSpecification,
    {
      id: 'road-label-major', type: 'symbol', source: 'roadLabels', minzoom: 12, filter: ['>=', ['get', 'rank'], 7],
      layout: {
        visibility: lbl, 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font('SemiBold'),
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 17, 14.5], 'symbol-spacing': 420, 'text-max-angle': 25, 'text-padding': 6, 'text-letter-spacing': 0.03,
      },
      paint: { 'text-color': p.highwayText, 'text-halo-color': o.theme === 'light' ? '#fff8e1' : p.halo, 'text-halo-width': 2, 'text-halo-blur': 0.3 },
    } as LayerSpecification,
    {
      id: 'busstop', type: 'symbol', source: 'places', minzoom: 16, filter: ['==', ['get', 'kind'], 'busstop'],
      layout: { visibility: vis(o.labels && o.transit), 'icon-image': 'poi-sm-bus', 'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.85, 19, 1.1], 'icon-padding': 2 },
    } as LayerSpecification,
    {
      id: 'toll', type: 'symbol', source: 'places', filter: ['==', ['get', 'kind'], 'toll'], minzoom: 12.5,
      layout: {
        visibility: lbl, 'icon-image': 'poi-toll', 'icon-size': ['interpolate', ['linear'], ['zoom'], 12.5, 0.7, 16, 0.95],
        // unnamed booths carry a generic English name: show it in the UI language
        'text-field': ['step', ['zoom'], ['case', ['==', ['get', 'named'], 1], ['get', 'name'], ''], 15.5, ['case', ['==', ['get', 'named'], 1], ['get', 'name'], ['match', ['get', 'name'], 'Toll lanes', t('Toll lanes'), t('Toll booth')]]],
        'text-font': font('SemiBold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 18, 13],
        'text-variable-anchor-offset': ['literal', ['top', [0, 1.05], 'right', [-1.1, 0], 'left', [1.1, 0]]], 'text-optional': true, 'symbol-sort-key': 2, 'icon-padding': 2,
        'icon-allow-overlap': true, // always show the booth; its name may give way to other labels
      },
      paint: { 'text-color': o.theme === 'light' ? '#a5581a' : '#f0a868', 'text-halo-color': p.halo, 'text-halo-width': 1.8 },
    } as LayerSpecification,
    {
      id: 'poi', type: 'symbol', source: 'places', filter: ['all', ['==', ['get', 'kind'], 'poi'], ['any', ['<=', ['get', 'rank'], 3], ['all', ['<=', ['get', 'rank'], 4], ['>=', ['zoom'], 15.2]], ['>=', ['zoom'], 15.8]]], minzoom: 14,
      layout: {
        visibility: lbl, 'icon-image': ['concat', 'poi-', ['get', 'poi']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 17, 1],
        'text-field': ['step', ['zoom'], '', 15, ['get', 'name']], 'text-font': font('Medium'), 'text-size': ['interpolate', ['linear'], ['zoom'], 15, 11.5, 18, 13.5],
        'text-variable-anchor-offset': ['literal', ['left', [1.1, 0], 'right', [-1.1, 0], 'top', [0, 1.05]]], 'text-justify': 'auto', 'text-max-width': 8, 'text-optional': true,
        'symbol-sort-key': ['get', 'rank'], 'icon-padding': 3,
      },
      paint: {
        'text-color': ['match', ['get', 'poi'], 'hospital', '#c4433b', 'school', '#6a52b8', 'police', '#3f63c4', 'fire', '#c4543b', 'landmark', '#0d7f79', 'sports', '#2c8a4d', 'cemetery', '#5e7a63', o.theme === 'light' ? '#5f6368' : '#b0b5bd'],
        'text-halo-color': p.halo, 'text-halo-width': 1.8,
      },
    } as LayerSpecification,
    {
      id: 'park-label', type: 'symbol', source: 'places', filter: ['all', ['==', ['get', 'kind'], 'park'], ['any', ['<=', ['get', 'rank'], 1], ['>=', ['zoom'], 13]]], minzoom: 11,
      layout: {
        visibility: lbl, 'icon-image': ['concat', 'poi-', ['get', 'poi']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.75, 15, 1],
        'text-field': ['get', 'name'], 'text-font': font('SemiBold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 14],
        'text-variable-anchor-offset': ['literal', ['top', [0, 1.05], 'left', [1.1, 0], 'right', [-1.1, 0]]], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': ['match', ['get', 'poi'], 'airport', o.theme === 'light' ? '#3d6fc2' : '#8ab4f8', 'industry', p.text, 'campus', '#6a52b8', p.parkText], 'text-halo-color': p.halo, 'text-halo-width': 1.8 },
    } as LayerSpecification,
    {
      id: 'district-label', type: 'symbol', source: 'places', filter: ['==', ['get', 'kind'], 'district'], minzoom: 11.3, maxzoom: 17.5,
      layout: {
        visibility: lbl, 'text-field': ['get', 'name'], 'text-font': font('SemiBold'),
        'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 11.5, 14, 13.5, 17, 16], 'text-letter-spacing': 0.06, 'text-max-width': 7, 'text-padding': 6,
        'symbol-sort-key': 0,
      },
      paint: { 'text-color': p.district, 'text-halo-color': p.halo, 'text-halo-width': 1.6, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 1, 17.5, 0] },
    } as LayerSpecification,
    {
      // last in the list = placed first, so stations win label collisions (as on Google Maps)
      id: 'station', type: 'symbol', source: 'places', filter: ['==', ['get', 'kind'], 'station'], minzoom: 11.5,
      layout: {
        visibility: vis(o.labels && o.transit), 'icon-image': ['concat', 'st-', ['get', 'poi'], '-', ['get', 'color']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 11.5, 0.7, 14, 0.9, 17, 1.05],
        'text-field': ['step', ['zoom'], ['case', ['<=', ['get', 'rank'], 1], ['get', 'name'], ''], 13, ['case', ['<=', ['get', 'rank'], 2], ['get', 'name'], ''], 14.5, ['get', 'name']],
        'text-font': font('SemiBold'), 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11.5, 15, 13, 18, 15],
        'text-variable-anchor-offset': ['literal', ['top', [0, 1.05], 'bottom', [0, -1.05], 'right', [-1.15, 0], 'left', [1.15, 0], 'top-left', [0.8, 0.8], 'top-right', [-0.8, 0.8]]],
        'text-justify': 'auto', 'text-max-width': 10, 'text-optional': true, 'text-padding': 1,
        'symbol-sort-key': ['get', 'rank'], 'icon-padding': 1,
      },
      paint: { 'text-color': p.station, 'text-halo-color': p.halo, 'text-halo-width': 2, 'text-halo-blur': 0.3 },
    } as LayerSpecification,
  ];

  const empty = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as const;
  const fontFile = (w: string) => new URL(`fonts/Pretendard-${w}.woff2`, fontBase).href;
  return {
    version: 8,
    glyphs: new URL('fonts/', fontBase).href + '{fontstack}/{range}.pbf',
    'font-faces': {
      'Pretendard Regular': fontFile('Regular'), 'Pretendard Medium': fontFile('Medium'),
      'Pretendard SemiBold': fontFile('SemiBold'), 'Pretendard Bold': fontFile('Bold'),
    },
    sources: {
      land: empty, water: empty, lots: empty, buildings: empty, roads: { ...empty, promoteId: 'id' } as any, rails: empty, transit: empty, places: empty, roadLabels: empty, grid: empty, contours: empty, selection: empty, districts: empty, route: empty, measure: empty,
      // 512 px tiles stopping at z13 (≈9.5 m/px, finer than the 16 m heightmap): few tiles, one detail level, no seams
      dem: { type: 'raster-dem', tiles: ['csldem://{z}/{x}/{y}'], tileSize: 512, encoding: 'terrarium', minzoom: 7, maxzoom: 13, bounds: [-0.078, -0.078, 0.078, 0.078] },
    },
    sky: o.theme === 'light'
      ? { 'sky-color': '#cfe3f7', 'horizon-color': '#eef3f8', 'fog-color': '#f1f2ee', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 }
      : { 'sky-color': '#0d1420', 'horizon-color': '#1a2230', 'fog-color': '#1a1d21', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 },
    light: { anchor: 'viewport', position: [1.2, 200, 40], color: '#ffffff', intensity: o.theme === 'light' ? 0.38 : 0.45 },
    layers,
  } as StyleSpecification;
}

export const SOURCE_KEYS = ['land', 'water', 'lots', 'buildings', 'roads', 'rails', 'transit', 'places', 'roadLabels', 'grid', 'districts'] as const;