// Snapping feedback under the pending / dragged brick (docs/UX_REVIEW.md §3.7 "Ghost appearance"):
// a dark footprint on the first surface below, white dots on the studs it will connect to and a
// dashed drop line when it floats. All instanced / fixed-size buffers; updated only when it changes.
import * as THREE from 'three';

const MAX_RECTS = 64;
const MAX_DOTS = 512;

export interface FootRect {
  /** Centre and half sizes in three world x/z; heading = rotation around +Y (radians). */
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  heading: number;
  /** three world Y of the surface and of the brick bottom. */
  surfaceY: number;
  bottomY: number;
}

export class Footprint {
  readonly group = new THREE.Group();
  private rectGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private rectMat = new THREE.MeshBasicMaterial({
    color: 0x0b1220, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  private rects = new THREE.InstancedMesh(this.rectGeo, this.rectMat, MAX_RECTS);
  private dotGeo = new THREE.CircleGeometry(3.4, 14).rotateX(-Math.PI / 2);
  private dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
  private dots = new THREE.InstancedMesh(this.dotGeo, this.dotMat, MAX_DOTS);
  private lineGeo = new THREE.BufferGeometry();
  private lineMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 5, gapSize: 4, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
  private line: THREE.LineSegments;
  private linePos = new Float32Array(MAX_RECTS * 6);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.line = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.line.frustumCulled = false;
    this.rects.frustumCulled = false;
    this.dots.frustumCulled = false;
    this.rects.renderOrder = 3;
    this.dots.renderOrder = 4;
    this.line.renderOrder = 6;
    this.group.add(this.rects, this.dots, this.line);
    this.group.visible = false;
  }

  hide() {
    this.group.visible = false;
  }

  update(rects: FootRect[], dots: Array<[number, number, number]>) {
    const n = Math.min(rects.length, MAX_RECTS);
    let segs = 0;
    for (let i = 0; i < n; i++) {
      const r = rects[i];
      this.q.setFromAxisAngle(this.up, r.heading);
      this.v.set(r.cx, r.surfaceY, r.cz);
      this.s.set(r.hx * 2, 1, r.hz * 2);
      this.rects.setMatrixAt(i, this.m.compose(this.v, this.q, this.s));
      if (r.bottomY - r.surfaceY > 0.5) {
        this.linePos.set([r.cx, r.bottomY, r.cz, r.cx, r.surfaceY, r.cz], segs * 6);
        segs++;
      }
    }
    this.rects.count = n;
    this.rects.instanceMatrix.needsUpdate = true;
    const nd = Math.min(dots.length, MAX_DOTS);
    this.q.identity();
    this.s.set(1, 1, 1);
    for (let i = 0; i < nd; i++) {
      this.v.set(dots[i][0], dots[i][1], dots[i][2]);
      this.dots.setMatrixAt(i, this.m.compose(this.v, this.q, this.s));
    }
    this.dots.count = nd;
    this.dots.instanceMatrix.needsUpdate = true;
    (this.lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.lineGeo.setDrawRange(0, segs * 2);
    this.line.visible = segs > 0;
    if (segs) this.line.computeLineDistances();
    this.group.visible = n > 0;
  }

  dispose() {
    this.rectGeo.dispose();
    this.rectMat.dispose();
    this.dotGeo.dispose();
    this.dotMat.dispose();
    this.lineGeo.dispose();
    this.lineMat.dispose();
    this.rects.dispose();
    this.dots.dispose();
  }
}
