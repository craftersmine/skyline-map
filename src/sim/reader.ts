// Readers for a Cities: Skylines save (.crp). Two layers:
//  - the CRP package container (little-endian, .NET BinaryWriter strings), which holds the save's assets;
//  - the `_Data` asset: the game's DataSerializer stream (big-endian), written manager by manager.
// Mirrors ColossalFramework.IO.DataSerializer / EncodedArray from the game (format version 121034).
// Only reads; never keeps more than the views it is handed.

export class SaveError extends Error {
  constructor(public code: 'not-crp' | 'not-save' | 'unsupported-version' | 'truncated' | 'damaged' | 'corrupt', message: string) { super(message); }
}

// ------------------------------------------------------------------ CRP container
/** checksum: MD5 of the asset's bytes as lowercase hex (SecurityHelper.CalculateChecksum), as the game wrote it */
export interface CrpEntry { name: string; type: number; offset: number; size: number; checksum: string }
export interface Crp { name: string; mainAsset: string; entries: CrpEntry[] }

const utf8 = new TextDecoder('utf-8');

/** .NET BinaryWriter string: 7-bit length prefix + UTF-8 bytes */
function netString(b: Uint8Array, p: number): [string, number] {
  let n = 0, shift = 0;
  for (;;) {
    if (p >= b.length) throw new SaveError('truncated', 'string past end of file');
    const x = b[p++]; n |= (x & 0x7f) << shift; shift += 7;
    if (x < 0x80) break;
    if (shift > 28) throw new SaveError('corrupt', 'bad string length');
  }
  if (p + n > b.length) throw new SaveError('truncated', 'string past end of file');
  return [utf8.decode(b.subarray(p, p + n)), p + n];
}

export function readCrp(b: Uint8Array): Crp {
  if (b.length < 6 || b[0] !== 0x43 || b[1] !== 0x52 || b[2] !== 0x41 || b[3] !== 0x50) throw new SaveError('not-crp', 'missing CRAP signature');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 6;
  let name: string, mainAsset: string;
  [name, p] = netString(b, p);
  [, p] = netString(b, p); // author
  p += 4; // package version
  [mainAsset, p] = netString(b, p);
  if (p + 12 > b.length) throw new SaveError('truncated', 'header past end of file');
  const count = dv.getInt32(p, true); p += 4;
  const dataOffset = Number(dv.getBigInt64(p, true)); p += 8;
  if (count < 0 || count > 10000) throw new SaveError('corrupt', 'bad asset count');
  const entries: CrpEntry[] = [];
  for (let i = 0; i < count; i++) {
    let en: string, checksum: string;
    [en, p] = netString(b, p);
    [checksum, p] = netString(b, p);
    if (p + 20 > b.length) throw new SaveError('truncated', 'asset table past end of file');
    const type = dv.getInt32(p, true); p += 4;
    const off = Number(dv.getBigInt64(p, true)); p += 8;
    const size = Number(dv.getBigInt64(p, true)); p += 8;
    entries.push({ name: en, type, offset: dataOffset + off, size, checksum });
  }
  return { name, mainAsset, entries };
}

/** CRP asset types used by saves (ColossalFramework Package.AssetType / UserAssetType) */
export const ASSET_DATA = 52, ASSET_SAVE_META = 101;

/** Fields of SaveGameMetaData (a reflection-serialized object, see PackageDeserializer.DeserializeObject). */
export interface SaveMeta { cityName?: string; timeStamp?: string; population?: string; mods?: [string, string][] }

export function readSaveMeta(b: Uint8Array, e: CrpEntry): SaveMeta {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = e.offset;
  const end = e.offset + e.size;
  const S = () => { const [s, q] = netString(b, p); p = q; return s; };
  const B = () => b[p++] !== 0;
  const I = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const U64 = () => { const v = dv.getBigUint64(p, true); p += 8; return v.toString(); };
  if (B()) throw new SaveError('corrupt', 'empty metadata');
  const type = S();
  if (!type.startsWith('SaveGameMetaData,')) throw new SaveError('not-save', 'not a saved game (' + type.split(',')[0] + ')');
  S();
  const n = I();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < n && p < end; i++) {
    if (B()) continue;
    const t = S().split(',')[0], field = S();
    const one = (tt: string): unknown => {
      if (tt === 'System.String' || tt === 'System.DateTime' || tt === 'ColossalFramework.Packaging.Package+Asset') return S();
      if (tt === 'System.Boolean') return B();
      if (tt === 'ModInfo') return [S(), U64()];
      throw new SaveError('corrupt', 'unexpected metadata field type ' + tt);
    };
    if (t.endsWith('[]')) { const k = I(); const arr: unknown[] = []; for (let j = 0; j < k; j++) arr.push(one(t.slice(0, -2))); out[field] = arr; }
    else out[field] = one(t);
  }
  return out as SaveMeta;
}

