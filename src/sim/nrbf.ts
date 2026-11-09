// MS-NRBF (.NET BinaryFormatter) reader. Spec: [MS-NRBF] 2.1-2.7.
// Values: number | boolean | bigint (Int64/UInt64/TimeSpan/DateTime ticks) | string | null | NrbfObject | array.
// Primitive arrays come back as typed arrays where one exists. Multi-dimensional arrays are flattened (row-major).

export class NrbfError extends Error {}

export class NrbfObject {
  constructor(
    /** full .NET type name, e.g. "TrafficManager.Configuration+LaneSpeedLimit" */
    public readonly type: string,
    /** assembly name from the BinaryLibrary record, null for mscorlib (System* records) */
    public readonly library: string | null,
    /** member name -> value; references are resolved after the whole stream is read */
    public readonly fields: Record<string, unknown>,
  ) {}
}

type Meta = { type: string; library: string | null; members: string[]; bt: number[] | null; add: unknown[] };

const REF = Symbol('ref');
type Ref = { [REF]: number };
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && REF in v;

class Nulls { constructor(public n: number) {} }
const END = Symbol('end');
const MAX_DEPTH = 256; // inline nesting only; references don't recurse

export function readNrbf(b: Uint8Array): { root: unknown; end: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const td = new TextDecoder('utf-8', { fatal: false });
  let p = 0;
  const objs = new Map<number, unknown>();
  const metas = new Map<number, Meta>();
  const libs = new Map<number, string>();
  const containers: (Record<string, unknown> | unknown[])[] = []; // anything that may hold a Ref
  let rootId = 0;

  const need = (n: number) => { if (p + n > b.length) throw new NrbfError(`truncated at ${p}`); };
  const u8 = () => { need(1); return b[p++]; };
  const i32 = () => { need(4); const v = dv.getInt32(p, true); p += 4; return v; };
  const count = () => { const n = i32(); if (n < 0 || n > b.length) throw new NrbfError(`bad count ${n} at ${p - 4}`); return n; };
  const lps = () => {
    let n = 0;
    for (let sh = 0; ; sh += 7) {
      if (sh > 28) throw new NrbfError(`bad string length at ${p}`);
      const x = u8(); n |= (x & 0x7f) << sh;
      if (x < 0x80) break;
    }
    need(n); const s = td.decode(b.subarray(p, p + n)); p += n; return s;
  };
  const utf8Char = () => { // Char: one UTF-8 encoded character
    const x = b[p]; const n = x < 0x80 ? 1 : x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : 2;
    need(n); const s = td.decode(b.subarray(p, p + n)); p += n; return s;
  };

  // PrimitiveTypeEnum
  const prim = (t: number): unknown => {
    let v: unknown;
    switch (t) {
      case 1: need(1); return b[p++] !== 0;
      case 2: need(1); return b[p++];
      case 3: return utf8Char();
      case 5: return lps(); // Decimal as its string form
      case 6: need(8); v = dv.getFloat64(p, true); p += 8; return v;
      case 7: need(2); v = dv.getInt16(p, true); p += 2; return v;
      case 8: return i32();
      case 9: case 12: need(8); v = dv.getBigInt64(p, true); p += 8; return v;
      case 10: need(1); return dv.getInt8(p++);
      case 11: need(4); v = dv.getFloat32(p, true); p += 4; return v;
      case 13: need(8); v = dv.getBigUint64(p, true); p += 8; return v; // DateTime: ticks | kind<<62
      case 14: need(2); v = dv.getUint16(p, true); p += 2; return v;
      case 15: need(4); v = dv.getUint32(p, true); p += 4; return v;
      case 16: need(8); v = dv.getBigUint64(p, true); p += 8; return v;
      case 17: return null;
      case 18: return lps();
    }
    throw new NrbfError(`unsupported primitive type ${t} at ${p}`);
  };

  const primArray = (t: number, n: number): unknown => {
    const width: Record<number, number> = { 2: 1, 6: 8, 7: 2, 8: 4, 9: 8, 10: 1, 11: 4, 14: 2, 15: 4, 16: 8 };
    const w = width[t];
    if (w) {
      need(n * w);
      const src = b.slice(p, p + n * w); p += n * w; // copy: aligned and detached from the input
      const buf = src.buffer;
      switch (t) {
        case 2: return src;
        case 6: return new Float64Array(buf);
        case 7: return new Int16Array(buf);
        case 8: return new Int32Array(buf);
        case 9: return new BigInt64Array(buf);
        case 10: return new Int8Array(buf);
        case 11: return new Float32Array(buf);
        case 14: return new Uint16Array(buf);
        case 15: return new Uint32Array(buf);
        case 16: return new BigUint64Array(buf);
      }
    }
    const a: unknown[] = new Array(n);
    for (let i = 0; i < n; i++) a[i] = prim(t);
    return a;
  };

  // MemberTypeInfo: BinaryTypeEnum per member plus its AdditionalInfo
  const typeInfo = (n: number) => {
    const bt: number[] = []; const add: unknown[] = [];
    for (let i = 0; i < n; i++) bt.push(u8());
    for (const t of bt) {
      if (t === 0 || t === 7) add.push(u8());          // Primitive / PrimitiveArray
      else if (t === 3) add.push(lps());               // SystemClass
      else if (t === 4) add.push([lps(), i32()]);      // Class + library id
      else if (t <= 6) add.push(null);                 // String, Object, ObjectArray, StringArray
      else throw new NrbfError(`bad BinaryType ${t} at ${p}`);
    }
    return { bt, add };
  };

  const classInfo = () => {
    const id = i32(); const type = lps(); const n = count();
    const members: string[] = []; for (let i = 0; i < n; i++) members.push(lps());
    return { id, type, members };
  };

  const define = (id: number, v: unknown) => {
    if (id !== 0) { if (objs.has(id)) throw new NrbfError(`object id ${id} defined twice`); objs.set(id, v); }
  };

  const values = (id: number, m: Meta, depth: number): NrbfObject => {
    const fields: Record<string, unknown> = Object.create(null);
    const o = new NrbfObject(m.type, m.library, fields);
    define(id, o);
    for (let i = 0; i < m.members.length; i++) {
      const t = m.bt ? m.bt[i] : 2;
      const v = t === 0 ? prim(m.add[i] as number) : value(depth + 1, false);
      if (v === END) throw new NrbfError(`MessageEnd inside ${m.type} at ${p}`);
      fields[m.members[i]] = v;
    }
    containers.push(fields);
    return o;
  };

  // Array elements: records, where ObjectNullMultiple counts as several nulls.
  const elements = (n: number, depth: number): unknown[] => {
    const a: unknown[] = new Array(n);
    let i = 0;
    while (i < n) {
      const v = value(depth + 1, true);
      if (v === END) throw new NrbfError(`MessageEnd inside array at ${p}`);
      if (v instanceof Nulls) {
        if (i + v.n > n) throw new NrbfError(`null run overflows array at ${p}`);
        for (let k = 0; k < v.n; k++) a[i++] = null;
      } else a[i++] = v;
    }
    containers.push(a);
    return a;
  };

  // One record (after any BinaryLibrary records). Returns the value, a Ref, a Nulls run, or END.
  function value(depth: number, inArray: boolean): unknown {
    if (depth > MAX_DEPTH) throw new NrbfError(`nesting deeper than ${MAX_DEPTH} at ${p}`);
    for (;;) {
      const at = p; const rt = u8();
      switch (rt) {
        case 0: { // SerializedStreamHeader
          rootId = i32(); i32();
          const major = i32(), minor = i32();
          if (major !== 1 || minor !== 0) throw new NrbfError(`unsupported NRBF version ${major}.${minor}`);
          continue;
        }
        case 12: { const id = i32(); libs.set(id, lps()); continue; } // BinaryLibrary
        case 1: { // ClassWithId
          const id = i32(); const mid = i32(); const m = metas.get(mid);
          if (!m) throw new NrbfError(`ClassWithId refers to unknown metadata ${mid} at ${at}`);
          return values(id, m, depth);
        }
        case 2: case 3: case 4: case 5: { // (System)ClassWithMembers[AndTypes]
          const ci = classInfo();
          const ti = rt === 4 || rt === 5 ? typeInfo(ci.members.length) : null;
          let library: string | null = null;
          if (rt === 3 || rt === 5) {
            const lid = i32(); library = libs.get(lid) ?? null;
            if (library === null) throw new NrbfError(`unknown library ${lid} at ${at}`);
          }
          const m: Meta = { type: ci.type, library, members: ci.members, bt: ti?.bt ?? null, add: ti?.add ?? [] };
          metas.set(ci.id, m);
          return values(ci.id, m, depth);
        }
        case 6: { const id = i32(); const s = lps(); define(id, s); return s; } // BinaryObjectString
        case 7: { // BinaryArray
          const id = i32(); const kind = u8(); const rank = count();
          let n = 1; for (let i = 0; i < rank; i++) n *= count();
          if (n > b.length * 8) throw new NrbfError(`array too large at ${at}`);
          if (kind >= 3 && kind <= 5) for (let i = 0; i < rank; i++) i32(); // lower bounds
          else if (kind > 5) throw new NrbfError(`bad BinaryArrayType ${kind} at ${at}`);
          const ti = typeInfo(1);
          const a = ti.bt[0] === 0 ? primArray(ti.add[0] as number, n) : elements(n, depth);
          define(id, a); return a;
        }
        case 8: return prim(u8()); // MemberPrimitiveTyped
        case 9: return { [REF]: i32() } as Ref; // MemberReference
        case 10: return null; // ObjectNull
        case 11: return END; // MessageEnd
        case 13: if (!inArray) break; return new Nulls(u8()); // ObjectNullMultiple256
        case 14: if (!inArray) break; return new Nulls(count()); // ObjectNullMultiple
        case 15: { const id = i32(); const n = count(); const a = primArray(u8(), n); define(id, a); return a; } // ArraySinglePrimitive
        case 16: case 17: { const id = i32(); const n = count(); const a = elements(n, depth); define(id, a); return a; } // ArraySingleObject / ArraySingleString
      }
      throw new NrbfError(`unsupported record type ${rt} at ${at}`); // 21/22 (remoting), or a null run outside an array
    }
  }

  if (u8() !== 0) throw new NrbfError('missing SerializedStreamHeader');
  p = 0;
  for (;;) {
    const v = value(0, false);
    if (v === END) break;
  }

  // Resolve references in place (iterative; cycles become real JS cycles).
  const get = (r: Ref) => {
    const id = r[REF];
    if (!objs.has(id)) throw new NrbfError(`unresolved reference ${id}`);
    return objs.get(id);
  };
  for (const c of containers) {
    if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) if (isRef(c[i])) c[i] = get(c[i] as Ref); }
    else for (const k in c) if (isRef(c[k])) c[k] = get(c[k] as Ref);
  }
  if (!objs.has(rootId)) throw new NrbfError(`root object ${rootId} missing`);
  return { root: objs.get(rootId), end: p };
}

/** List<T> / T[] -> the live elements (List._items is padded to capacity; _size is the real count). */
export function nrbfList(v: unknown): unknown[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  if (v instanceof NrbfObject && '_items' in v.fields && '_size' in v.fields) {
    const items = v.fields._items, n = v.fields._size;
    if (!Array.isArray(items) || typeof n !== 'number' || n < 0 || n > items.length) throw new NrbfError(`malformed List ${v.type}`);
    return items.slice(0, n);
  }
  throw new NrbfError(`not a list: ${v instanceof NrbfObject ? v.type : typeof v}`);
}
