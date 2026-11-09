// MD5 (RFC 1321) of a byte array, as lowercase hex. The game stores each package asset's MD5
// (SecurityHelper.CalculateChecksum) in the .crp header, so it proves a save's data is intact.
// Web Crypto has no MD5, hence this small unrolled implementation.

export function md5(data: Uint8Array): string {
  const n = data.length, full = n - (n % 64);
  // little-endian words; every browser host is little-endian, but don't assume it
  const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const st = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]);
  const CHUNK = 1 << 20; // copy through an aligned buffer when the input isn't 4-byte aligned
  if (le && data.byteOffset % 4 === 0) blocks(new Int32Array(data.buffer, data.byteOffset, full >> 2), full >> 2, st);
  else {
    const tmp = new Uint8Array(CHUNK), w = new Int32Array(tmp.buffer);
    for (let off = 0; off < full; off += CHUNK) {
      const len = Math.min(CHUNK, full - off);
      tmp.set(data.subarray(off, off + len));
      if (!le) for (let i = 0; i < len; i += 4) w[i >> 2] = tmp[i] | (tmp[i + 1] << 8) | (tmp[i + 2] << 16) | (tmp[i + 3] << 24);
      blocks(w, len >> 2, st);
    }
  }
  // tail: remaining bytes, 0x80, zero padding, 64-bit length in bits
  const tailLen = (n % 64) < 56 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(data.subarray(full)); tail[n - full] = 0x80;
  const bits = n * 8;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tailLen - 8, bits >>> 0, true); tv.setUint32(tailLen - 4, Math.floor(bits / 2 ** 32), true);
  const tw = new Int32Array(tailLen >> 2);
  for (let i = 0; i < tw.length; i++) tw[i] = tv.getInt32(i * 4, true);
  blocks(tw, tw.length, st);
  const out = new DataView(new ArrayBuffer(16));
  for (let i = 0; i < 4; i++) out.setInt32(i * 4, st[i], true);
  return [...new Uint8Array(out.buffer)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function blocks(w: Int32Array, words: number, st: Int32Array) {
  let a0 = st[0], b0 = st[1], c0 = st[2], d0 = st[3];
  for (let o = 0; o < words; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    a = ((a + ((b & c) | (~b & d)) + -680876936 + w[o + 0]) | 0); a = ((a << 7) | (a >>> 25)) + b | 0;
    d = ((d + ((a & b) | (~a & c)) + -389564586 + w[o + 1]) | 0); d = ((d << 12) | (d >>> 20)) + a | 0;
    c = ((c + ((d & a) | (~d & b)) + 606105819 + w[o + 2]) | 0); c = ((c << 17) | (c >>> 15)) + d | 0;
    b = ((b + ((c & d) | (~c & a)) + -1044525330 + w[o + 3]) | 0); b = ((b << 22) | (b >>> 10)) + c | 0;
    a = ((a + ((b & c) | (~b & d)) + -176418897 + w[o + 4]) | 0); a = ((a << 7) | (a >>> 25)) + b | 0;
    d = ((d + ((a & b) | (~a & c)) + 1200080426 + w[o + 5]) | 0); d = ((d << 12) | (d >>> 20)) + a | 0;
    c = ((c + ((d & a) | (~d & b)) + -1473231341 + w[o + 6]) | 0); c = ((c << 17) | (c >>> 15)) + d | 0;
    b = ((b + ((c & d) | (~c & a)) + -45705983 + w[o + 7]) | 0); b = ((b << 22) | (b >>> 10)) + c | 0;
    a = ((a + ((b & c) | (~b & d)) + 1770035416 + w[o + 8]) | 0); a = ((a << 7) | (a >>> 25)) + b | 0;
    d = ((d + ((a & b) | (~a & c)) + -1958414417 + w[o + 9]) | 0); d = ((d << 12) | (d >>> 20)) + a | 0;
    c = ((c + ((d & a) | (~d & b)) + -42063 + w[o + 10]) | 0); c = ((c << 17) | (c >>> 15)) + d | 0;
    b = ((b + ((c & d) | (~c & a)) + -1990404162 + w[o + 11]) | 0); b = ((b << 22) | (b >>> 10)) + c | 0;
    a = ((a + ((b & c) | (~b & d)) + 1804603682 + w[o + 12]) | 0); a = ((a << 7) | (a >>> 25)) + b | 0;
    d = ((d + ((a & b) | (~a & c)) + -40341101 + w[o + 13]) | 0); d = ((d << 12) | (d >>> 20)) + a | 0;
    c = ((c + ((d & a) | (~d & b)) + -1502002290 + w[o + 14]) | 0); c = ((c << 17) | (c >>> 15)) + d | 0;
    b = ((b + ((c & d) | (~c & a)) + 1236535329 + w[o + 15]) | 0); b = ((b << 22) | (b >>> 10)) + c | 0;
    a = ((a + ((d & b) | (~d & c)) + -165796510 + w[o + 1]) | 0); a = ((a << 5) | (a >>> 27)) + b | 0;
    d = ((d + ((c & a) | (~c & b)) + -1069501632 + w[o + 6]) | 0); d = ((d << 9) | (d >>> 23)) + a | 0;
    c = ((c + ((b & d) | (~b & a)) + 643717713 + w[o + 11]) | 0); c = ((c << 14) | (c >>> 18)) + d | 0;
    b = ((b + ((a & c) | (~a & d)) + -373897302 + w[o + 0]) | 0); b = ((b << 20) | (b >>> 12)) + c | 0;
    a = ((a + ((d & b) | (~d & c)) + -701558691 + w[o + 5]) | 0); a = ((a << 5) | (a >>> 27)) + b | 0;
    d = ((d + ((c & a) | (~c & b)) + 38016083 + w[o + 10]) | 0); d = ((d << 9) | (d >>> 23)) + a | 0;
    c = ((c + ((b & d) | (~b & a)) + -660478335 + w[o + 15]) | 0); c = ((c << 14) | (c >>> 18)) + d | 0;
    b = ((b + ((a & c) | (~a & d)) + -405537848 + w[o + 4]) | 0); b = ((b << 20) | (b >>> 12)) + c | 0;
    a = ((a + ((d & b) | (~d & c)) + 568446438 + w[o + 9]) | 0); a = ((a << 5) | (a >>> 27)) + b | 0;
    d = ((d + ((c & a) | (~c & b)) + -1019803690 + w[o + 14]) | 0); d = ((d << 9) | (d >>> 23)) + a | 0;
    c = ((c + ((b & d) | (~b & a)) + -187363961 + w[o + 3]) | 0); c = ((c << 14) | (c >>> 18)) + d | 0;
    b = ((b + ((a & c) | (~a & d)) + 1163531501 + w[o + 8]) | 0); b = ((b << 20) | (b >>> 12)) + c | 0;
    a = ((a + ((d & b) | (~d & c)) + -1444681467 + w[o + 13]) | 0); a = ((a << 5) | (a >>> 27)) + b | 0;
    d = ((d + ((c & a) | (~c & b)) + -51403784 + w[o + 2]) | 0); d = ((d << 9) | (d >>> 23)) + a | 0;
    c = ((c + ((b & d) | (~b & a)) + 1735328473 + w[o + 7]) | 0); c = ((c << 14) | (c >>> 18)) + d | 0;
    b = ((b + ((a & c) | (~a & d)) + -1926607734 + w[o + 12]) | 0); b = ((b << 20) | (b >>> 12)) + c | 0;
    a = ((a + (b ^ c ^ d) + -378558 + w[o + 5]) | 0); a = ((a << 4) | (a >>> 28)) + b | 0;
    d = ((d + (a ^ b ^ c) + -2022574463 + w[o + 8]) | 0); d = ((d << 11) | (d >>> 21)) + a | 0;
    c = ((c + (d ^ a ^ b) + 1839030562 + w[o + 11]) | 0); c = ((c << 16) | (c >>> 16)) + d | 0;
    b = ((b + (c ^ d ^ a) + -35309556 + w[o + 14]) | 0); b = ((b << 23) | (b >>> 9)) + c | 0;
    a = ((a + (b ^ c ^ d) + -1530992060 + w[o + 1]) | 0); a = ((a << 4) | (a >>> 28)) + b | 0;
    d = ((d + (a ^ b ^ c) + 1272893353 + w[o + 4]) | 0); d = ((d << 11) | (d >>> 21)) + a | 0;
    c = ((c + (d ^ a ^ b) + -155497632 + w[o + 7]) | 0); c = ((c << 16) | (c >>> 16)) + d | 0;
    b = ((b + (c ^ d ^ a) + -1094730640 + w[o + 10]) | 0); b = ((b << 23) | (b >>> 9)) + c | 0;
    a = ((a + (b ^ c ^ d) + 681279174 + w[o + 13]) | 0); a = ((a << 4) | (a >>> 28)) + b | 0;
    d = ((d + (a ^ b ^ c) + -358537222 + w[o + 0]) | 0); d = ((d << 11) | (d >>> 21)) + a | 0;
    c = ((c + (d ^ a ^ b) + -722521979 + w[o + 3]) | 0); c = ((c << 16) | (c >>> 16)) + d | 0;
    b = ((b + (c ^ d ^ a) + 76029189 + w[o + 6]) | 0); b = ((b << 23) | (b >>> 9)) + c | 0;
    a = ((a + (b ^ c ^ d) + -640364487 + w[o + 9]) | 0); a = ((a << 4) | (a >>> 28)) + b | 0;
    d = ((d + (a ^ b ^ c) + -421815835 + w[o + 12]) | 0); d = ((d << 11) | (d >>> 21)) + a | 0;
    c = ((c + (d ^ a ^ b) + 530742520 + w[o + 15]) | 0); c = ((c << 16) | (c >>> 16)) + d | 0;
    b = ((b + (c ^ d ^ a) + -995338651 + w[o + 2]) | 0); b = ((b << 23) | (b >>> 9)) + c | 0;
    a = ((a + (c ^ (b | ~d)) + -198630844 + w[o + 0]) | 0); a = ((a << 6) | (a >>> 26)) + b | 0;
    d = ((d + (b ^ (a | ~c)) + 1126891415 + w[o + 7]) | 0); d = ((d << 10) | (d >>> 22)) + a | 0;
    c = ((c + (a ^ (d | ~b)) + -1416354905 + w[o + 14]) | 0); c = ((c << 15) | (c >>> 17)) + d | 0;
    b = ((b + (d ^ (c | ~a)) + -57434055 + w[o + 5]) | 0); b = ((b << 21) | (b >>> 11)) + c | 0;
    a = ((a + (c ^ (b | ~d)) + 1700485571 + w[o + 12]) | 0); a = ((a << 6) | (a >>> 26)) + b | 0;
    d = ((d + (b ^ (a | ~c)) + -1894986606 + w[o + 3]) | 0); d = ((d << 10) | (d >>> 22)) + a | 0;
    c = ((c + (a ^ (d | ~b)) + -1051523 + w[o + 10]) | 0); c = ((c << 15) | (c >>> 17)) + d | 0;
    b = ((b + (d ^ (c | ~a)) + -2054922799 + w[o + 1]) | 0); b = ((b << 21) | (b >>> 11)) + c | 0;
    a = ((a + (c ^ (b | ~d)) + 1873313359 + w[o + 8]) | 0); a = ((a << 6) | (a >>> 26)) + b | 0;
    d = ((d + (b ^ (a | ~c)) + -30611744 + w[o + 15]) | 0); d = ((d << 10) | (d >>> 22)) + a | 0;
    c = ((c + (a ^ (d | ~b)) + -1560198380 + w[o + 6]) | 0); c = ((c << 15) | (c >>> 17)) + d | 0;
    b = ((b + (d ^ (c | ~a)) + 1309151649 + w[o + 13]) | 0); b = ((b << 21) | (b >>> 11)) + c | 0;
    a = ((a + (c ^ (b | ~d)) + -145523070 + w[o + 4]) | 0); a = ((a << 6) | (a >>> 26)) + b | 0;
    d = ((d + (b ^ (a | ~c)) + -1120210379 + w[o + 11]) | 0); d = ((d << 10) | (d >>> 22)) + a | 0;
    c = ((c + (a ^ (d | ~b)) + 718787259 + w[o + 2]) | 0); c = ((c << 15) | (c >>> 17)) + d | 0;
    b = ((b + (d ^ (c | ~a)) + -343485551 + w[o + 9]) | 0); b = ((b << 21) | (b >>> 11)) + c | 0;
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  st[0] = a0; st[1] = b0; st[2] = c0; st[3] = d0;
}
