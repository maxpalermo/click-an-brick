// Curated special parts for Photo to Bricks. Every number below was measured from the real LDraw files
// (server/ldraw/ldraw/parts, flattened with research/photo2brick/special/ldraw.ts + bbox-parts.ts) and every id
// exists in server/cache/catalog.json.
//
// Conventions (LDraw, -Y up, LDU):
//   body  = the part's solid volume WITHOUT top studs / wheel pins: [x0, y0, z0, x1, y1, z1] in part-local
//           coordinates (y0 = top, y1 = bottom). Parts are placed by mapping this box onto grid cells.
//   bbox  = full extent including studs (used for overlap checks only where it matters).
//   size  = footprint in studs along local X (sx) and local Z (sz); h = height in plates (8 LDU).
//   Slopes / curves: the downhill (sloped) side is local -Z; the studded high row is the +Z row.

export type PartKind =
  | 'slope45' | 'slope33' | 'slopeInv45' | 'curve' | 'curveDouble'
  | 'tile' | 'roundBrick' | 'roundPlate' | 'roundTile'
  | 'brick' | 'plate'
  | 'rim' | 'tyre' | 'wheelHolder' | 'technicBrick' | 'axle' | 'bush'
  | 'windscreen' | 'windowFrame' | 'glass' | 'headlightBrick' | 'doorFrame' | 'door'
  | 'slopeDouble' | 'arch' | 'leaves';

export type Box = [number, number, number, number, number, number];

export interface PartSpec {
  id: string;
  kind: PartKind;
  sx: number; sz: number; h: number;
  body: Box;
  bbox: Box;
  /** Top studs (part-local x, z) on the body top (y = body[1]); empty = no studs on top (tiles, curves). */
  studs: [number, number][];
  /** Bottom accepts studs from below (anti-studs). Curves / slopes / tiles all do. */
  antiStuds: boolean;
  note?: string;
}

const grid = (sx: number, sz: number, z0 = 0): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) out.push([-sx * 10 + 10 + i * 20, z0 - (sz - 1) * 10 + k * 20]);
  return out;
};

/** id -> spec. */
export const PARTS: Record<string, PartSpec> = {};
const add = (p: PartSpec) => { PARTS[p.id] = p; };

// ---- 45° slopes (brick height, studded row at local z = 0, slope cells towards -Z, 4 LDU lip at the bottom) ----
// measured: 3040b x[-10,10] y[-4,24] z[-30,10]; 3039 x±20; 3038 x±30; 3037 x±40 (all z[-30,10], studs at z=0)
for (const [id, sx] of [['3040b.dat', 1], ['3039.dat', 2], ['3038.dat', 3], ['3037.dat', 4]] as const)
  add({ id, kind: 'slope45', sx, sz: 2, h: 3, body: [-sx * 10, 0, -30, sx * 10, 24, 10], bbox: [-sx * 10, -4, -30, sx * 10, 24, 10], studs: grid(sx, 1), antiStuds: true });
// ---- 33° slopes: 3 deep, studded row at z = 0 (measured 4286 x±10, 3298 x±20, 3297 x±40, z[-50,10]) ----
for (const [id, sx] of [['4286.dat', 1], ['3298.dat', 2], ['3297.dat', 4]] as const)
  add({ id, kind: 'slope33', sx, sz: 3, h: 3, body: [-sx * 10, 0, -50, sx * 10, 24, 10], bbox: [-sx * 10, -4, -50, sx * 10, 24, 10], studs: grid(sx, 1), antiStuds: true });
// ---- inverted 45°: full studded top (2 rows: z = 0 and z = -20), the bottom slopes up towards -Z ----
for (const [id, sx] of [['3665b.dat', 1], ['3660b.dat', 2]] as const)
  add({ id, kind: 'slopeInv45', sx, sz: 2, h: 3, body: [-sx * 10, 0, -30, sx * 10, 24, 10], bbox: [-sx * 10, -4, -30, sx * 10, 24, 10], studs: grid(sx, 2, -10), antiStuds: true, note: 'only the +Z row has anti-studs' });
