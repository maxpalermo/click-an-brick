// Part geometry library: loads LDraw parts once (via three's LDrawLoader), keeps a flattened
// template per part, instantiates per-brick objects that share geometry, and manages shared
// per-colour materials plus derived "look" variants (selected / faded / ghost / blocked).
import * as THREE from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import type { BrickColor } from '../model/types';

export type NodeKind = 'face' | 'edge' | 'cond';
export type Look = 'normal' | 'selected' | 'faded' | 'ghost' | 'blocked';
type Renderable = THREE.Mesh | THREE.LineSegments;

/** Edge / conditional lines live on this layer so the raycaster (layer 0) ignores them. */
export const EDGE_LAYER = 1;
/** Conditional (silhouette) lines: off by default — normal edges already look LEGO-like. */
export const SHOW_CONDITIONAL_LINES = false;

export interface TemplateNode {
  src: Renderable;
  kind: NodeKind;
  /** Transform relative to the part origin. */
  matrix: THREE.Matrix4;
  /** Per material slot: true when it is the "main colour" (16 / 24) and must take the brick colour. */
  main: boolean[];
  isArray: boolean;
}

export interface PartTemplate {
  id: string;
  nodes: TemplateNode[];
  /** Full bounding box in part-local LDraw coordinates. */
  box: THREE.Box3;
  /** Box without the studs on top: used for stacking and collisions. */
  body: THREE.Box3;
  missing: boolean;
}

export interface BuiltNode {
  obj: Renderable;
  kind: NodeKind;
  tpl: TemplateNode;
  /** Resolved materials (brick colour applied), before any look variant. */
  base: THREE.Material[];
}

export interface BuiltPart {
  group: THREE.Group;
  nodes: BuiltNode[];
}

/** The subset of LDrawLoader we rely on (typed loosely to survive minor typing differences). */
interface LoaderLike {
  smoothNormals: boolean;
  setPartsLibraryPath(p: string): unknown;
  preloadMaterials(url: string): Promise<void>;
  parse(text: string, onLoad: (g: THREE.Group) => void, onError?: (e: unknown) => void): void;
  loadAsync(url: string): Promise<THREE.Group>;
  getMaterial?(code: string): THREE.Material | null;
  materialLibrary?: Record<string, THREE.Material>;
  materials?: THREE.Material[];
  edgeMaterialCache?: WeakMap<THREE.Material, THREE.Material>;
  conditionalEdgeMaterialCache?: WeakMap<THREE.Material, THREE.Material>;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function ldconfigText(colors: BrickColor[]): string {
  const byCode = new Map(colors.map((c) => [c.code, c]));
  const lines: string[] = [];
  for (const c of colors) {
    const name = (c.name || `Colour_${c.code}`).replace(/\s+/g, '_');
    const hex = HEX_RE.test(c.hex) ? c.hex : '#888888';
    let edge = c.edge;
    if (!HEX_RE.test(edge ?? '')) {
      const ref = byCode.get(Number(edge));
      edge = ref && HEX_RE.test(ref.hex) ? ref.hex : '#333333';
    }
    let s = `0 !COLOUR ${name} CODE ${c.code} VALUE ${hex} EDGE ${edge}`;
    if (typeof c.alpha === 'number' && c.alpha < 255) s += ` ALPHA ${Math.max(0, Math.round(c.alpha))}`;
    switch (c.material) {
      case 'chrome': s += ' CHROME'; break;
      case 'metal': s += ' METAL'; break;
      case 'pearl': s += ' PEARLESCENT'; break;
      case 'rubber': s += ' RUBBER'; break;
      default: break;
    }
    lines.push(s);
  }
  return lines.join('\n') + '\n';
}

/**
 * Prepare packed MPD text for LDrawLoader.parse: normalise slashes / whitespace and add a tiny
 * root file that references the first embedded file, so that every `0 FILE` section (including
 * the part itself) is registered as an embedded file regardless of leading header lines.
 */
function wrapPacked(text: string, id: string): string {
  const lines = text.replace(/^﻿/, '').replace(/\\/g, '/').split(/\r\n|\r|\n/).map((l) => {
    const t = l.trim();
    return /^0\s+FILE\s+/i.test(t) ? '0 FILE ' + t.replace(/^0\s+FILE\s+/i, '').trim() : t;
  });
  const firstFile = lines.find((l) => l.startsWith('0 FILE '));
  if (!firstFile) return lines.join('\n');
  const main = firstFile.slice(7) || id;
  return ['0 FILE __brickyard_root.ldr', `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${main}`, '', ...lines].join('\n');
}

function asArray(m: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(m) ? m : [m];
}

export class PartLibrary {
  private loader: LoaderLike;
  private ready: Promise<void>;
  private templates = new Map<string, PartTemplate>();
  private inflight = new Map<string, Promise<PartTemplate>>();
  private tracked = new Set<string>();
  private listeners = new Set<(n: number) => void>();
  private variants = new Map<string, THREE.Material | null>();
  private mainSet = new Set<THREE.Material>();
  private owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  private fallbackFace = new THREE.MeshStandardMaterial({ color: 0xa0a5a9, roughness: 0.35 });
  private fallbackEdge = new THREE.LineBasicMaterial({ color: 0x333333 });
  /**
   * "Not allowed" look: screen-space red / white diagonal stripes, so a blocked brick never reads as
   * just "a red brick" (works for red parts and in dark mode). Shared by every blocked node.
   */
  readonly blockedFace = stripedBlockedMaterial();
  readonly blockedEdge = new THREE.LineBasicMaterial({ color: 0xbe123c, transparent: true, opacity: 0.95 });
  private disposed = false;

