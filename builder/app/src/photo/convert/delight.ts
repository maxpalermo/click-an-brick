// De-lighting + region-snapping colour stage (replaces the per-voxel nearest-colour match).
//
// Image-to-3D textures (TRELLIS, Tripo) have the photo's lighting baked in: one light-blue car body comes out as
// grey, brown and teal patches. A builder would use ONE brick colour per material. This stage:
//   1. clusters the visible voxels' sampled colours in a shading-tolerant OKLab space: chroma as a ratio to lightness
//      (a uniform darkening scales L, a and b alike, so a/L and b/L stay put) plus a down-weighted lightness;
//   2a. with vision colorRegions (PhotoAnalysis): assigns each cluster to a region by chroma/hue first, lightness
//      second (darker than the region = plausible shadow, cheaper than brighter), with a capacity per region from its
//      area share so a big shaded patch cannot all go to a small region; clusters far from every region stay their own
//      (de-lit) group;
//   2b. without: merges clusters that differ mainly in lightness (agglomerative, so black / grey / white do not chain)
//      and estimates each group's unlit colour from its well-lit voxels (facing up / sideways, not at the ground);
//   3. maps the groups to LEGO colours: nearest by CIEDE2000, common colours preferred, and distinct groups kept
//      distinct (a group whose best colour is taken by a clearly different group takes its next-best free colour).
// Writes the palette index into `cells` and the chosen LEGO colour into `grid.rgb` for every visible voxel (later
// passes such as the colour cap read rgb). Pure TS, deterministic, O(visible voxels x clusters).

import type { PhotoAnalysis } from './contracts';
import type { VoxelGrid } from './voxelize';
import { ColorMatcher, CORE_COLOR_CODES, ciede2000, hexToLinear, linearToCielab, linearToOklab, oklabToLinear, type Lab, type PaletteColor } from './color';

export interface DelightOptions {
  analysis?: PhotoAnalysis;
  /** k-means clusters (default 16). */
  clusters?: number;
  /** Research: without the region rules (neutral pull, hue families, ground regions, region rare penalty). */
  v1?: boolean;
}

export interface DelightGroup {
  /** Region name (vision) or 'auto N'. */
  name: string;
  /** Share of the visible surface. */
  share: number;
  /** Target (unlit) colour as #RRGGBB. */
  color: string;
  /** LDraw colour code chosen for it. */
  code: number;
}

export interface DelightStats {
  mode: 'regions' | 'auto';
  clusters: number;
  groups: DelightGroup[];
}

/** Lightness floor of the chroma ratio (very dark colours keep a damped ratio, so black stays neutral). */
const RATIO_FLOOR = 0.25;
/** Clustering feature weight of lightness (chroma ratio has weight 1). */
const WL = 0.35;
/** Region matching: lightness weight when the cluster is darker / brighter than the region. */
const WL_DARK = 0.2, WL_BRIGHT = 0.45;
/** A cluster farther than this (feature distance) from every region and >= FAR_SHARE of the surface keeps its own colour. */
const FAR = 0.2, FAR_SHARE = 0.06;
/** Regions below this share are small salient features (eyes, logos): special parts handle them, colour does not. */
const MIN_REGION_SHARE = 0.03;
/** Region capacity = CAP_K * share + CAP_PAD (shares come from one photo, so they are rough). */
const CAP_K = 1.25, CAP_PAD = 0.02;
/** Auto merge: chroma-ratio distance and lightness limits (neutral pairs need closer lightness). */
const MERGE_DC = 0.07, MERGE_DL = 0.4, MERGE_DL_NEUTRAL = 0.2, NEUTRAL = 0.06;
/** Auto: groups below this share join the nearest larger group within SMALL_DC chroma-ratio distance. */
const SMALL_GROUP = 0.04, SMALL_DC = 0.15;
/** Representative lightness percentile (baked shading darkens far more surface than highlights brighten). */
/** Auto groups take the LEGO colour their well-lit voxels vote for (true) or the nearest to their de-lit estimate. */
const AUTO_VOTE = false;
const L_PERCENTILE = 0.6;
/** A non-core LEGO colour must be this much closer (CIEDE2000) to be chosen over a core one. */
const RARE_PENALTY = 2.5;
/** Two groups count as different colours above this CIEDE2000; then they must not share a LEGO colour if avoidable. */
const DISTINCT_DE = 8, DISTINCT_SLACK = 15;
/**
 * A clearly coloured cluster (chroma ratio above CHROMA_MIN) is pulled towards a neutral region (grey / black / white)
 * only by its chroma beyond NEUTRAL_SLACK: shading darkens a material, it does not turn green foliage grey.
 */