// ---- curved slopes: NO studs, 2 plates tall, origin at the BOTTOM centre (y[-16,0]); high end +Z, low end -Z ----
add({ id: '11477.dat', kind: 'curve', sx: 1, sz: 2, h: 2, body: [-10, -16, -20, 10, 0, 20], bbox: [-10, -16, -20, 10, 0, 20], studs: [], antiStuds: true });
add({ id: '15068.dat', kind: 'curve', sx: 2, sz: 2, h: 2, body: [-20, -16, -20, 20, 0, 20], bbox: [-20, -16, -20, 20, 0, 20], studs: [], antiStuds: true });
add({ id: '93273.dat', kind: 'curveDouble', sx: 1, sz: 4, h: 2, body: [-10, -16, -40, 10, 0, 40], bbox: [-10, -16, -40, 10, 0, 40], studs: [], antiStuds: true, note: 'low at both ends, high in the middle' });
// ---- tiles (origin top centre, y[0,8]) ----
for (const [id, sx, sz] of [['3070b.dat', 1, 1], ['3069b.dat', 2, 1], ['63864.dat', 3, 1], ['2431.dat', 4, 1], ['6636.dat', 6, 1], ['4162.dat', 8, 1],
  ['3068b.dat', 2, 2], ['26603.dat', 3, 2], ['87079.dat', 4, 2], ['69729.dat', 6, 2]] as const)
  add({ id, kind: 'tile', sx, sz, h: 1, body: [-sx * 10, 0, -sz * 10, sx * 10, 8, sz * 10], bbox: [-sx * 10, 0, -sz * 10, sx * 10, 8, sz * 10], studs: [], antiStuds: true });
// ---- round parts (same footprint/height as their square counterparts) ----
add({ id: '3062b.dat', kind: 'roundBrick', sx: 1, sz: 1, h: 3, body: [-10, 0, -10, 10, 24, 10], bbox: [-10, -4, -10, 10, 24, 10], studs: [[0, 0]], antiStuds: true });
add({ id: '3941.dat', kind: 'roundBrick', sx: 2, sz: 2, h: 3, body: [-20, 0, -20, 20, 24, 20], bbox: [-20, -4, -20, 20, 24, 20], studs: grid(2, 2), antiStuds: true });
// quarter of a round 8x8 course (4 make a drum tower): origin at the circle centre = the part's corner, solid quarter disc
// towards +X / -Z, 11 studs on it (measured 2577 x[0,80] y[-4,24] z[-80,0])
add({ id: '2577.dat', kind: 'roundBrick', sx: 4, sz: 4, h: 3, body: [0, 0, -80, 80, 24, 0], bbox: [0, -4, -80, 80, 24, 0],
  studs: [[70, -10], [50, -10], [50, -30], [50, -50], [30, -10], [30, -30], [30, -50], [10, -10], [10, -30], [10, -50], [10, -70]], antiStuds: true, note: 'brick 4x4 corner round' });
// the same quarter as a 1-stud ring (macaroni 4x4): 3 studs on the arc, hollow inside (measured 48092 x[0,80] z[-80,0])
add({ id: '48092.dat', kind: 'roundBrick', sx: 4, sz: 4, h: 3, body: [0, 0, -80, 80, 24, 0], bbox: [0, -4, -80, 80, 24, 0],
  studs: [[70, -10], [50, -50], [10, -70]], antiStuds: true, note: 'brick 4x4 corner round ring, the parapet of a drum tower' });
