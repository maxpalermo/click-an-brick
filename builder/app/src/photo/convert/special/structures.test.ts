// Unit tests for the structures-first build order (no DOM). Run: npx tsx app/src/photo/convert/special/structures.test.ts
import type { PhotoAnalysis, PhotoStructure, SpecialContext } from '../contracts';
import { reserveImpl, type SpecialGrid } from './reserve';
import { PARTS } from './library';
import { xfBox, ldToCells } from './geom';

let failed = 0, passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function ok(c: unknown, msg = 'assertion failed') {
  if (!c) throw new Error(msg);
}

/** A light grey block: x 2..17, z 2..7, 30 layers tall, in a 20 x 36 x 10 grid; the front (+z) face is z = 7. */
function block(): SpecialGrid {
  const nx = 20, ny = 36, nz = 10, N = nx * ny * nz;
  const solid = new Uint8Array(N), visible = new Uint8Array(N), cells = new Int16Array(N).fill(-2);
  for (let y = 0; y < 30; y++) for (let z = 2; z <= 7; z++) for (let x = 2; x <= 17; x++) {
    const i = x + nx * (z + nz * y);
    solid[i] = 1; visible[i] = 1; cells[i] = 0;
  }
  return { nx, ny, nz, solid, visible, rgb: new Float32Array(N * 3).fill(0.5), sizeLdu: [nx * 20, ny * 8, nz * 20], cells, paletteCodes: [71], frame: undefined };
}

const ctx = (structuresFirst: boolean): SpecialContext => ({ mode: 'object', detail: 'balanced', palette: [71], hasPart: () => true, structuresFirst });
const analysis = (structures: PhotoStructure[]): PhotoAnalysis => ({
  category: 'house', symmetry: 'none', subjectBox: [0, 0, 1, 1], features: [], palette: ['#A0A5A9'], isBrickBuilt: false, structures,
});
const s = (kind: PhotoStructure['kind'], box: [number, number, number, number], extra: Partial<PhotoStructure> = {}): PhotoStructure =>
  ({ kind, view: 'front', box, confidence: 0.9, ...extra });

/** No two placed parts share a grid cell (body boxes), glass / door leaves inside their frame excepted. */
function noOverlap(parts: { part: string; pos: number[]; rot: number[] }[]) {
  const seen = new Map<string, number>();
  parts.forEach((p, k) => {
    const sp = PARTS[p.part];
    if (!sp || sp.kind === 'glass' || sp.kind === 'door') return;
    const [x0, y0, z0, x1, y1, z1] = ldToCells(xfBox(p.rot as never, p.pos as never, sp.body));
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const key = `${x},${y},${z}`;
      ok(!seen.has(key), `${p.part} overlaps part ${seen.get(key)} at ${key}`);
      seen.set(key, k);
    }
  });
}

console.log('structures-first');

test('a front column becomes a stack of 1x1 round bricks with a cap only when its top is open', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('column', [0.1, 0.2, 0.15, 0.9])]) } as SpecialContext);
  const rounds = res.parts.filter((p) => p.part === '3062b.dat');
  ok(res.info.structures?.columns === 1, `columns ${res.info.structures?.columns} (${res.info.structures?.missed.join('; ')})`);
  ok(rounds.length >= 5, `round bricks ${rounds.length}`);
  ok(new Set(rounds.map((p) => p.pos[0])).size === 1, 'one vertical stack');
  ok(!res.parts.some((p) => p.part === '6141.dat'), 'no cap inside the wall');
  noOverlap(res.parts);
});

test('a column reaching the top gets its round plate cap', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('column', [0.1, 0.0, 0.15, 0.6])]) } as SpecialContext);
  ok(res.info.structures?.columns === 1, `columns ${res.info.structures?.columns}`);
  ok(res.parts.some((p) => p.part === '6141.dat'), 'cap');
});