const CHROMA_MIN = 0.1, NEUTRAL_SLACK = 0.06, NEUTRAL_PULL = 1;
/**
 * Regions of the same hue that differ only in lightness (chroma-ratio distance < FAMILY_DC, both chromatic, e.g.
 * terracotta roof tiles + brown wood): within the family the only signal is relative lightness, so its clusters are
 * split by lightness rank in proportion to the regions' shares (lightest clusters -> lightest region).
 */
const FAMILY_DC = 0.05;
/**
 * A region named like the ground (base plate, rocks, ...) that shares its hue family with a bigger region (dark grey
 * base under light grey walls) is a location, not a shade: it keeps only the voxels of the family in the bottom band
 * (as many layers as its share needs, at most GROUND_MAX of the height); the rest of the family goes to the big region.
 * So shading never paints a second grey into the walls.
 */
const GROUND_NAME = /\b(base|baseplate|ground|floor|plinth|foundation|rocks?|terrain)\b/i, GROUND_MAX = 0.12;
/** Rare-colour penalty for vision regions (their colour is reported, not sampled: the perceptual nearest should win). */
const RARE_PENALTY_REGION = 0.5;

const HEX = /^#[0-9a-f]{6}$/i;
const toHex = (lin: [number, number, number]) => {
  const s = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    const u = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(u * 255).toString(16).padStart(2, '0');
  };
  return `#${s(lin[0])}${s(lin[1])}${s(lin[2])}`.toUpperCase();
};

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Col { L: number; ra: number; rb: number }
const ratioOf = (L: number, a: number, b: number): Col => { const d = Math.max(L, RATIO_FLOOR); return { L, ra: a / d, rb: b / d }; };
const colToLinear = (c: Col): [number, number, number] => { const d = Math.max(c.L, RATIO_FLOOR); return oklabToLinear(c.L, c.ra * d, c.rb * d).map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]; };
const chromaDist = (p: Col, q: Col) => Math.hypot(p.ra - q.ra, p.rb - q.rb);

/** Weighted k-means (k-means++ init) on 3-D features; fits on a strided sample, labels every point. */
function kmeans(F: Float32Array, n: number, K: number, seed = 7): { label: Int32Array; k: number } {
  const label = new Int32Array(n);
  if (n === 0) return { label, k: 0 };
  K = Math.max(1, Math.min(K, n));
  const stride = Math.max(1, Math.ceil(n / 24000));
  const sample: number[] = [];
  for (let i = 0; i < n; i += stride) sample.push(i);
  const S = sample.length;
  const rand = rng(seed);
  const C = new Float32Array(K * 3);
  const d2 = (i: number, c: number) => (F[i * 3] - C[c * 3]) ** 2 + (F[i * 3 + 1] - C[c * 3 + 1]) ** 2 + (F[i * 3 + 2] - C[c * 3 + 2]) ** 2;
  // k-means++
  const first = sample[Math.floor(rand() * S)];
  C.set(F.subarray(first * 3, first * 3 + 3), 0);
  const best = new Float64Array(S).fill(Infinity);
  let k = 1;
  for (; k < K; k++) {
    let total = 0;
    for (let s = 0; s < S; s++) { best[s] = Math.min(best[s], d2(sample[s], k - 1)); total += best[s]; }
    if (total <= 1e-12) break;
    let r = rand() * total, pick = sample[S - 1];
    for (let s = 0; s < S; s++) { r -= best[s]; if (r <= 0) { pick = sample[s]; break; } }
    C.set(F.subarray(pick * 3, pick * 3 + 3), k * 3);
  }
  const sum = new Float64Array(k * 4);
  const assign = (i: number) => { let b = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = d2(i, c); if (d < bd) { bd = d; b = c; } } return b; };
  for (let it = 0; it < 12; it++) {
    sum.fill(0);
    let moved = 0;
    for (let s = 0; s < S; s++) {
      const i = sample[s], c = assign(i);
      if (label[i] !== c) { moved++; label[i] = c; }
      sum[c * 4] += F[i * 3]; sum[c * 4 + 1] += F[i * 3 + 1]; sum[c * 4 + 2] += F[i * 3 + 2]; sum[c * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) if (sum[c * 4 + 3] > 0) for (let q = 0; q < 3; q++) C[c * 3 + q] = sum[c * 4 + q] / sum[c * 4 + 3];
    if (it > 0 && moved === 0) break;
  }
  for (let i = 0; i < n; i++) label[i] = assign(i);
  return { label, k };
}