add({ id: '6141.dat', kind: 'roundPlate', sx: 1, sz: 1, h: 1, body: [-10, 0, -10, 10, 8, 10], bbox: [-10, -4, -10, 10, 8, 10], studs: [[0, 0]], antiStuds: true });
add({ id: '4032b.dat', kind: 'roundPlate', sx: 2, sz: 2, h: 1, body: [-20, 0, -20, 20, 8, 20], bbox: [-20, -4, -20, 20, 8, 20], studs: grid(2, 2), antiStuds: true });
add({ id: '98138.dat', kind: 'roundTile', sx: 1, sz: 1, h: 1, body: [-10, 0, -10, 10, 8, 10], bbox: [-10, 0, -10, 10, 8, 10], studs: [], antiStuds: true });
add({ id: '14769.dat', kind: 'roundTile', sx: 2, sz: 2, h: 1, body: [-20, 0, -20, 20, 8, 20], bbox: [-20, 0, -20, 20, 8, 20], studs: [], antiStuds: true });
// ---- headlight brick: 1x1 brick with a recessed side stud at (0, 10, -6) pointing -Z (measured) ----
add({ id: '4070.dat', kind: 'headlightBrick', sx: 1, sz: 1, h: 3, body: [-10, 0, -10, 10, 24, 10], bbox: [-10, -4, -10, 10, 24, 10], studs: [[0, 0]], antiStuds: true, note: 'side stud at (0,10,-6) facing -Z' });
// ---- wheels: rims / tyres are centred on their axis = local Z ----
// 4624 x/y ±10, z ±8 · 3641 x/y ±18, z ±8 (4624c01 = both at origin)
add({ id: '4624.dat', kind: 'rim', sx: 1, sz: 1, h: 0, body: [-10, -10, -8, 10, 10, 8], bbox: [-10, -10, -8, 10, 10, 8], studs: [], antiStuds: false, note: 'fits 3641; wheel-pin hole' });
add({ id: '3641.dat', kind: 'tyre', sx: 2, sz: 1, h: 0, body: [-18, -18, -8, 18, 18, 8], bbox: [-18, -18, -8, 18, 18, 8], studs: [], antiStuds: false, note: 'Ø36' });
// 6014b x/y ±13, z[-20,8] (hub towards -Z) · 6015 x/y ±25, z ±14, placed at rim z = -6 (6014bc01)
add({ id: '6014b.dat', kind: 'rim', sx: 1, sz: 1, h: 0, body: [-13, -13, -20, 13, 13, 8], bbox: [-13, -13, -20, 13, 13, 8], studs: [], antiStuds: false, note: 'fits 6015 at z=-6; wheel-pin hole' });
add({ id: '6015.dat', kind: 'tyre', sx: 3, sz: 2, h: 0, body: [-25, -25, -14, 25, 25, 14], bbox: [-25, -25, -14, 25, 25, 14], studs: [], antiStuds: false, note: 'Ø50' });
// 3482 x/y ±22, z ±10 · 3483 x/y ±31, z ±9 (3482c01) · 2346 x/y ±35, z[-20,10] (3482c04)
add({ id: '3482.dat', kind: 'rim', sx: 2, sz: 1, h: 0, body: [-22, -22, -10, 22, 22, 10], bbox: [-22, -22, -10, 22, 22, 10], studs: [], antiStuds: false, note: 'axle hole; fits 3483 / 2346' });
add({ id: '3483.dat', kind: 'tyre', sx: 3, sz: 1, h: 0, body: [-31, -31, -9, 31, 31, 9], bbox: [-31, -31, -9, 31, 31, 9], studs: [], antiStuds: false, note: 'Ø62' });
add({ id: '2346.dat', kind: 'tyre', sx: 4, sz: 2, h: 0, body: [-35, -35, -20, 35, 35, 10], bbox: [-35, -35, -20, 35, 35, 10], studs: [], antiStuds: false, note: 'Ø70, tread offset towards -Z' });
// 56904 x/y �38, z[-20,18] � 56898 x/y �53.5, z �18 (56904c01 = both at origin)
add({ id: '56904.dat', kind: 'rim', sx: 4, sz: 2, h: 0, body: [-38, -38, -20, 38, 38, 18], bbox: [-38, -38, -20, 38, 38, 18], studs: [], antiStuds: false, note: 'axle hole; fits 56898' });
add({ id: '56898.dat', kind: 'tyre', sx: 6, sz: 2, h: 0, body: [-53.5, -53.5, -18, 53.5, 53.5, 18], bbox: [-53.5, -53.5, -18, 53.5, 53.5, 18], studs: [], antiStuds: false, note: '�107' });
// wheel holders: 4488 (one pin, +X side, pin centre y = 5, tip x = 34), 4600 (pins on both sides, x ±34)
add({ id: '4488.dat', kind: 'wheelHolder', sx: 2, sz: 2, h: 1, body: [-20, 0, -20, 20, 8, 20], bbox: [-20, -4, -20, 34, 16, 20], studs: grid(2, 2), antiStuds: true, note: 'wheel pin +X at y=5' });
add({ id: '4600.dat', kind: 'wheelHolder', sx: 2, sz: 2, h: 1, body: [-20, 0, -20, 20, 8, 20], bbox: [-34, -4, -20, 34, 10, 20], studs: grid(2, 2), antiStuds: true, note: 'wheel pins ±X at y=5' });
// Technic brick 1x2 with hole: hole at (0, 10, 0), axis = local Z (measured from 3700.dat peghole lines)
add({ id: '3700.dat', kind: 'technicBrick', sx: 2, sz: 1, h: 3, body: [-20, 0, -10, 20, 24, 10], bbox: [-20, -4, -10, 20, 24, 10], studs: grid(2, 1), antiStuds: true, note: 'pin hole at y=10, axis Z' });
add({ id: '4519.dat', kind: 'axle', sx: 3, sz: 1, h: 0, body: [-29.5, -6, -6, 29.5, 6, 6], bbox: [-29.5, -6, -6, 29.5, 6, 6], studs: [], antiStuds: false, note: 'axle 3L along X' });
add({ id: '3705.dat', kind: 'axle', sx: 4, sz: 1, h: 0, body: [-39.5, -6, -6, 39.5, 6, 6], bbox: [-39.5, -6, -6, 39.5, 6, 6], studs: [], antiStuds: false, note: 'axle 4L along X' });
// longer axles (measured: half lengths 49.5 / 59.5 / 69.5 / 79.5, section +-6), for one axle across an odd-width body
for (const [id, n, half] of [['32073.dat', 5, 49.5], ['3706.dat', 6, 59.5], ['44294.dat', 7, 69.5], ['3707.dat', 8, 79.5]] as const)
  add({ id, kind: 'axle', sx: n, sz: 1, h: 0, body: [-half, -6, -6, half, 6, 6], bbox: [-half, -6, -6, half, 6, 6], studs: [], antiStuds: false, note: `axle ${n}L along X` });