// ------------------------------------------------------------------ DataSerializer stream
/** A shared string we could not resolve (it was first written in a section we skipped). */
export const UNRESOLVED = '\u0000unresolved';

export class Stream {
  p: number;
  readonly dv: DataView;
  constructor(public readonly b: Uint8Array, p = 0, public strings: string[] = [], public types: string[] = []) {
    this.p = p;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(k: number) { if (this.p + k > this.b.length) throw new SaveError('truncated', 'save data ends early'); }
  u8() { this.need(1); return this.b[this.p++]; }
  i8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p); this.p += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.p); this.p += 2; return v; }
  u24() { this.need(3); const b = this.b, p = this.p; this.p += 3; return (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p); this.p += 4; return v; }
  i64() { this.need(8); const v = this.dv.getBigInt64(this.p); this.p += 8; return v; }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.p); this.p += 8; return v; }
  bool() { return this.u8() === 1; }
  /** float32, returned exactly (a JS number holds every float32 value) */
  f32() { this.need(4); const v = this.dv.getFloat32(this.p); this.p += 4; return v; }
  vec3(): [number, number, number] { return [this.f32(), this.f32(), this.f32()]; }
  skip(k: number) { this.need(k); this.p += k; }

  /** WriteUniqueString: 24-bit length (high bit = 8-bit chars), chars delta-coded from 0x80 */
  ustr(): string | null {
    const n0 = this.u8();
    if (n0 === 255) return null;
    let n = (n0 << 16) | this.u16();
    let c = 0x80;
    const out: string[] = [];
    if (n & 0x800000) {
      n &= 0x7fffff; this.need(n);
      for (let i = 0; i < n; i++) { c = (c + this.b[this.p++]) & 0xff; out.push(String.fromCharCode(c)); }
    } else {
      this.need(n * 2);
      for (let i = 0; i < n; i++) { c = (c + this.u16()) & 0xffff; out.push(String.fromCharCode(c)); }
    }
    return out.join('');
  }
  /** WriteSharedString: 254 = new string, 255 = null, else a 16-bit index into the strings seen so far */
  sstr(): string | null {
    const x = this.u8();
    if (x === 255) return null;
    if (x === 254) { const v = this.ustr() ?? ''; this.strings.push(v); return v; }
    const i = (x << 8) | this.u8();
    return i < this.strings.length ? this.strings[i] : UNRESOLVED;
  }
  stype(): string | null {
    const x = this.u8();
    if (x === 255) return null;
    if (x === 254) { const v = (this.ustr() ?? '').split(',')[0]; this.types.push(v); return v; }
    const i = (x << 8) | this.u8();
    return i < this.types.length ? this.types[i] : UNRESOLVED;
  }
  /** WriteObject header (the object's own fields are written after all managers; callers only consume this) */
  obj(): string | null {
    const x = this.u8();
    if (x === 255) return null;
    if (x === 254) return this.stype();
    this.skip(2);
    return 'ref';
  }
  /** length-prefixed arrays (WriteByteArray etc.); null when the writer passed null */
  private len(): number | null { const n0 = this.u8(); if (n0 === 255) return null; return (n0 << 16) | this.u16(); }
  bytes(): Uint8Array | null { const n = this.len(); if (n === null) return null; this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  arr<T>(f: () => T): T[] | null { const n = this.len(); if (n === null) return null; const o: T[] = []; for (let i = 0; i < n; i++) o.push(f()); return o; }

  // ---------------------------------------------------------------- EncodedArray
  // Run-length/delta coding per column. Control byte: >=128 repeat the last delta (c-127 times);
  // 64..127 "close" values = delta-of-delta (c-63 of them, narrow type); <64 full values (c+1 of them).
  // Byte and Float have no "close" mode. Values wrap at the column's width like the game's C# casts.

  private eaInt(n: number, out: { [i: number]: number; length: number }, bits: 16 | 32, signed: boolean, closeRead: () => number, fullRead: () => number) {
    const wrap = bits === 16
      ? (signed ? (v: number) => ((v + 32768) & 0xffff) - 32768 : (v: number) => v & 0xffff)
      : (signed ? (v: number) => v | 0 : (v: number) => v >>> 0);
    const wrapD = bits === 16 ? (v: number) => ((v + 32768) & 0xffff) - 32768 : (v: number) => v | 0;
    let pv = 0, pd = 0, same = 0, close = 0, full = 0;
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (same) { pv = wrap(pv + pd); same--; break; }
        if (close) { pd = wrapD(pd + closeRead()); pv = wrap(pv + pd); close--; break; }
        if (full) { const v = fullRead(); pd = wrapD(v - pv); pv = wrap(pv + pd); full--; break; }
        const c = this.u8();
        if (c >= 128) same = c - 127; else if (c >= 64) close = c - 63; else full = c + 1;
      }
      out[i] = pv;
    }
  }
  eaU16(n: number, out = new Uint16Array(n)) { this.eaInt(n, out, 16, false, () => this.i8(), () => this.u16()); return out; }
  eaI16(n: number, out = new Int16Array(n)) { this.eaInt(n, out, 16, true, () => this.i8(), () => this.i16()); return out; }
  eaU32(n: number, out = new Uint32Array(n)) { this.eaInt(n, out, 32, false, () => this.i16(), () => this.u32()); return out; }
  eaI32(n: number, out = new Int32Array(n)) { this.eaInt(n, out, 32, true, () => this.i16(), () => this.i32()); return out; }
  eaU8(n: number, out = new Uint8Array(n)) {
    let pv = 0, pd = 0, same = 0, full = 0;
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (same) { pv = (pv + pd) & 0xff; same--; break; }
        if (full) { const v = this.u8(); pd = (((v - pv) + 128) & 0xff) - 128; pv = (pv + pd) & 0xff; full--; break; }
        const c = this.u8();
        if (c >= 128) same = c - 127; else full = c + 1;
      }
      out[i] = pv;
    }
    return out;
  }
  eaF32(n: number, out = new Float32Array(n)) {
    let pv = 0, pd = 0, same = 0, full = 0;
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (same) { pv = Math.fround(pv + pd); same--; break; }
        if (full) { const v = this.f32(); pd = Math.fround(v - pv); pv = Math.fround(pv + pd); full--; break; }
        const c = this.u8();
        if (c >= 128) same = c - 127; else full = c + 1;
      }
      out[i] = pv;
    }
    return out;
  }
  /** 64-bit columns (Long/ULong): close = Int32 delta, full = Int64. Returned as BigInt. */
  eaI64(n: number): BigInt64Array {
    const out = new BigInt64Array(n);
    let pv = 0n, pd = 0n, same = 0, close = 0, full = 0;
    const w = (v: bigint) => BigInt.asIntN(64, v);
    for (let i = 0; i < n; i++) {
      for (;;) {
        if (same) { pv = w(pv + pd); same--; break; }
        if (close) { pd = w(pd + BigInt(this.i32())); pv = w(pv + pd); close--; break; }
        if (full) { const v = this.i64(); pd = w(v - pv); pv = w(pv + pd); full--; break; }
        const c = this.u8();
        if (c >= 128) same = c - 127; else if (c >= 64) close = c - 63; else full = c + 1;
      }
      out[i] = pv;
    }
    return out;
  }
  /** EncodedArray.Bool: bits packed LSB-first into an EncodedArray.Byte column */
  eaBool(n: number): Uint8Array {
    const bytes = this.eaU8((n + 7) >> 3);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
    return out;
  }
}