test('count splits a colonnade box into several columns; a wide one takes 2x2 round bricks', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('column', [0.1, 0.2, 0.9, 0.9], { count: 4, shape: 'round' })]) } as SpecialContext);
  ok(res.info.structures?.columns === 4, `columns ${res.info.structures?.columns} (${res.info.structures?.missed.join('; ')})`);
  ok(res.parts.some((p) => p.part === '3941.dat'), '2x2 round bricks');
  noOverlap(res.parts);
});

test('an arch is an arch brick with the opening carved under it, legs on wall', () => {
  const g = block();
  const res = reserveImpl(g, { ...ctx(true), analysis: analysis([s('arch', [0.4, 0.4, 0.6, 0.7])]) } as SpecialContext);
  const arches = res.parts.filter((p) => PARTS[p.part]?.kind === 'arch');
  ok(res.info.structures?.arches === 1 && arches.length === 1, `arches ${res.info.structures?.arches} (${res.info.structures?.missed.join('; ')})`);
  const [x0, y0, z0, x1] = ldToCells(xfBox(arches[0].rot as never, arches[0].pos as never, PARTS[arches[0].part].body));
  // under the middle of the arch: air at the face; under the legs: wall
  const at = (x: number, y: number, z: number) => x + g.nx * (z + g.nz * y);
  ok(!g.solid[at(x0 + 1, y0 - 1, z0)], 'opening under the arch');
  ok(g.solid[at(x0, y0 - 1, z0)] && g.solid[at(x1 - 1, y0 - 1, z0)], 'legs stand on wall');
  noOverlap(res.parts);
});

test('a wide arch box takes the 1x12x3 arch, and drops to the real wall top when the photo puts it higher', () => {
  const g = block();
  // 10-stud opening; the box top (y 0.05 -> layer 28.5) is above the 9-plate arch's room under the wall top (30)
  const res = reserveImpl(g, { ...ctx(true), analysis: analysis([s('arch', [0.19, 0.05, 0.81, 0.9])]) } as SpecialContext);
  const arches = res.parts.filter((p) => PARTS[p.part]?.kind === 'arch');
  ok(arches.length === 1 && arches[0].part === '6108.dat', `arch ${arches.map((p) => p.part).join(',')} (${res.info.structures?.missed.join('; ')})`);
  noOverlap(res.parts);
});

test('an arch over a window box is left to the window (it brings its own arch)', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('arch', [0.4, 0.3, 0.6, 0.5]), s('window', [0.42, 0.32, 0.58, 0.5], { shape: 'round' })]) } as SpecialContext);
  ok(res.info.structures?.arches === 0, 'arch skipped');
  ok(res.info.structures?.windows === 1, `windows ${res.info.structures?.windows}`);
  ok(res.parts.some((p) => p.part === '30044.dat'), 'arched window frame');
  noOverlap(res.parts);
});

test('right-side windows go on the +x wall', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('window', [0.3, 0.3, 0.6, 0.5], { view: 'right', shape: 'square' })]) } as SpecialContext);
  const frames = res.parts.filter((p) => PARTS[p.part]?.kind === 'windowFrame');
  ok(frames.length >= 1, 'window frame');
  ok(frames.every((p) => p.pos[0] > 300), `on the +x face (x ${frames.map((p) => p.pos[0]).join(',')})`);
});

test('a front door structure reaches the door rule', () => {
  const res = reserveImpl(block(), { ...ctx(true), analysis: analysis([s('door', [0.4, 0.3, 0.6, 1.0], { color: '#5C3A1E' })]) } as SpecialContext);
  ok(res.info.doors === 1, `doors ${res.info.doors} ${res.info.notes.join('; ')}`);
});

test('flag off: structures are ignored', () => {
  const res = reserveImpl(block(), { ...ctx(false), analysis: analysis([s('column', [0.1, 0.2, 0.15, 0.9])]) } as SpecialContext);
  ok(res.info.structures === undefined, 'no structures info');
  ok(!res.parts.some((p) => p.part === '3062b.dat'), 'no column');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} test(s) failed`);