add({ id: '3713.dat', kind: 'bush', sx: 1, sz: 1, h: 0, body: [-9, -9, -10, 9, 9, 10], bbox: [-9, -9, -10, 9, 9, 10], studs: [], antiStuds: false, note: 'axis Z' });
// ---- windscreens: studded back row at z = 0 (top, y = 0), glass slopes down towards -Z ----
// 3823 x±40 y[-4,48] z[-30,10], studs (±30, 0) · 4176 x±60 y[-4,48] z[-30,10] · 2437 x±40 y[-4,32] z[-30,30]
add({ id: '3823.dat', kind: 'windscreen', sx: 4, sz: 2, h: 6, body: [-40, 0, -30, 40, 48, 10], bbox: [-40, -4, -30, 40, 48, 10], studs: [[-30, 0], [30, 0]], antiStuds: true });
add({ id: '4176.dat', kind: 'windscreen', sx: 6, sz: 2, h: 6, body: [-60, 0, -30, 60, 48, 10], bbox: [-60, -4, -30, 60, 48, 10], studs: [[-50, 0], [-30, 0], [-10, 0], [10, 0], [30, 0], [50, 0]], antiStuds: true });
add({ id: '2437.dat', kind: 'windscreen', sx: 4, sz: 3, h: 4, body: [-40, 0, -30, 40, 32, 30], bbox: [-40, -4, -30, 40, 32, 30], studs: [[-30, 0], [30, 0]], antiStuds: true, note: 'low windscreen, 3 deep' });
// ---- window 1x2x2 frame + glass (glass shares the frame's origin; glass at z[-7,-3]) ----
add({ id: '60592.dat', kind: 'windowFrame', sx: 2, sz: 1, h: 6, body: [-20, 0, -10, 20, 48, 10], bbox: [-20, -4, -10, 20, 48, 10], studs: grid(2, 1), antiStuds: true });
add({ id: '60601.dat', kind: 'glass', sx: 2, sz: 1, h: 5, body: [-16.5, 2, -7, 16.5, 41, -3], bbox: [-16.5, 2, -7, 16.5, 41, -3], studs: [], antiStuds: false, note: 'goes into 60592 at the same origin' });
// ---- window 1x2x3 frame + glass (60593c01: glass at the frame's origin, z[-7,-3]) ----
add({ id: '60593.dat', kind: 'windowFrame', sx: 2, sz: 1, h: 9, body: [-20, 0, -10, 20, 72, 10], bbox: [-20, -4, -10, 20, 72, 10], studs: grid(2, 1), antiStuds: true });
add({ id: '60602.dat', kind: 'glass', sx: 2, sz: 1, h: 8, body: [-16.5, 2, -7, 16.5, 65, -3], bbox: [-16.5, 2, -7, 16.5, 65, -3], studs: [], antiStuds: false, note: 'goes into 60593 at the same origin' });
// ---- door 1x4x6 frame (studs at x = +-10 only; hinge holes at x = +-32, z = 5) + door 60623 (hinge axis = its
// local origin, measured from the pin primitives). The door hangs in the frame at frame-local (-32, 0, 5) with the
// same rotation; its leaf reaches z = +12 (2 LDU proud of the frame), so its body is clipped to the frame's cell. ----
add({ id: '60596.dat', kind: 'doorFrame', sx: 4, sz: 1, h: 18, body: [-40, 0, -10, 40, 144, 10], bbox: [-40, -4, -10, 40, 144, 10], studs: [[-10, 0], [10, 0]], antiStuds: true });
add({ id: '60623.dat', kind: 'door', sx: 4, sz: 1, h: 17, body: [-4, 3, -7, 67, 137, 5], bbox: [-4, 3, -7, 67, 137, 7], studs: [], antiStuds: false, note: 'hangs in 60596 at frame-local (-32, 0, 5)' });
// ---- glass bricks (bricks without centre studs, the classic trans-clear bricks): 1x2 / 1x4, measured y[-4,24] ----
add({ id: '3065.dat', kind: 'brick', sx: 2, sz: 1, h: 3, body: [-20, 0, -10, 20, 24, 10], bbox: [-20, -4, -10, 20, 24, 10], studs: grid(2, 1), antiStuds: true, note: 'trans glass brick' });
add({ id: '3066.dat', kind: 'brick', sx: 4, sz: 1, h: 3, body: [-40, 0, -10, 40, 24, 10], bbox: [-40, -4, -10, 40, 24, 10], studs: grid(4, 1), antiStuds: true, note: 'trans glass brick' });

