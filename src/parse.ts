// Fast regex-based reader for CSLMapView export XML (.cslmap).
// The files are large (10-25 MB) but very regular, so scanning the raw string
// is several times faster than DOMParser and needs far less memory.

export interface Vec3 { x: number; y: number; z: number }

export interface CNode {
  id: number; x: number; y: number; z: number; ug: boolean; srv: string; subsrv: string; /** district id, 0 = none */ dist: number;
  /** game's OnGround flag (`og`); null when the export doesn't carry it */ og: boolean | null;
  /** game's node elevation step (`elev`, 0 = at grade); 0 when absent */ elev: number;
}

export interface CSeg {
  id: number; sn: number; en: number; icls: string; width: number;
  name: string; customName: string; pts: Vec3[]; path: number[] | null;
}

export interface CBuilding { id: number; name: string; /** name the player gave in game */ myname: string; srv: string; subsrv: string; icls: string;
  /** `prntb`: previous building in the asset's sub-building chain (0 = none); see buildingGroups */ parent: number;
  /** `subb`: next building in that chain (0 = none) */ sub: number; pts: Vec3[] }

export interface CLane { type: string; vType: string; dir: string; pos: number; width: number; speed: number }
export interface CSegType { name: string; highway: boolean; lanes: CLane[] }

export interface CArea { id: number; name: string; x: number; y: number; z: number; type?: string }

export interface CTransport { id: number; name: string; type: string; color: [number, number, number]; stops: number[] }

export interface CityData {
  name: string;
  generated: string;
  seaLevel: number;
  nodes: Map<number, CNode>;
  segs: CSeg[];
  buildings: CBuilding[];
  segTypes: Map<string, CSegType>;
  districts: CArea[];
  parks: CArea[];
  transports: CTransport[];
  /** terrain height in metres, row-major, row = +z */
  height: Float32Array;
  /** water depth in metres */
  water: Float32Array;
  terrainSize: number;
  /** forest density 0-255, row-major, row = +z */
  forest: Uint8Array;
  forestSize: number;
}

const ATTR = /([\w:]+)="([^"]*)"/g;

function attrs(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(s))) o[m[1]] = m[2];
  return o;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : all;
    }
    return ENT[e] ?? all;
  });
}

function section(xml: string, tag: string): string {
  const a = xml.indexOf(`<${tag}>`);
  if (a < 0) return '';
  const b = xml.indexOf(`</${tag}>`, a);
  return xml.slice(a + tag.length + 2, b < 0 ? undefined : b);
}

function tagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]) : '';
}

const P_RE = /<P x="([^"]+)" y="([^"]+)" z="([^"]+)"/g;
function points(s: string): Vec3[] {
  const out: Vec3[] = [];
  P_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = P_RE.exec(s))) out.push({ x: +m[1], y: +m[2], z: +m[3] });
  if (out.length === 0) {
    // attribute order differs in some exporter versions
    const re = /<P ([^>]*)\/>/g;
    while ((m = re.exec(s))) { const a = attrs(m[1]); out.push({ x: +a.x, y: +a.y, z: +a.z }); }
  }
  return out;
}

