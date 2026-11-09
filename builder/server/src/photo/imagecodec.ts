// Tiny image codecs for the segmentation MOCK (local dev only): PNG decode/encode and a baseline JPEG
// decoder. Runtime-agnostic (Workers + Node ≥ 18: CompressionStream/DecompressionStream, no Node imports).
// The real cut-out path never decodes pixels on the server: masks from fal are passed through untouched,
// because the Cloudflare free plan allows only ~10 ms CPU per request (pixel work happens in the browser).

export interface RGBImage {
  width: number;
  height: number;
  /** RGB, 3 bytes per pixel, row-major. */
  data: Uint8Array;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const out = new Response(src.pipeThrough(stream as unknown as { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }));
  return new Uint8Array(await out.arrayBuffer());
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Encode an 8-bit greyscale image (one byte per pixel) as PNG. */
export async function encodeGrayPng(width: number, height: number, gray: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = await pipe(raw, new CompressionStream('deflate'));
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(PNG_SIG, 0);
  let off = 8;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}

/** Decode an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA, palette) to RGB. */
export async function decodePng(bytes: Uint8Array): Promise<RGBImage> {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error('unsupported PNG (needs 8-bit, non-interlaced)');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels) throw new Error('unsupported PNG colour type');
  const zlen = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(zlen);
  let zo = 0;
  for (const c of idat) {
    z.set(c, zo);
    zo += c.length;
  }
  const raw = await pipe(z, new DecompressionStream('deflate'));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, n = width * height; i < n; i++) {
    let r: number, g: number, bl: number;
    if (ctype === 0 || ctype === 4) r = g = bl = px[i * channels];
    else if (ctype === 3) {
      const k = px[i] * 3;
      r = palette?.[k] ?? 0; g = palette?.[k + 1] ?? 0; bl = palette?.[k + 2] ?? 0;
    } else {
      r = px[i * channels]; g = px[i * channels + 1]; bl = px[i * channels + 2];
    }
    // Composite alpha over white (a transparent background reads as "plain background").
    if (ctype === 4 || ctype === 6) {
      const al = px[i * channels + channels - 1] / 255;
      r = Math.round(r * al + 255 * (1 - al));
      g = Math.round(g * al + 255 * (1 - al));
      bl = Math.round(bl * al + 255 * (1 - al));
    }
    data[i * 3] = r; data[i * 3 + 1] = g; data[i * 3 + 2] = bl;
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- baseline JPEG

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

interface Huff {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  vals: Uint8Array;
}

function buildHuff(counts: Uint8Array, vals: Uint8Array): Huff {
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    if (n) {
      valptr[l] = k;
      mincode[l] = code;
      code += n;
      k += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, valptr, mincode, vals };
}

// IDCT basis: C[x][u] = c(u) cos((2x+1)uπ/16) / 2
const IDCT = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x++)
    for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2;
  return t;
})();