// ---- architecture (architecture.ts / openings.ts castle style); measured with research/photo2brick/special/bbox-parts.ts ----
// double 45 deg slopes (ridge caps): ridge along local X, faces slope down towards +-Z, no studs, origin at the apex (y[0,24])
for (const [id, sx] of [['3044b.dat', 1], ['3043.dat', 2], ['3041.dat', 4]] as const)
  add({ id, kind: 'slopeDouble', sx, sz: 2, h: 3, body: [-sx * 10, 0, -20, sx * 10, 24, 20], bbox: [-sx * 10, 0, -20, sx * 10, 24, 20], studs: [], antiStuds: true, note: 'ridge cap' });
// arches: 1 deep, the arc is cut out of the underside between the two 1-stud legs; studs along the whole top
add({ id: '3659.dat', kind: 'arch', sx: 4, sz: 1, h: 3, body: [-40, 0, -10, 40, 24, 10], bbox: [-40, -4, -10, 40, 24, 10], studs: grid(4, 1), antiStuds: true, note: 'arch 1x4, opening 2 wide' });
add({ id: '6182.dat', kind: 'arch', sx: 4, sz: 1, h: 6, body: [-40, 0, -10, 40, 48, 10], bbox: [-40, -4, -10, 40, 48, 10], studs: grid(4, 1), antiStuds: true, note: 'arch 1x4x2, opening 2 wide' });
add({ id: '3307.dat', kind: 'arch', sx: 6, sz: 1, h: 6, body: [-60, 0, -10, 60, 48, 10], bbox: [-60, -4, -10, 60, 48, 10], studs: grid(6, 1), antiStuds: true, note: 'arch 1x6x2, opening 4 wide' });
add({ id: '3455.dat', kind: 'arch', sx: 6, sz: 1, h: 3, body: [-60, 0, -10, 60, 24, 10], bbox: [-60, -4, -10, 60, 24, 10], studs: grid(6, 1), antiStuds: true, note: 'arch 1x6, opening 4 wide' });
// more arches from the OMR recipe book (research/structures), measured from the LDraw files (part-bbox-cache.json): 1x3 (castle
// windows / gates on 1x1 bricks), 1x8x2 raised, 1x12x3 (gates, blind arches)
add({ id: '4490.dat', kind: 'arch', sx: 3, sz: 1, h: 3, body: [-30, 0, -10, 30, 24, 10], bbox: [-30, -4, -10, 30, 24, 10], studs: grid(3, 1), antiStuds: true, note: 'arch 1x3, opening 1 wide' });
add({ id: '16577.dat', kind: 'arch', sx: 8, sz: 1, h: 6, body: [-80, 0, -10, 80, 48, 10], bbox: [-80, -4, -10, 80, 48, 10], studs: grid(8, 1), antiStuds: true, note: 'arch 1x8x2 raised, opening 6 wide' });
add({ id: '6108.dat', kind: 'arch', sx: 12, sz: 1, h: 9, body: [-120, 0, -10, 120, 72, 10], bbox: [-120, -4, -10, 120, 72, 10], studs: grid(12, 1), antiStuds: true, note: 'arch 1x12x3, opening 10 wide' });
// window 1x2x2.667 with rounded top (8 plates) + lattice pane; the pane sits at frame-local (0, 24, 0) (measured: frame
// opening y[4,56] on the centre line, pane y[-20,32.8])
add({ id: '30044.dat', kind: 'windowFrame', sx: 2, sz: 1, h: 8, body: [-20, 0, -10, 20, 64, 10], bbox: [-20, -4, -10, 20, 64, 10], studs: [[0, 0]], antiStuds: true, note: 'rounded top' });
add({ id: '30046.dat', kind: 'glass', sx: 2, sz: 1, h: 7, body: [-16.7, -20, -2, 16.8, 32.8, 2], bbox: [-16.7, -20, -2, 16.8, 32.8, 2], studs: [], antiStuds: false, note: 'goes into 30044 at frame-local (0, 24, 0)' });
// brick 1x1x3 (arrow slit column)
add({ id: '14716.dat', kind: 'brick', sx: 1, sz: 1, h: 9, body: [-10, 0, -10, 10, 72, 10], bbox: [-10, -4, -10, 10, 72, 10], studs: [[0, 0]], antiStuds: true, note: 'arrow slit' });
// plant leaves 4x3: anti-stud at the origin, the leaf reaches towards local -Z (measured x[-26,26] y[-4,8] z[-68,10])
add({ id: '2423.dat', kind: 'leaves', sx: 3, sz: 4, h: 1, body: [-26, 0, -68, 26, 8, 10], bbox: [-26, -4, -68, 26, 8, 10], studs: [[-20, -20], [20, -20], [-20, -40], [0, 0]], antiStuds: true, note: 'clips onto one stud at the origin' });