export function parseCity(xml: string, progress: (msg: string) => void = () => {}): CityData {
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (xml.indexOf('<CSLExportXML') < 0) throw new Error('Not a CSLMapView export (missing <CSLExportXML>)');

  const name = tagText(xml, 'City') || 'Untitled city';
  const generated = tagText(xml, 'Generated');
  const seaLevel = +tagText(xml, 'SeaLevel') || 0;

  progress('Reading nodes');
  const nodes = new Map<number, CNode>();
  {
    const re = /<Node ([^>]*)>\s*<Pos ([^>]*)\/>/g;
    const s = section(xml, 'Nodes');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]); const p = attrs(m[2]);
      const id = +a.id;
      nodes.set(id, { id, x: +p.x, y: +p.y, z: +p.z, ug: a.ug === 'true', srv: a.srv ?? '', subsrv: a.subsrv ?? '', dist: +(a.dist ?? 0) || 0, og: a.og === undefined ? null : a.og === 'true', elev: +(a.elev ?? 0) || 0 });
    }
  }

  progress('Reading segments');
  const segs: CSeg[] = [];
  {
    const re = /<Seg ([^>]*)>([\s\S]*?)<\/Seg>/g;
    const s = section(xml, 'Segments');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]); const body = m[2];
      let path: number[] | null = null;
      const pi = body.indexOf('<Path');
      if (pi >= 0) {
        path = [];
        const sg = /<Sg>(\d+)<\/Sg>/g; sg.lastIndex = pi;
        let q: RegExpExecArray | null;
        while ((q = sg.exec(body))) path.push(+q[1]);
      }
      segs.push({
        id: +a.id, sn: +a.sn, en: +a.en, icls: a.icls ?? '', width: +a.width || 8,
        name: tagText(body, 'Name'), customName: tagText(body, 'CustomName'),
        pts: points(pi >= 0 ? body.slice(0, pi) : body), path,
      });
    }
  }

  progress('Reading buildings');
  const buildings: CBuilding[] = [];
  {
    const re = /<Buil ([^>]*)>([\s\S]*?)<\/Buil>/g;
    const s = section(xml, 'Buildings');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]);
      buildings.push({ id: +a.id, name: unescapeXml(a.name ?? ''), myname: unescapeXml(a.myname ?? '').trim(), srv: a.srv ?? '', subsrv: a.subsrv ?? '', icls: a.icls ?? '', parent: +(a.prntb ?? 0), sub: +(a.subb ?? 0), pts: points(m[2]) });
    }
  }

  const segTypes = new Map<string, CSegType>();
  {
    const re = /<ST ([^>]*?)\/?>(?:([\s\S]*?)<\/ST>)?/g;
    const s = section(xml, 'SegmentTypes');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]);
      const lanes: CLane[] = [];
      if (m[2]) {
        const lr = /<Lane ([^>]*)\/>/g; let q: RegExpExecArray | null;
        while ((q = lr.exec(m[2]))) {
          const l = attrs(q[1]);
          lanes.push({ type: l.type ?? '', vType: l.vType ?? '', dir: l.dir ?? '', pos: +l.pos || 0, width: +l.width || 0, speed: +l.speed || 0 });
        }
      }
      const nm = unescapeXml(a.name ?? '');
      segTypes.set(nm, { name: nm, highway: a.highway === 'true', lanes });
    }
  }

  const areas = (tag: string, el: string): CArea[] => {
    const out: CArea[] = [];
    const re = new RegExp(`<${el} ([^>]*)>([\\s\\S]*?)</${el}>`, 'g');
    const s = section(xml, tag);
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]); const p = points(m[2])[0];
      if (!p) continue;
      const t = /<type>([^<]*)<\/type>/.exec(m[2]);
      out.push({ id: +a.id, name: unescapeXml(a.name ?? ''), x: p.x, y: p.y, z: p.z, type: t?.[1] });
    }
    return out;
  };
  const districts = areas('Districts', 'Dist');
  const parks = areas('Parks', 'Park');

  const transports: CTransport[] = [];
  {
    const re = /<Trans ([^>]*)>([\s\S]*?)<\/Trans>/g;
    const s = section(xml, 'Transports');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const a = attrs(m[1]);
      const c = /<color ([^>]*)\/>/.exec(m[2]);
      const ca = c ? attrs(c[1]) : { r: '128', g: '128', b: '128' };
      const stops: number[] = [];
      const sr = /<Stop node="(\d+)"/g; let q: RegExpExecArray | null;
      while ((q = sr.exec(m[2]))) stops.push(+q[1]);
      transports.push({ id: +a.id, name: unescapeXml(a.name ?? ''), type: a.type ?? '', color: [+ca.r, +ca.g, +ca.b], stops });
    }
  }

  progress('Reading terrain');
  const ter = section(xml, 'Terrains');
  const terText = /<Ter>([\s\S]*?)<\/Ter>/.exec(ter)?.[1] ?? '';
  let count = 0;
  for (let i = 0; i < terText.length; i++) if (terText.charCodeAt(i) === 44) count++;
  count++;
  const terrainSize = Math.round(Math.sqrt(count));
  const height = new Float32Array(terrainSize * terrainSize);
  const water = new Float32Array(terrainSize * terrainSize);
  {
    // hand-rolled number scan: ~1.2M "h:w" pairs
    let idx = 0, cur = 0, first = 0, sawColon = false;
    const n = terText.length;
    for (let i = 0; i <= n; i++) {
      const c = i < n ? terText.charCodeAt(i) : 44;
      if (c >= 48 && c <= 57) cur = cur * 10 + (c - 48);
      else if (c === 58) { first = cur; cur = 0; sawColon = true; }
      else if (c === 44) {
        if (idx < height.length) {
          if (sawColon) { height[idx] = first / 64; water[idx] = cur / 64; }
          else { height[idx] = cur / 64; }
        }
        idx++; cur = 0; sawColon = false;
      }
    }
  }

  const rows = section(xml, 'Forests').match(/<Forest>([^<]*)<\/Forest>/g) ?? [];
  const forestSize = rows.length || 512;
  const forest = new Uint8Array(forestSize * forestSize);
  rows.forEach((row, y) => {
    const vals = row.slice(8, -9).split(',');
    for (let x = 0; x < forestSize && x < vals.length; x++) forest[y * forestSize + x] = +vals[x] | 0;
  });

  return { name, generated, seaLevel, nodes, segs, buildings, segTypes, districts, parks, transports, height, water, terrainSize, forest, forestSize };
}
