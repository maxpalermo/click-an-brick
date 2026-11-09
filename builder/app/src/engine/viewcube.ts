// View cube (docs/UX_REVIEW.md §3.6): a small labelled cube drawn into a corner of the main canvas
// (separate viewport + scissor, same renderer), rotating with the camera. Tap a face → camera preset.
import * as THREE from 'three';

/** Face normals in three world space, BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. */
const FACES: Array<{ label: string; n: THREE.Vector3 }> = [
  { label: 'RIGHT', n: new THREE.Vector3(1, 0, 0) },
  { label: 'LEFT', n: new THREE.Vector3(-1, 0, 0) },
  { label: 'TOP', n: new THREE.Vector3(0, 1, 0) },
  { label: 'BOTTOM', n: new THREE.Vector3(0, -1, 0) },
  { label: 'FRONT', n: new THREE.Vector3(0, 0, 1) },
  { label: 'BACK', n: new THREE.Vector3(0, 0, -1) },
];

const FACE_BG = '#f4efe6';
const FACE_HOT = '#ffe08a';

function faceTexture(label: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#8a909c';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  g.fillStyle = '#2b303b';
  g.font = `800 ${label.length > 5 ? 22 : 26}px Nunito, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ViewCube {
  /** Drawn size in CSS px (hit area = the whole square, ≥ 44 px). */
  readonly size = 60;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  /** Top-left of the cube square in canvas CSS px. */
  x = 0;
  y = 0;
  visible = true;
  private cube: THREE.Mesh;
  private mats: THREE.MeshBasicMaterial[];
  private texNormal: THREE.CanvasTexture[];
  private texHot: THREE.CanvasTexture[];
  private disc: THREE.Mesh;
  private edges: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private hot = -1;

  constructor() {
    this.texNormal = FACES.map((f) => faceTexture(f.label, FACE_BG));
    this.texHot = FACES.map((f) => faceTexture(f.label, FACE_HOT));
    this.mats = this.texNormal.map((t) => new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.cube = new THREE.Mesh(geo, this.mats);
    this.edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x6b7280, toneMapped: false }),
    );
    this.cube.add(this.edges);
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.98, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }),
    );
    this.disc.position.z = -4; // in front of the far plane, behind the cube
    this.disc.renderOrder = -1;
    this.camera.add(this.disc);
    this.scene.add(this.cube, this.camera);
    const h = 0.95;
    this.camera.left = -h; this.camera.right = h; this.camera.top = h; this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
  }

  /** Follow the main camera's orientation. */
  sync(main: THREE.Camera) {
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 3).applyQuaternion(main.quaternion);
    this.camera.updateMatrixWorld();
  }

  contains(lx: number, ly: number): boolean {
    return this.visible && lx >= this.x && lx <= this.x + this.size && ly >= this.y && ly <= this.y + this.size;
  }

  /**
   * Hit test in canvas CSS px. Returns the view direction to snap to (three world, from target to
   * camera): a face normal, or an edge / corner direction when the tap is near one.
   */
  pick(lx: number, ly: number): { dir: THREE.Vector3; face: number } | null {
    if (!this.contains(lx, ly)) return null;
    const ndc = new THREE.Vector2(((lx - this.x) / this.size) * 2 - 1, -(((ly - this.y) / this.size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    const p = hit.point;
    const face = hit.face ? FACES.findIndex((f) => f.n.dot(hit.face!.normal) > 0.9) : -1;
    const near = (v: number) => (Math.abs(v) > 0.36 ? Math.sign(v) : 0);
    const dir = new THREE.Vector3(near(p.x), near(p.y), near(p.z));
    if (dir.lengthSq() < 2 && face >= 0) dir.copy(FACES[face].n); // not near an edge/corner: the face itself
    return { dir: dir.normalize(), face };
  }

  setHot(face: number) {
    if (face === this.hot) return;
    if (this.hot >= 0) this.mats[this.hot].map = this.texNormal[this.hot];
    this.hot = face;
    if (face >= 0) this.mats[face].map = this.texHot[face];
  }

  /** Draw into the corner of the current canvas (call right after the main render). */
  render(renderer: THREE.WebGLRenderer, canvasW: number, canvasH: number) {
    if (!this.visible) return;
    const yb = canvasH - this.y - this.size;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setViewport(this.x, yb, this.size, this.size);
    renderer.setScissor(this.x, yb, this.size, this.size);
    renderer.setScissorTest(true);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvasW, canvasH);
    renderer.autoClear = autoClear;
  }

  dispose() {
    this.cube.geometry.dispose();
    this.edges.geometry.dispose();
    (this.edges.material as THREE.Material).dispose();
    this.disc.geometry.dispose();
    (this.disc.material as THREE.Material).dispose();
    for (const m of this.mats) m.dispose();
    for (const t of [...this.texNormal, ...this.texHot]) t.dispose();
  }
}