/**
 * De-light and snap the visible voxels' colours (see the file comment). `cells` must hold a non-negative value
 * (any) for visible voxels; they receive palette indices. Returns what was done, for stats and research sheets.
 */
export function delightColours(g: VoxelGrid, cells: Int16Array, palette: PaletteColor[], o: DelightOptions = {}): DelightStats {
  const { nx, ny, nz, solid, visible, rgb } = g;
  const NL = nx * nz;
  const idx: number[] = [];
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < solid.length; i++) if (solid[i] && visible[i]) {
    idx.push(i);
    const y = Math.floor(i / NL);
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const n = idx.length;
  const stats: DelightStats = { mode: 'auto', clusters: 0, groups: [] };
  if (!n) return stats;

  // ---- per-voxel colour (OKLab as chroma ratio + lightness) and a "well lit" weight from the surface normal / height
  const vc: Col[] = new Array(n);
  const W = new Float32Array(n);
  const F = new Float32Array(n * 3);
  const airAt = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 1 : solid[x + nx * (z + nz * y)] ? 0 : 1);
  const lowBand = yMin + 0.1 * (yMax - yMin + 1);
  for (let k = 0; k < n; k++) {
    const i = idx[k];
    const [L, a, b] = linearToOklab(Math.max(0, rgb[i * 3]), Math.max(0, rgb[i * 3 + 1]), Math.max(0, rgb[i * 3 + 2]));
    const c = ratioOf(L, a, b);
    vc[k] = c;
    F[k * 3] = c.ra; F[k * 3 + 1] = c.rb; F[k * 3 + 2] = WL * L;
    const x = i % nx, z = Math.floor(i / nx) % nz, y = Math.floor(i / NL);
    const up = airAt(x, y + 1, z), dn = airAt(x, y - 1, z);
    const side = airAt(x - 1, y, z) + airAt(x + 1, y, z) + airAt(x, y, z - 1) + airAt(x, y, z + 1);
    let w = up ? 1 : side ? 0.7 : dn ? 0.25 : 0.5;
    if (y < lowBand) w *= 0.6; // contact shadow / ambient occlusion near the ground
    W[k] = w;
  }

  // ---- cluster
  const { label, k: K } = kmeans(F, n, o.clusters ?? 16);
  stats.clusters = K;
  const members: number[][] = Array.from({ length: K }, () => []);
  for (let k = 0; k < n; k++) members[label[k]].push(k);
  /** Unlit estimate of a voxel set: weighted mean chroma ratio, weighted L_PERCENTILE lightness. */
  const repr = (ks: number[]): Col => {
    // mean OKLab of the voxels in the [L_PERCENTILE - 0.2, L_PERCENTILE + 0.2] lightness band (weighted): real
    // texels, so the result stays in gamut (rebuilding from a mean chroma ratio at a high L over-saturated)
    let sw = 0;
    for (const k of ks) sw += W[k];
    const byL = ks.slice().sort((p, q) => vc[p].L - vc[q].L);
    let acc = 0, s = 0, L = 0, a = 0, b = 0;
    for (const k of byL) {
      const lo = acc / (sw || 1);
      acc += W[k];
      if (lo < L_PERCENTILE - 0.2 || lo > L_PERCENTILE + 0.2) continue;
      const d = Math.max(vc[k].L, RATIO_FLOOR);
      s += W[k]; L += W[k] * vc[k].L; a += W[k] * vc[k].ra * d; b += W[k] * vc[k].rb * d;
    }
    if (!s) return byL.length ? vc[byL[byL.length >> 1]] : { L: 0.5, ra: 0, rb: 0 };
    return ratioOf(L / s, a / s, b / s);
  };
  const cl = members.map((m) => ({ share: m.length / n, col: m.length ? repr(m) : { L: 0.5, ra: 0, rb: 0 } }));

  // ---- clusters -> groups
  const groupOf = new Int32Array(K).fill(-1);
  const groups: { name: string; share: number; col: Col; members: number[] }[] = [];
  const regions = (o.analysis?.colorRegions ?? [])
    .filter((r) => r && HEX.test(r.color) && Number.isFinite(r.share) && r.share >= MIN_REGION_SHARE)
    .map((r) => { const [L, a, b] = linearToOklab(...hexToLinear(r.color)); return { name: r.name || 'region', share: r.share, col: ratioOf(L, a, b) }; });
  if (regions.length) {
    stats.mode = 'regions';
    const total = regions.reduce((s, r) => s + r.share, 0);
    const R = regions.length;
    const chroma = (c: Col) => Math.hypot(c.ra, c.rb);
    const dist = (c: Col, r: Col) => {
      const dl = c.L - r.L; const wl = dl < 0 ? WL_DARK : WL_BRIGHT;
      let d = Math.hypot(chromaDist(c, r), wl * dl);
      if (!o.v1 && chroma(c) > CHROMA_MIN && chroma(r) < NEUTRAL) d += NEUTRAL_PULL * Math.max(0, chroma(c) - NEUTRAL_SLACK);
      return d;
    };
    const pairs: { c: number; r: number; d: number }[] = [];
    for (let c = 0; c < K; c++) if (cl[c].share > 0) for (let r = 0; r < R; r++) pairs.push({ c, r, d: dist(cl[c].col, regions[r].col) });
    pairs.sort((p, q) => p.d - q.d || p.c - q.c || p.r - q.r);
    const cap = regions.map((r) => CAP_K * (r.share / total) + CAP_PAD);
    const fill = new Float64Array(R);
    const toRegion = new Int32Array(K).fill(-1);
    for (const p of pairs) {
      if (toRegion[p.c] >= 0 || fill[p.r] + cl[p.c].share > cap[p.r]) continue;
      toRegion[p.c] = p.r; fill[p.r] += cl[p.c].share;
    }
    regions.forEach((r) => groups.push({ name: r.name, share: 0, col: r.col, members: [] }));
    for (let c = 0; c < K; c++) {
      if (!cl[c].share) continue;
      let r = toRegion[c];
      let dmin = Infinity, rmin = 0;
      for (let q = 0; q < R; q++) { const d = dist(cl[c].col, regions[q].col); if (d < dmin) { dmin = d; rmin = q; } }
      if (dmin > FAR && cl[c].share >= FAR_SHARE) {
        // a material the vision answer did not list: keep it, de-lit
        groupOf[c] = groups.length;
        groups.push({ name: `extra ${groups.length - R + 1}`, share: 0, col: cl[c].col, members: [] });
        continue;
      }
      if (r < 0) r = rmin;
      groupOf[c] = r;
    }
    // chromatic hue families: split their clusters by lightness rank in proportion to the region shares
    const famOf = regions.map((_, r) => r);
    for (let r = 0; r < R; r++) for (let q = 0; q < r; q++)
      if (chroma(regions[r].col) > NEUTRAL && chroma(regions[q].col) > NEUTRAL && chromaDist(regions[r].col, regions[q].col) < FAMILY_DC) { const a = famOf[q]; for (let k = 0; k < R; k++) if (famOf[k] === famOf[r]) famOf[k] = a; }
    for (let f = 0; f < R && !o.v1; f++) {
      const rs = regions.map((_, r) => r).filter((r) => famOf[r] === f);
      if (rs.length < 2) continue;
      const cs = [];
      for (let c = 0; c < K; c++) if (cl[c].share > 0 && groupOf[c] >= 0 && groupOf[c] < R && famOf[groupOf[c]] === f) cs.push(c);
      if (cs.length < 2) continue;
      cs.sort((a, b) => cl[b].col.L - cl[a].col.L || a - b);
      rs.sort((a, b) => regions[b].col.L - regions[a].col.L || a - b);
      const tot = cs.reduce((s, c) => s + cl[c].share, 0), rTot = rs.reduce((s, r) => s + regions[r].share, 0);
      let acc = 0;
      for (const c of cs) {
        const mid = (acc + cl[c].share / 2) / tot;
        acc += cl[c].share;
        let edge = 0, pickR = rs[rs.length - 1];
        for (const r of rs) { edge += regions[r].share / rTot; if (mid <= edge + 1e-9) { pickR = r; break; } }
        groupOf[c] = pickR;
      }
    }
  } else {
    // agglomerative merge of clusters that differ mainly in lightness
    const gs = cl.map((c, i) => ({ share: c.share, col: { ...c.col }, ids: [i] })).filter((x) => x.share > 0);
    for (;;) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < gs.length; i++)
        for (let j = i + 1; j < gs.length; j++) {
          const p = gs[i].col, q = gs[j].col;
          const dc = chromaDist(p, q), dl = Math.abs(p.L - q.L);
          const neutral = Math.hypot(p.ra, p.rb) < NEUTRAL && Math.hypot(q.ra, q.rb) < NEUTRAL;
          if (dc >= MERGE_DC || dl >= (neutral ? MERGE_DL_NEUTRAL : MERGE_DL)) continue;
          const d = dc + 0.25 * dl;
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      if (bi < 0) break;
      const a = gs[bi], b = gs[bj], s = a.share + b.share;
      a.col = { L: (a.col.L * a.share + b.col.L * b.share) / s, ra: (a.col.ra * a.share + b.col.ra * b.share) / s, rb: (a.col.rb * a.share + b.col.rb * b.share) / s };
      a.share = s; a.ids.push(...b.ids);
      gs.splice(bj, 1);
    }
    // small leftovers (texture noise, a shadow tinted by the light) join the nearest big group with a similar chroma
    gs.sort((p, q) => q.share - p.share);
    for (let i = gs.length - 1; i > 0; i--) {
      if (gs[i].share >= SMALL_GROUP) continue;
      let bj = -1, bd = Infinity;
      for (let j = 0; j < gs.length; j++) {
        if (j === i || gs[j].share < SMALL_GROUP) continue;
        const dc = chromaDist(gs[i].col, gs[j].col);
        const d = dc + 0.25 * Math.abs(gs[i].col.L - gs[j].col.L);
        if (dc < SMALL_DC && d < bd) { bd = d; bj = j; }
      }
      if (bj < 0) continue;
      gs[bj].share += gs[i].share; gs[bj].ids.push(...gs[i].ids);
      gs.splice(i, 1);
    }
    gs.forEach((x, gi) => { for (const c of x.ids) groupOf[c] = gi; groups.push({ name: `auto ${gi + 1}`, share: 0, col: x.col, members: [] }); });
  }
  for (let c = 0; c < K; c++) if (groupOf[c] >= 0) for (const k of members[c]) groups[groupOf[c]].members.push(k);
  if (regions.length && !o.v1) groundRegions(groups, regions, idx, NL, yMin, yMax);
  for (const gr of groups) gr.share = gr.members.length / n;
  // de-lit colour of the data-driven groups from their own voxels (vision regions keep the reported colour)
  for (const gr of groups) if (!regions.length || gr.name.startsWith('extra')) if (gr.members.length) gr.col = repr(gr.members);

  // ---- groups -> LEGO colours
  // data-driven groups: the LEGO colour most of the group's well-lit voxels match (a vote is robust to the
  // over-saturated / over-bright texels of AI textures); vision regions: their reported colour
  const matcher = new ColorMatcher(palette);
  const targets = groups.map((gr) => {
    let lin = colToLinear(gr.col);
    if (AUTO_VOTE && (!regions.length || gr.name.startsWith('extra')) && gr.members.length) {
      const votes = new Float64Array(palette.length);
      for (const k of gr.members) { const i = idx[k]; votes[matcher.match(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])] += W[k]; }
      let bp = 0;
      for (let p = 1; p < votes.length; p++) if (votes[p] > votes[bp]) bp = p;
      lin = hexToLinear(palette[bp].hex);
    }
    return { lin, lab: linearToCielab(...lin), share: gr.share };
  });
  const pick = mapToPalette(targets, palette, groups.map((_, gi) => (gi < regions.length && !o.v1 ? RARE_PENALTY_REGION : RARE_PENALTY)));
  const palLin = palette.map((p) => hexToLinear(p.hex));
  for (let gi = 0; gi < groups.length; gi++) {
    const p = pick[gi];
    for (const k of groups[gi].members) {
      const i = idx[k];
      cells[i] = p;
      rgb[i * 3] = palLin[p][0]; rgb[i * 3 + 1] = palLin[p][1]; rgb[i * 3 + 2] = palLin[p][2];
    }
  }
  stats.groups = groups
    .map((gr, gi) => ({ name: gr.name, share: Math.round(gr.share * 1000) / 1000, color: toHex(targets[gi].lin), code: palette[pick[gi]].code }))
    .filter((x) => x.share > 0);
  return stats;
}

