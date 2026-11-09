// npm run setup:ldraw [-- --force] [-- --keep-zip]
// Downloads the official LDraw parts library, extracts it into server/ldraw/ and builds
// server/cache/catalog.json + colors.json. Idempotent: skips download/extract if already present.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeCaches } from './catalog.js';
import { CACHE_DIR, LDRAW_DOWNLOAD_DIR, LDRAW_ROOT, libraryPresent } from './paths.js';
import { extractZip } from './unzip.js';

const LIBRARY_URL = 'https://library.ldraw.org/library/updates/complete.zip';
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const keepZip = args.has('--keep-zip');
const zipPath = path.join(LDRAW_DOWNLOAD_DIR, 'complete.zip');

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function download() {
  console.log(`Downloading ${LIBRARY_URL} …`);
  const res = await fetch(LIBRARY_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${zipPath}.part`;
  let got = 0;
  let lastLog = 0;
  const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    if (Date.now() - lastLog > 1000) {
      lastLog = Date.now();
      process.stdout.write(`\r  ${mb(got)}${total ? ` / ${mb(total)} (${Math.round((got / total) * 100)}%)` : ''}   `);
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  process.stdout.write(`\r  ${mb(got)} downloaded.                    \n`);
  fs.renameSync(tmp, zipPath);
}

function extract() {
  console.log(`Extracting into ${LDRAW_DOWNLOAD_DIR} …`);
  try {
    const r = extractZip(zipPath, LDRAW_DOWNLOAD_DIR, (done, total) =>
      process.stdout.write(`\r  ${done} / ${total} entries   `),
    );
    process.stdout.write(`\n  ${r.files} files, ${mb(r.bytes)}\n`);
  } catch (err) {
    console.warn(`\nBuilt-in unzip failed (${(err as Error).message}); trying system tools …`);
    const tries: Array<[string, string[]]> = [
      ['tar', ['-xf', zipPath, '-C', LDRAW_DOWNLOAD_DIR]], // bsdtar on Windows 10+ / macOS
      ['unzip', ['-q', '-o', zipPath, '-d', LDRAW_DOWNLOAD_DIR]],
    ];
    if (process.platform === 'win32') {
      tries.push([
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${LDRAW_DOWNLOAD_DIR}' -Force`],
      ]);
    }
    for (const [cmd, a] of tries) {
      const r = spawnSync(cmd, a, { stdio: 'inherit' });
      if (r.status === 0 && libraryPresent()) return;
    }
    throw new Error('Could not extract the LDraw library.');
  }
}

async function main() {
  fs.mkdirSync(LDRAW_DOWNLOAD_DIR, { recursive: true });

  if (force) {
    console.log('--force: removing existing library and caches …');
    fs.rmSync(LDRAW_ROOT, { recursive: true, force: true });
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }

  if (libraryPresent()) {
    console.log(`LDraw library already present at ${LDRAW_ROOT} (use --force to re-download).`);
  } else {
    if (!fs.existsSync(zipPath)) await download();
    else console.log(`Using existing ${zipPath}`);
    extract();
    if (!libraryPresent()) throw new Error(`Extraction finished but ${LDRAW_ROOT} has no parts/, p/ or LDConfig.ldr.`);
    if (!keepZip) fs.rmSync(zipPath, { force: true });
    // A new library invalidates packed parts.
    fs.rmSync(path.join(CACHE_DIR, 'packed'), { recursive: true, force: true });
  }

  console.log('Building catalog and colour caches …');
  const t0 = Date.now();
  const { parts, colors } = await writeCaches();
  console.log(`  ${parts} catalog parts, ${colors} colours (${Date.now() - t0} ms) → ${CACHE_DIR}`);
  console.log('Done. Start the app with `npm run dev`.');
}

main().catch((err) => {
  console.error(`\nsetup:ldraw failed: ${(err as Error).message}`);
  process.exit(1);
});