// ------------------------------------------------------------------ sections
/**
 * Save formats (BuildConfig.SAVE_DATA_FORMAT_VERSION) verified against real save/export pairs. 121034 is the
 * current game; 118011 the build before it. Readers branch on `SaveData.version` where the game's own
 * Deserialize does. Anything else is refused rather than guessed.
 */
export const SUPPORTED_FORMATS: readonly number[] = [118011, 121034];

/** The manager order of SimulationManager.Data (vanilla 1.17+). Each is wrapped in Begin/EndSerialize tags. */
export const MANAGERS = ['SimulationManager', 'GameAreaManager', 'TerrainManager', 'WaterSimulation', 'InstanceManager', 'NetManager', 'BuildingManager', 'CitizenManager', 'TransferManager', 'NaturalResourceManager', 'ImmaterialResourceManager', 'ElectricityManager', 'WaterManager', 'ZoneManager', 'PropManager', 'TreeManager', 'WeatherManager', 'VehicleManager', 'TransportManager', 'EconomyManager', 'DistrictManager', 'EventManager', 'DisasterManager', 'InfoManager', 'AudioManager', 'StatisticsManager', 'UnlockManager', 'MessageManager', 'GuideManager', 'PathManager'] as const;
export type Manager = typeof MANAGERS[number];

function tagBytes(name: string): Uint8Array {
  const out = new Uint8Array(4 + name.length);
  out[0] = 254; const n = name.length | 0x800000;
  out[1] = n >> 16; out[2] = (n >> 8) & 0xff; out[3] = n & 0xff;
  let c = 0x80;
  for (let i = 0; i < name.length; i++) { const ch = name.charCodeAt(i); out[4 + i] = (ch - c) & 0xff; c = ch; }
  return out;
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0], last = hay.length - needle.length;
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= last; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export interface SaveData {
  bytes: Uint8Array;
  version: number;
  /** in-game date and time (SimulationMetaData.m_currentDateTime), ISO without zone */
  gameDate: string | null;
  cityName: string | null;
  /** the city drives on the left (SimulationMetaData.m_invertTraffic == True; the game treats Undefined as right-hand) */
  leftHandTraffic: boolean;
  /** byte offset of each manager's begin tag, in stream order */
  sections: Map<Manager, number>;
  /** mod data blobs stored by the save (SimulationManager.m_serializableDataStorage) */
  modData: Map<string, Uint8Array>;
}

