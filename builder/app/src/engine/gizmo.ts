// Move/rotate gizmo (visual only). Geometry is authored in screen PIXELS: the engine scales the
// group every frame by "world units per pixel" so the handles keep a constant on-screen size.
// Lives in three.js world space (+Y up), drawn on top of everything (depthTest off).
// Hit-testing is done by the engine in screen space (generous ≥ 48 px targets), not by raycasting.
// Spec: docs/UX_REVIEW.md §3.7 — 6 cone handles (no shafts), yellow ring with one grabbable knob.
import * as THREE from 'three';

export type HandleId = 'x+' | 'x-' | 'z+' | 'z-' | 'y+' | 'y-' | 'ring' | 'body';

/** Drawn cone length in px. */
export const CONE_LEN = 22;
const CONE_R = 11;
const RING_TUBE = 2.5;
const KNOB_R = 14;

const COLORS = { x: 0xe5484d, y: 0x30a46c, z: 0x3e7bfa, ring: 0xf5c33b };
const HOT = new THREE.Color(0xffffff);

export interface GizmoArrow {
  id: HandleId;
  /** Unit direction in three world space. */
  dir: THREE.Vector3;
  group: THREE.Group;
  mat: THREE.MeshBasicMaterial;
  color: THREE.Color;
}

function overlayMat(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({
    color, depthTest: false, depthWrite: false, transparent: true, opacity, toneMapped: false,
  });
}

/** A mesh with a white outline and a dark halo behind it (so red-on-red stays visible). */
function outlined(geo: THREE.BufferGeometry, mat: THREE.Material, white: THREE.Material, halo: THREE.Material, order: number) {
  const g = new THREE.Group();
  const h = new THREE.Mesh(geo, halo);
  h.scale.setScalar(1.55);
  h.renderOrder = order;
  const w = new THREE.Mesh(geo, white);
  w.scale.setScalar(1.28);
  w.renderOrder = order + 1;
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = order + 2;
  g.add(h, w, m);
  return g;
}

export class Gizmo {
  readonly group = new THREE.Group();
  readonly arrows: GizmoArrow[] = [];
  readonly ring = new THREE.Group();
  /** Fixed ticks at the 90° detents. */
  readonly ticks = new THREE.Group();
  /** Knob pivot: rotation.y = current heading; the knob sits on the ring at local +X. */
  readonly knobPivot = new THREE.Group();
  ringR = 0;
  private ringMesh: THREE.Mesh;
  private ringMat = overlayMat(COLORS.ring);
  private ringColor = new THREE.Color(COLORS.ring);
  private knob: THREE.Group;
  private white = overlayMat(0xffffff);
  private halo = overlayMat(0x111827, 0.35);
  private coneGeo = new THREE.ConeGeometry(CONE_R, CONE_LEN, 24); // centred on its middle, tip at +Y
  private knobGeo = new THREE.SphereGeometry(KNOB_R, 20, 14);
  private tickGeo = new THREE.BoxGeometry(14, 4, 4);
  private hot: HandleId | null = null;

  constructor() {
    const up = new THREE.Vector3(0, 1, 0);
    const defs: Array<[HandleId, THREE.Vector3, number]> = [
      ['x+', new THREE.Vector3(1, 0, 0), COLORS.x],
      ['x-', new THREE.Vector3(-1, 0, 0), COLORS.x],
      ['z+', new THREE.Vector3(0, 0, 1), COLORS.z],
      ['z-', new THREE.Vector3(0, 0, -1), COLORS.z],
      ['y+', new THREE.Vector3(0, 1, 0), COLORS.y],
      ['y-', new THREE.Vector3(0, -1, 0), COLORS.y],
    ];
    for (const [id, dir, color] of defs) {
      const mat = overlayMat(color);
      const g = outlined(this.coneGeo, mat, this.white, this.halo, 34);
      g.quaternion.setFromUnitVectors(up, dir);
      this.group.add(g);
      this.arrows.push({ id, dir, group: g, mat, color: new THREE.Color(color) });
    }
    this.ringMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.ringMat);
    this.ringMesh.renderOrder = 30;
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Mesh(this.tickGeo, this.ringMat);
      t.renderOrder = 30;
      this.ticks.add(t);
    }
    this.knob = outlined(this.knobGeo, this.ringMat, this.white, this.halo, 31);
    this.knobPivot.add(this.knob);
    this.ring.add(this.ringMesh, this.ticks, this.knobPivot);
    this.group.add(this.ring);
    // three sorts by the nearest Group's renderOrder first: keep every gizmo group above the
    // (transparent, renderOrder 5) ghost so the handles are never hidden behind it.
    this.group.traverse((o) => { if ((o as THREE.Group).isGroup) o.renderOrder = 40; });
    this.setRingRadius(90);
  }

  /** Ring radius in px; geometry is rebuilt only when it changes by ≥ 4 px. */
  setRingRadius(r: number) {
    const q = Math.round(r / 4) * 4;
    if (q === this.ringR) return;
    this.ringR = q;
    this.ringMesh.geometry.dispose();
    this.ringMesh.geometry = new THREE.TorusGeometry(q, RING_TUBE, 8, 96).rotateX(Math.PI / 2);
    this.knob.position.set(q, 0, 0);
    this.ticks.children.forEach((t, i) => {
      const a = (i * Math.PI) / 2;
      t.position.set(Math.cos(a) * q, 0, -Math.sin(a) * q);
      t.rotation.y = a;
    });
  }

  /** Highlight one handle (hover or active drag). */
  setHot(id: HandleId | null) {
    if (id === this.hot) return;
    this.hot = id;
    for (const a of this.arrows) {
      const on = a.id === id;
      a.mat.color.copy(a.color);
      if (on) a.mat.color.lerp(HOT, 0.3);
      a.group.scale.setScalar(on ? 1.2 : 1);
    }
    this.ringMat.color.copy(this.ringColor);
    if (id === 'ring') this.ringMat.color.lerp(HOT, 0.3);
    this.knob.scale.setScalar(id === 'ring' ? 1.2 : 1);
  }

  dispose() {
    this.coneGeo.dispose();
    this.knobGeo.dispose();
    this.tickGeo.dispose();
    this.ringMesh.geometry.dispose();
    this.ringMat.dispose();
    this.white.dispose();
    this.halo.dispose();
    for (const a of this.arrows) a.mat.dispose();
  }
}