/** Wheel assemblies, smallest first. dia/width in LDU. */
export interface WheelTier {
  name: 'S' | 'M' | 'L' | 'XL' | 'XXL';
  rim: string; tyre: string;
  /** Tyre offset along the rim axis (rim-local Z), from the LDraw composite (6014bc01: -6). */
  tyreZ: number;
  dia: number;
  mount: 'pin' | 'axle';
  /** Rim-local Z extent of rim + tyre, used to place the wheel against its holder. */
  z0: number; z1: number;
}
export const WHEEL_TIERS: WheelTier[] = [
  { name: 'S', rim: '4624.dat', tyre: '3641.dat', tyreZ: 0, dia: 36, mount: 'pin', z0: -8, z1: 8 },
  { name: 'M', rim: '6014b.dat', tyre: '6015.dat', tyreZ: -6, dia: 50, mount: 'pin', z0: -20, z1: 8 },
  { name: 'L', rim: '3482.dat', tyre: '3483.dat', tyreZ: 0, dia: 62, mount: 'axle', z0: -10, z1: 10 },
  { name: 'XL', rim: '3482.dat', tyre: '2346.dat', tyreZ: 0, dia: 70, mount: 'axle', z0: -20, z1: 10 },
  { name: 'XXL', rim: '56904.dat', tyre: '56898.dat', tyreZ: 0, dia: 107, mount: 'axle', z0: -20, z1: 18 },
];