const TICKS_EPOCH = 621355968000000000n; // .NET ticks at 1970-01-01

/** Open the `_Data` stream: header, metadata, section offsets and mod blobs. */
export function openSaveData(bytes: Uint8Array): SaveData {
  const s = new Stream(bytes);
  const version = s.u32();
  if (s.obj() !== 'SimulationMetaData') throw new SaveError('not-save', 'missing simulation metadata');
  if (!SUPPORTED_FORMATS.includes(version)) throw new SaveError('unsupported-version', `save format ${version}`);
  // SimulationMetaData.Serialize
  s.ustr(); s.ustr(); s.ustr(); s.ustr(); s.bool(); s.bool(); s.i64();
  s.ustr(); // map name
  const nOverride = s.i32();
  if (nOverride < 0 || nOverride > 100000) throw new SaveError('corrupt', 'bad metadata');
  for (let i = 0; i < nOverride; i++) { s.ustr(); s.bool(); }
  const invertTraffic = s.u8(); s.u8(); // m_invertTraffic (MetaBool: 0 undefined, 1 false, 2 true), m_disableAchievements
  const ticks = s.i64();
  let gameDate: string | null = null;
  try { gameDate = new Date(Number((ticks - TICKS_EPOCH) / 10000n)).toISOString().slice(0, 19); } catch { gameDate = null; }
  s.f32(); s.u32(); s.u32();
  s.u32(); // m_saveAppVersion: the game build (differs between builds of the same format)
  if (s.u32() !== version) throw new SaveError('corrupt', 'metadata trailer mismatch');

  // second serializer: SimulationManager.Data
  const t = new Stream(bytes, s.p);
  if (t.u32() !== version || t.obj() !== 'SimulationManager+Data') throw new SaveError('corrupt', 'missing simulation data');
  const sections = new Map<Manager, number>();
  sections.set('SimulationManager', t.p);
  if (t.sstr() !== 'SimulationManager') throw new SaveError('corrupt', 'missing SimulationManager section');
  t.skip(4 * 3 + 8 + 4 + 32 * 4);
  const nm = t.u24();
  if (nm > 64) throw new SaveError('corrupt', 'bad manager list');
  for (let i = 0; i < nm; i++) t.obj();
  const modData = new Map<string, Uint8Array>();
  const nStore = t.u32();
  if (nStore > 10000) throw new SaveError('corrupt', 'bad mod data table');
  for (let i = 0; i < nStore; i++) { const k = t.ustr() ?? ''; const v = t.bytes(); if (v) modData.set(k, v); }
  // locate the remaining sections by their begin tags, in order
  let from = t.p;
  for (const m of MANAGERS.slice(1)) {
    const at = indexOf(bytes, tagBytes(m), from);
    if (at < 0) continue; // a manager this save doesn't have
    sections.set(m, at); from = at + 1;
  }
  return { bytes, version, gameDate, cityName: null, leftHandTraffic: invertTraffic === 2, sections, modData };
}

/**
 * Stream positioned just after `name`'s begin tag, plus the offset of the next section.
 * Shared strings written by skipped sections are unknown; the section tags themselves are seeded so
 * end tags and in-section back-references resolve. Call `endSection` after parsing: it proves alignment.
 */
export function section(sd: SaveData, name: Manager): { s: Stream; end: number | null } | null {
  const at = sd.sections.get(name);
  if (at === undefined) return null;
  const order = [...sd.sections.keys()];
  const i = order.indexOf(name);
  const s = new Stream(sd.bytes, at, order.slice(0, i) as string[]);
  if (s.sstr() !== name) throw new SaveError('corrupt', name + ' tag mismatch');
  const next = order[i + 1];
  return { s, end: next ? sd.sections.get(next)! : null };
}

/** Consume the EndSerialize tag and check the parse ended exactly where the next section begins. */
export function endSection(s: Stream, end: number | null, name: string) {
  s.sstr();
  if (end !== null && s.p !== end) throw new SaveError('corrupt', `${name}: parse misaligned by ${end - s.p} bytes`);
}

/** Read a whole file, un-gzipping if needed (browsers' DecompressionStream; works in workers). */
export async function loadBytes(buf: ArrayBuffer): Promise<Uint8Array> {
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new Uint8Array(buf);
}