/**
 * Palette index per target colour: nearest by CIEDE2000 (+ RARE_PENALTY for colours outside CORE_COLOR_CODES), larger
 * targets first; a target whose best colour is already taken by a clearly different target (> DISTINCT_DE) takes its
 * next-best unused colour when that is at most DISTINCT_SLACK worse.
 */
export function mapToPalette(targets: { lab: Lab; share: number }[], palette: PaletteColor[], rare?: number[]): number[] {
  const pal = palette.map((p) => linearToCielab(...hexToLinear(p.hex)));
  const pen = (t: number, p: number) => (CORE_COLOR_CODES.has(palette[p].code) ? 0 : rare?.[t] ?? RARE_PENALTY);
  const out = new Array<number>(targets.length).fill(0);
  const owner = new Map<number, number>();
  const order = targets.map((_, i) => i).sort((a, b) => targets[b].share - targets[a].share || a - b);
  for (const t of order) {
    const score = pal.map((l, p) => ciede2000(targets[t].lab, l) + pen(t, p));
    const cand = score.map((_, p) => p).sort((a, b) => score[a] - score[b]);
    let choice = cand[0];
    const o = owner.get(choice);
    if (o !== undefined && ciede2000(targets[t].lab, targets[o].lab) > DISTINCT_DE) {
      const alt = cand.find((p) => !owner.has(p) && score[p] <= score[cand[0]] + DISTINCT_SLACK);
      if (alt !== undefined) choice = alt;
    }
    out[t] = choice;
    if (!owner.has(choice)) owner.set(choice, t);
  }
  return out;
}