/** Standard bricks / plates (bricks.ts lists) by footprint, for local re-packing in refine(). */
export const TILE_BY_SIZE: Record<string, string> = {
  '1x1': '3070b.dat', '1x2': '3069b.dat', '1x3': '63864.dat', '1x4': '2431.dat', '1x6': '6636.dat', '1x8': '4162.dat',
  '2x2': '3068b.dat', '2x3': '26603.dat', '2x4': '87079.dat', '2x6': '69729.dat',
};
export const SLOPE45_BY_WIDTH: Record<number, string> = { 1: '3040b.dat', 2: '3039.dat', 3: '3038.dat', 4: '3037.dat' };
export const SLOPE33_BY_WIDTH: Record<number, string> = { 1: '4286.dat', 2: '3298.dat', 4: '3297.dat' };
export const INV45_BY_WIDTH: Record<number, string> = { 1: '3665b.dat', 2: '3660b.dat' };
export const DOUBLE45_BY_WIDTH: Record<number, string> = { 1: '3044b.dat', 2: '3043.dat', 4: '3041.dat' };
export const CURVE_BY_WIDTH: Record<number, string> = { 1: '11477.dat', 2: '15068.dat' };

/** LDraw colour codes used by special parts (colors.json). */
export const C = {
  black: 0, white: 15, lbg: 71, dbg: 72, reddishBrown: 70,
  transClear: 47, transLightBlue: 43, transBlack: 40, transRed: 36, transYellow: 46, transOrange: 57,
} as const;

/** Window frame + glass by height in plates (both 2 studs wide, 1 deep; glass at the frame origin). */
export const WINDOWS: { h: number; frame: string; glass: string }[] = [
  { h: 9, frame: '60593.dat', glass: '60602.dat' },
  { h: 6, frame: '60592.dat', glass: '60601.dat' },
];
/** Door frame + door (1x4x6) and where the door hangs in the frame (frame-local). */
export const DOOR = { frame: '60596.dat', door: '60623.dat', h: 18, w: 4, hinge: [-32, 0, 5] as [number, number, number] };

export const SPECIAL_IDS = Object.keys(PARTS);