  constructor(private apiBase: string, colors: BrickColor[]) {
    const loader = new LDrawLoader() as unknown as LoaderLike;
    loader.smoothNormals = true;
    loader.setPartsLibraryPath(`${apiBase}/ldraw/`);
    this.loader = loader;
    this.owned.push(this.fallbackFace, this.fallbackEdge, this.blockedFace, this.blockedEdge);
    this.ready = this.initMaterials(colors);
  }

  private async initMaterials(colors: BrickColor[]): Promise<void> {
    let ok = false;
    if (colors.length) {
      const url = URL.createObjectURL(new Blob([ldconfigText(colors)], { type: 'text/plain' }));
      try {
        await this.loader.preloadMaterials(url);
        ok = true;
      } catch (err) {
        console.warn('[engine] could not build materials from colours', err);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!ok) {
      try {
        await this.loader.preloadMaterials(`${this.apiBase}/ldraw/LDConfig.ldr`);
      } catch (err) {
        console.warn('[engine] LDConfig.ldr not available, using default materials', err);
      }
    }
    for (const code of ['16', '24']) {
      const m = this.libMaterial(code);
      if (!m) continue;
      this.mainSet.add(m);
      const edge = this.edgeOf(m);
      if (edge) {
        this.mainSet.add(edge);
        const cond = this.condOf(edge);
        if (cond) this.mainSet.add(cond);
      }
    }
  }

  private edgeOf(face: THREE.Material): THREE.Material | null {
    return this.loader.edgeMaterialCache?.get(face) ?? (face.userData.edgeMaterial as THREE.Material | undefined) ?? null;
  }

  private condOf(edge: THREE.Material): THREE.Material | null {
    return this.loader.conditionalEdgeMaterialCache?.get(edge) ?? null;
  }

  private libMaterial(code: string): THREE.Material | null {
    const l = this.loader;
    return (l.getMaterial ? l.getMaterial(code) : null) ?? l.materialLibrary?.[code] ?? null;
  }

  /** Shared face material for an LDraw colour code. */
  colorMaterial(color: number): THREE.Material {
    return this.libMaterial(String(color)) ?? this.libMaterial('7') ?? this.libMaterial('16') ?? this.fallbackFace;
  }

  private isMain(m: THREE.Material): boolean {
    if (this.mainSet.has(m)) return true;
    const code = m.userData?.code;
    return code !== undefined && (String(code) === '16' || String(code) === '24');
  }

  // ---------------------------------------------------------------- loading

  onPending(cb: (n: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get pendingCount(): number {
    return this.tracked.size;
  }

  private emit() {
    for (const cb of this.listeners) cb(this.tracked.size);
  }

  peek(id: string): PartTemplate | null {
    return this.templates.get(id.toLowerCase()) ?? null;
  }

  /** Load (once) and return the template of a part. `track` = count it for the loading spinner. */
  get(id: string, track = true): Promise<PartTemplate> {
    const key = id.toLowerCase();
    const done = this.templates.get(key);
    if (done) return Promise.resolve(done);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.loadTemplate(id).then((t) => {
        this.templates.set(key, t);
        this.inflight.delete(key);
        return t;
      });
      this.inflight.set(key, p);
    }
    if (track && !this.tracked.has(key)) {
      this.tracked.add(key);
      this.emit();
      p.finally(() => {
        this.tracked.delete(key);
        if (!this.disposed) this.emit();
      });
    }
    return p;
  }

  private parseText(text: string): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LDraw parse timeout')), 30000);
      try {
        this.loader.parse(
          text,
          (g) => { clearTimeout(timer); resolve(g); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private async loadTemplate(id: string): Promise<PartTemplate> {
    await this.ready;
    let group: THREE.Group | null = null;
    try {
      const res = await fetch(`${this.apiBase}/api/parts/${encodeURIComponent(id)}/packed`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      group = await this.parseText(wrapPacked(await res.text(), id));
    } catch (err) {
      console.warn(`[engine] packed load failed for ${id}, trying library path`, err);
      try {
        group = await this.loader.loadAsync(`${this.apiBase}/ldraw/parts/${id}`);
      } catch (err2) {
        console.warn(`[engine] could not load part ${id}`, err2);
      }
    }
    if (group) {
      const t = this.makeTemplate(id, group);
      if (t) return t;
    }
    return this.placeholder(id);
  }

  private makeTemplate(id: string, group: THREE.Group): PartTemplate | null {
    group.updateMatrixWorld(true);
    const nodes: TemplateNode[] = [];
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    group.traverse((o) => {
      let kind: NodeKind;
      if ((o as THREE.Mesh).isMesh) kind = 'face';
      else if ((o as THREE.LineSegments).isLineSegments) {
        kind = (o as unknown as { isConditionalLine?: boolean }).isConditionalLine ? 'cond' : 'edge';
      } else return;
      const r = o as Renderable;
      if (!r.geometry || !r.material) return;
      const mats = asArray(r.material);
      const matrix = r.matrixWorld.clone();
      nodes.push({ src: r, kind, matrix, main: mats.map((m) => this.isMain(m)), isArray: Array.isArray(r.material) });
      if (kind === 'face') {
        r.geometry.computeBoundingBox();
        if (r.geometry.boundingBox) box.union(tmp.copy(r.geometry.boundingBox).applyMatrix4(matrix));
      }
    });
    if (!nodes.length || box.isEmpty()) return null;
    return { id, nodes, box, body: bodyBox(box), missing: false };
  }

  /** A grey 1x1-brick-sized box for parts that fail to load, so the model stays editable. */
  private placeholder(id: string): PartTemplate {
    const geo = new THREE.BoxGeometry(20, 24, 20);
    geo.translate(0, 12, 0);
    const edges = new THREE.EdgesGeometry(geo);
    this.owned.push(geo, edges);
    const face = this.libMaterial('16') ?? this.fallbackFace;
    const edgeMat = this.edgeOf(face) ?? this.fallbackEdge;
    this.mainSet.add(face);
    this.mainSet.add(edgeMat);
    const mesh = new THREE.Mesh(geo, face);
    const lines = new THREE.LineSegments(edges, edgeMat);
    const box = new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 24, 10));
    return {
      id,
      nodes: [
        { src: mesh, kind: 'face', matrix: new THREE.Matrix4(), main: [true], isArray: false },
        { src: lines, kind: 'edge', matrix: new THREE.Matrix4(), main: [true], isArray: false },
      ],
      box,
      body: box.clone(),
      missing: true,
    };
  }

  // ---------------------------------------------------------------- instancing

  private mainFor(color: number, kind: NodeKind, fallback: THREE.Material): THREE.Material {
    const face = this.colorMaterial(color);
    if (kind === 'face') return face;
    const edge = this.edgeOf(face);
    if (kind === 'edge') return edge ?? fallback;
    return (edge && this.condOf(edge)) ?? fallback;
  }

  private resolve(t: TemplateNode, color: number): THREE.Material[] {
    return asArray(t.src.material).map((m, i) => (t.main[i] ? this.mainFor(color, t.kind, m) : m));
  }

  /** Resolved materials of a template node for a brick colour (main colour applied, 'normal' look). */
  nodeMaterials(t: TemplateNode, color: number): THREE.Material[] {
    return this.resolve(t, color);
  }

  /** Create a per-brick object sharing the template geometry. */
  instantiate(t: PartTemplate, color: number, look: Look = 'normal', shadows = true): BuiltPart {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const nodes: BuiltNode[] = t.nodes.map((tn) => {
      const obj = tn.src.clone(false) as Renderable;
      obj.userData = {};
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(tn.matrix);
      if (tn.kind === 'face') {
        obj.castShadow = shadows;
        obj.receiveShadow = shadows;
      } else {
        obj.layers.set(EDGE_LAYER);
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
      group.add(obj);
      return { obj, kind: tn.kind, tpl: tn, base: this.resolve(tn, color) };
    });
    const built = { group, nodes };
    this.applyLook(built.nodes, look);
    return built;
  }

  recolor(nodes: BuiltNode[], color: number, look: Look) {
    for (const n of nodes) n.base = this.resolve(n.tpl, color);
    this.applyLook(nodes, look);
  }

  applyLook(nodes: BuiltNode[], look: Look) {
    for (const n of nodes) {
      const mats = n.base.map((m) => this.variant(m, n.kind, look));
      if (mats.some((m) => !m)) {
        n.obj.visible = false;
        continue;
      }
      n.obj.visible = n.kind === 'cond' ? SHOW_CONDITIONAL_LINES : true;
      const ms = mats as THREE.Material[];
      n.obj.material = n.tpl.isArray ? ms : ms[0];
    }
  }

  /** Derived material for a look; null = hide this node. Cached per (material, look). */
  variant(m: THREE.Material, kind: NodeKind, look: Look): THREE.Material | null {
    if (look === 'normal') return m;
    if (look === 'blocked') return kind === 'face' ? this.blockedFace : kind === 'edge' ? this.blockedEdge : null;
    if (look === 'selected' && kind !== 'face') return m;
    if (kind === 'cond') return null;
    if (look === 'faded' && kind !== 'face') return null;
    const key = `${m.uuid}|${look}`;
    if (this.variants.has(key)) return this.variants.get(key)!;
    const c = m.clone();
    const anyC = c as unknown as {
      emissive?: THREE.Color; emissiveIntensity?: number; color?: THREE.Color;
    };
    if (look === 'selected') {
      if (anyC.emissive) {
        anyC.emissive.setHex(0x2563eb);
        anyC.emissiveIntensity = 0.3;
      }
    } else if (look === 'faded') {
      c.transparent = true;
      c.opacity = 0.28 * (m.opacity ?? 1);
      c.depthWrite = false;
      anyC.color?.lerp(new THREE.Color(0x9aa3ad), 0.55);
    } else if (look === 'ghost') {
      c.transparent = true;
      c.opacity = Math.min(m.opacity ?? 1, kind === 'face' ? 0.55 : 0.5);
      c.depthWrite = false;
    }
    this.variants.set(key, c);
    this.owned.push(c);
    return c;
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    for (const t of this.templates.values()) {
      for (const n of t.nodes) n.src.geometry.dispose();
    }
    for (const m of this.loader.materials ?? []) {
      const edge = this.edgeOf(m);
      if (edge) {
        this.condOf(edge)?.dispose();
        edge.dispose();
      }
      m.dispose();
    }
    for (const o of this.owned) o.dispose();
    this.templates.clear();
    this.variants.clear();
  }
}

function stripedBlockedMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0x2a0010, roughness: 0.6, transparent: true, opacity: 0.78, depthWrite: false,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      {
        float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 22.0));
        diffuseColor.rgb = mix(vec3(0.80, 0.02, 0.10), vec3(1.0), stripe);
      }`,
    );
  };
  m.customProgramCacheKey = () => 'brickyard-blocked-stripes';
  return m;
}

/** Strip the studs (≤ 4.5 LDU above the origin plane) off the top of a part box. */
function bodyBox(box: THREE.Box3): THREE.Box3 {
  const b = box.clone();
  if (b.min.y < 0 && b.min.y >= -4.5 && b.max.y > 0) b.min.y = 0;
  return b;
}
