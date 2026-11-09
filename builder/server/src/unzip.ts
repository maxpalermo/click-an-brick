// Minimal pure-JS ZIP extractor (store + deflate, zip64 aware). No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u64(buf: Buffer, off: number): number {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip: 64-bit value too large');
  return Number(v);
}

export interface UnzipResult {
  files: number;
  bytes: number;
}

/**
 * Extract every entry of `zipPath` into `destDir`. Rejects entries that would escape destDir.
 * `onProgress(done, total)` is called periodically.
 */
export function extractZip(
  zipPath: string,
  destDir: string,
  onProgress?: (done: number, total: number) => void,
): UnzipResult {
  const buf = fs.readFileSync(zipPath);
  const destAbs = path.resolve(destDir);

  // Locate End Of Central Directory (scan backwards; comment may be up to 64KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found (corrupt or not a zip)');

  let total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  if (total === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_ZIP64_LOCATOR) throw new Error('zip: zip64 locator missing');
    const z64 = u64(buf, loc + 8);
    if (buf.readUInt32LE(z64) !== SIG_ZIP64_EOCD) throw new Error('zip: zip64 EOCD missing');
    total = u64(buf, z64 + 32);
    cdOffset = u64(buf, z64 + 48);
  }

  const madeDirs = new Set<string>();
  const ensureDir = (d: string) => {
    if (madeDirs.has(d)) return;
    fs.mkdirSync(d, { recursive: true });
    madeDirs.add(d);
  };

  let p = cdOffset;
  let files = 0;
  let bytes = 0;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`zip: bad central directory entry #${n}`);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');

    // zip64 extended info
    if (size === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(buf, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(buf, q); q += 8; }
          if (localOff === 0xffffffff) { localOff = u64(buf, q); q += 8; }
          break;
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;

    const outPath = path.resolve(destAbs, name);
    if (outPath !== destAbs && !outPath.startsWith(destAbs + path.sep)) {
      throw new Error(`zip: entry escapes destination: ${name}`);
    }
    if (name.endsWith('/')) {
      ensureDir(outPath);
      continue;
    }

    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error(`zip: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`zip: size mismatch for ${name}`);

    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, data);
    files++;
    bytes += data.length;
    if (onProgress && files % 2000 === 0) onProgress(n + 1, total);
  }
  onProgress?.(total, total);
  return { files, bytes };
}