/** Decode a baseline (SOF0/SOF1, Huffman) JPEG to RGB. Throws on progressive/arithmetic JPEGs. */
export function decodeJpeg(bytes: Uint8Array): RGBImage {
  const qt: Int32Array[] = [];
  const dcT: Huff[] = [];
  const acT: Huff[] = [];
  let width = 0, height = 0, restart = 0;
  let comps: Array<{ id: number; h: number; v: number; tq: number; bw: number; bh: number; plane: Uint8Array; pred: number; td: number; ta: number }> = [];
  let hmax = 1, vmax = 1;
  let p = 2;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  for (;;) {
    while (p < bytes.length && bytes[p] !== 0xff) p++;
    while (bytes[p] === 0xff) p++;
    const m = bytes[p++];
    if (p >= bytes.length || m === 0xd9) break;
    const len = u16(p);
    const seg = p + 2;
    if (m === 0xdb) {
      let q = seg;
      while (q < p + len) {
        const pq = bytes[q] >> 4, tq = bytes[q] & 15;
        q++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          t[i] = pq ? u16(q) : bytes[q];
          q += pq ? 2 : 1;
        }
        qt[tq] = t;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      height = u16(seg + 1);
      width = u16(seg + 3);
      const n = bytes[seg + 5];
      comps = [];
      for (let i = 0; i < n; i++) {
        const b = seg + 6 + i * 3;
        comps.push({ id: bytes[b], h: bytes[b + 1] >> 4, v: bytes[b + 1] & 15, tq: bytes[b + 2], bw: 0, bh: 0, plane: new Uint8Array(0), pred: 0, td: 0, ta: 0 });
      }
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error('unsupported JPEG (progressive or arithmetic)');
    } else if (m === 0xc4) {
      let q = seg;
      while (q < p + len) {
        const tc = bytes[q] >> 4, th = bytes[q] & 15;
        const counts = bytes.subarray(q + 1, q + 17);
        const total = counts.reduce((s, c) => s + c, 0);
        const vals = bytes.slice(q + 17, q + 17 + total);
        (tc ? acT : dcT)[th] = buildHuff(counts, vals);
        q += 17 + total;
      }
    } else if (m === 0xdd) {
      restart = u16(seg);
    } else if (m === 0xda) {
      const ns = bytes[seg];
      const scan = [];
      for (let i = 0; i < ns; i++) {
        const c = comps.find((k) => k.id === bytes[seg + 1 + i * 2]);
        if (!c) throw new Error('bad JPEG scan');
        c.td = bytes[seg + 2 + i * 2] >> 4;
        c.ta = bytes[seg + 2 + i * 2] & 15;
        scan.push(c);
      }
      p = seg + 1 + ns * 2 + 3;
      p = decodeScan(bytes, p, width, height, hmax, vmax, scan, qt, dcT, acT, restart);
      continue;
    }
    p += len;
  }
  if (!width || !comps.length || !comps[0].plane.length) throw new Error('JPEG has no image data');
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (c: (typeof comps)[number]) => c.plane[((y * c.v) / vmax | 0) * c.bw * 8 + ((x * c.h) / hmax | 0)];
      const o = (y * width + x) * 3;
      if (comps.length >= 3) {
        const Y = s(comps[0]), cb = s(comps[1]) - 128, cr = s(comps[2]) - 128;
        out[o] = clamp8(Y + 1.402 * cr);
        out[o + 1] = clamp8(Y - 0.344136 * cb - 0.714136 * cr);
        out[o + 2] = clamp8(Y + 1.772 * cb);
      } else {
        out[o] = out[o + 1] = out[o + 2] = s(comps[0]);
      }
    }
  }
  return { width, height, data: out };
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function decodeScan(
  bytes: Uint8Array,
  start: number,
  width: number,
  height: number,
  hmax: number,
  vmax: number,
  scan: Array<{ h: number; v: number; tq: number; bw: number; bh: number; plane: Uint8Array; pred: number; td: number; ta: number }>,
  qt: Int32Array[],
  dcT: Huff[],
  acT: Huff[],
  restart: number,
): number {
  const mcuX = Math.ceil(width / (8 * hmax));
  const mcuY = Math.ceil(height / (8 * vmax));
  const single = scan.length === 1;
  for (const c of scan) {
    c.bw = mcuX * c.h;
    c.bh = mcuY * c.v;
    c.plane = new Uint8Array(c.bw * 8 * c.bh * 8);
    c.pred = 0;
  }
  let p = start, bitBuf = 0, bitCnt = 0;
  const readBit = (): number => {
    if (bitCnt === 0) {
      let b = bytes[p++];
      if (b === 0xff) {
        const n = bytes[p];
        if (n === 0) p++;
        else {
          // Hit a marker (RSTn / EOI) before the data ran out: stay on it and pad with zero bits.
          p--;
          b = 0;
        }
      }
      bitBuf = b ?? 0;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };
  const receive = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };
  const extend = (v: number, n: number) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decodeHuff = (h: Huff) => {
    let code = 0;
    for (let l = 1; l <= 16; l++) {
      code = (code << 1) | readBit();
      if (code <= h.maxcode[l]) return h.vals[h.valptr[l] + code - h.mincode[l]];
    }
    return 0;
  };
  const coef = new Float32Array(64);
  const tmp = new Float32Array(64);
  const block = (c: (typeof scan)[number], bx: number, by: number) => {
    coef.fill(0);
    const q = qt[c.tq];
    const t = decodeHuff(dcT[c.td]);
    c.pred += t ? extend(receive(t), t) : 0;
    coef[0] = c.pred * q[0];
    for (let k = 1; k < 64; ) {
      const rs = decodeHuff(acT[c.ta]);
      const r = rs >> 4, s = rs & 15;
      if (s === 0) {
        if (r !== 15) break;
        k += 16;
        continue;
      }
      k += r;
      if (k > 63) break;
      coef[ZIGZAG[k]] = extend(receive(s), s) * q[k];
      k++;
    }
    // Separable IDCT: rows then columns.
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) s += IDCT[x * 8 + u] * coef[y * 8 + u];
        tmp[y * 8 + x] = s;
      }
    const stride = c.bw * 8;
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let s = 0;
        for (let v = 0; v < 8; v++) s += IDCT[y * 8 + v] * tmp[v * 8 + x];
        c.plane[(by * 8 + y) * stride + bx * 8 + x] = clamp8(s + 128);
      }
  };
  const resetAtRestart = () => {
    bitCnt = 0;
    // Skip to and past the RSTn marker.
    while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7)) p++;
    p += 2;
    for (const c of scan) c.pred = 0;
  };
  if (single) {
    // Non-interleaved scan: blocks in raster order over the component's own extent.
    const c = scan[0];
    const bxN = Math.ceil((Math.ceil((width * c.h) / hmax)) / 8);
    const byN = Math.ceil((Math.ceil((height * c.v) / vmax)) / 8);
    let n = 0;
    for (let by = 0; by < byN; by++)
      for (let bx = 0; bx < bxN; bx++) {
        if (restart && n > 0 && n % restart === 0) resetAtRestart();
        block(c, bx, by);
        n++;
      }
  } else {
    let n = 0;
    for (let my = 0; my < mcuY; my++)
      for (let mx = 0; mx < mcuX; mx++) {
        if (restart && n > 0 && n % restart === 0) resetAtRestart();
        for (const c of scan)
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, mx * c.h + h, my * c.v + v);
        n++;
      }
  }
  // Continue after the entropy-coded data (next marker that is not RSTn / stuffing).
  while (p < bytes.length - 1 && !(bytes[p] === 0xff && bytes[p + 1] !== 0 && !(bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7))) p++;
  return p;
}

/** Decode a JPEG or PNG (by magic bytes). */
export async function decodeImage(bytes: Uint8Array): Promise<RGBImage> {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return decodePng(bytes);
  return decodeJpeg(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