/**
 * Ground regions (GROUND_NAME, see above): a ground region that shares a neutral hue family with a bigger region keeps
 * only the family's voxels in the bottom band; family voxels above it go to the biggest region of the family.
 */
function groundRegions(groups: { name: string; members: number[] }[], regions: { name: string; share: number; col: Col }[], idx: number[], NL: number, yMin: number, yMax: number) {
  const R = regions.length;
  const H = yMax - yMin + 1;
  for (let g = 0; g < R; g++) {
    if (!GROUND_NAME.test(regions[g].name)) continue;
    const fam = regions.map((_, r) => r).filter((r) => chromaDist(regions[r].col, regions[g].col) < FAMILY_DC && Math.abs(regions[r].col.L - regions[g].col.L) > 0.02 || r === g);
    if (fam.length < 2) continue;
    let main = -1;
    for (const r of fam) if (r !== g && (main < 0 || regions[r].share > regions[main].share)) main = r;
    if (regions[main].share <= regions[g].share) continue;
    // family voxels per layer from the bottom; the band holds the ground region's share of the family
    const famShare = fam.reduce((s, r) => s + regions[r].share, 0);
    const perLayer = new Float64Array(H);
    let tot = 0;
    for (const r of fam) for (const k of groups[r].members) { perLayer[Math.floor(idx[k] / NL) - yMin]++; tot++; }
    const want = (regions[g].share / famShare) * tot;
    let band = 1, acc = perLayer[0];
    while (band < Math.max(1, Math.round(GROUND_MAX * H)) && acc + perLayer[band] / 2 < want) acc += perLayer[band++];
    const top = yMin + band;
    const keepG: number[] = [];
    for (const r of fam) {
      const keep: number[] = [];
      for (const k of groups[r].members) {
        const low = Math.floor(idx[k] / NL) < top;
        if (low) keepG.push(k); else if (r === g) groups[main].members.push(k); else keep.push(k);
      }
      if (r !== g) groups[r].members = keep;
    }
    groups[g].members = keepG;
  }
}
