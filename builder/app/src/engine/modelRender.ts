// Off-screen render of a whole brick list (not the editor model) with real part geometry, used by the
// photo result preview. Own small WebGLRenderer (created lazily, released after a short idle time),
// parts come from the shared PartLibrary cache. Face nodes are drawn as one InstancedMesh per
// (part, colour, node); edge lines are merged per material into a few LineSegments, so ~1000 bricks
// cost a few hundred draw calls. Calls are serialised.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { PartLibrary, PartTemplate, TemplateNode } from './parts';
import { mat4From } from './math';
import type { Mat3, Vec3 } from '../model/types';

export interface RenderBrick {
  part: string;
  color: number;
  pos: [number, number, number];
  rot: number[];
}

export interface RenderModelOptions {
  width?: number;
  height?: number;
  /** Turn around the model; 0 = front 3/4 view, 90 = right side, … */
  yawDeg?: number;
  /** Camera height angle above the horizon. */
  elevationDeg?: number;
}

/** Azimuth offset of the "front" 3/4 view (towards the model's right). */
const FRONT_34_DEG = 32;
const IDLE_RELEASE_MS = 20000;
const MAX_SIZE = 2048;

export class ModelRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private sun = new THREE.DirectionalLight(0xffffff, 1.25);
  private shadowPlane: THREE.Mesh;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Edge line positions per template node, in part-local space (node matrix applied). */
  private edgeCache = new WeakMap<TemplateNode, Float32Array>();
  private disposed = false;
  /** Timing of the last render (ms): parts = loading templates, render = build + draw + encode. */
  lastTiming = { parts: 0, render: 0, total: 0, bricks: 0, drawCalls: 0 };

  constructor(private lib: PartLibrary) {
    this.root.rotation.x = Math.PI; // LDraw (-Y up) → three (+Y up)
    this.root.matrixAutoUpdate = true;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b0, 0.55));
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-600, 300, -400);
    this.scene.add(fill);
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.8;
    sun.shadow.radius = 4;
    this.scene.add(sun, sun.target);
    this.shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.16 }),
    );
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);
  }

  render(bricks: ReadonlyArray<RenderBrick>, opts: RenderModelOptions = {}): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('engine disposed'));
    const job = this.queue.then(() => this.renderNow(bricks, opts));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.envRT = pmrem.fromScene(room, 0.04);
    (room as unknown as { dispose?: () => void }).dispose?.();
    pmrem.dispose();
    this.scene.environment = this.envRT.texture;
    this.renderer = r;
    return r;
  }

  /** Free the WebGL context when no preview has been rendered for a while (phones have few contexts). */
  private scheduleRelease() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.releaseRenderer();
    }, IDLE_RELEASE_MS);
  }

  private releaseRenderer() {
    this.scene.environment = null;
    this.envRT?.dispose();
    this.envRT = null;
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  private edgePositions(tn: TemplateNode): Float32Array {
    let out = this.edgeCache.get(tn);
    if (out) return out;
    const g = tn.src.geometry;
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos ? pos.count : 0;
    out = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, idx ? idx.getX(i) : i).applyMatrix4(tn.matrix);
      out[i * 3] = v.x;
      out[i * 3 + 1] = v.y;
      out[i * 3 + 2] = v.z;
    }
    this.edgeCache.set(tn, out);
    return out;
  }

  private async renderNow(bricks: ReadonlyArray<RenderBrick>, opts: RenderModelOptions): Promise<string> {
    if (this.disposed) throw new Error('engine disposed');
    const t0 = performance.now();
    const ids = [...new Set(bricks.map((b) => b.part.toLowerCase()))];
    const tpls = new Map<string, PartTemplate>();
    await Promise.all(ids.map(async (id) => {
      tpls.set(id, await this.lib.get(id, false));
    }));
    if (this.disposed) throw new Error('engine disposed');
    const t1 = performance.now();

    const W = Math.max(16, Math.min(MAX_SIZE, Math.round(opts.width ?? 512)));
    const H = Math.max(16, Math.min(MAX_SIZE, Math.round(opts.height ?? 512)));
    const yaw = THREE.MathUtils.degToRad((opts.yawDeg ?? 0) + FRONT_34_DEG);
    const elev = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(opts.elevationDeg ?? 26, -80, 89));

    // ---- group bricks by (part, colour), compute brick matrices and the tight world box
    const groups = new Map<string, { tpl: PartTemplate; color: number; mats: THREE.Matrix4[] }>();
    const corners: THREE.Vector3[] = [];
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    for (const b of bricks) {
      const tpl = tpls.get(b.part.toLowerCase());
      if (!tpl) continue;
      const m = mat4From(b.rot as unknown as Mat3, b.pos as unknown as Vec3);
      const key = `${tpl.id.toLowerCase()}|${b.color}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { tpl, color: b.color, mats: [] }));
      g.mats.push(m);
      const tb = tpl.box;
      for (let i = 0; i < 8; i++) {
        c.set(i & 1 ? tb.max.x : tb.min.x, i & 2 ? tb.max.y : tb.min.y, i & 4 ? tb.max.z : tb.min.z).applyMatrix4(m);
        c.set(c.x, -c.y, -c.z); // LDraw → three (root is rotated π around X)
        corners.push(c.clone());
        box.expandByPoint(c);
      }
    }
    if (box.isEmpty()) throw new Error('nothing to render');

    // ---- build instanced faces + merged edges
    const created: Array<THREE.InstancedMesh | THREE.LineSegments> = [];
    const edgeBuckets = new Map<THREE.Material, Array<{ arr: Float32Array; m: THREE.Matrix4 }>>();
    const tmp = new THREE.Matrix4();
    for (const g of groups.values()) {
      for (const tn of g.tpl.nodes) {
        if (tn.kind === 'cond') continue;
        const mats = this.lib.nodeMaterials(tn, g.color);
        if (tn.kind === 'face') {
          const mesh = new THREE.InstancedMesh(tn.src.geometry, tn.isArray ? mats : mats[0], g.mats.length);
          for (let i = 0; i < g.mats.length; i++) mesh.setMatrixAt(i, tmp.multiplyMatrices(g.mats[i], tn.matrix));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.frustumCulled = false;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          if (mats.some((mm) => mm.transparent)) mesh.renderOrder = 1;
          this.root.add(mesh);
          created.push(mesh);
        } else {
          const arr = this.edgePositions(tn);
          if (!arr.length) continue;
          let list = edgeBuckets.get(mats[0]);
          if (!list) edgeBuckets.set(mats[0], (list = []));
          for (const m of g.mats) list.push({ arr, m });
        }
      }
    }
    for (const [mat, list] of edgeBuckets) {
      let total = 0;
      for (const it of list) total += it.arr.length;
      const out = new Float32Array(total);
      let o = 0;
      for (const { arr, m } of list) {
        const e = m.elements;
        for (let i = 0; i < arr.length; i += 3) {
          const x = arr[i], y = arr[i + 1], z = arr[i + 2];
          out[o++] = e[0] * x + e[4] * y + e[8] * z + e[12];
          out[o++] = e[1] * x + e[5] * y + e[9] * z + e[13];
          out[o++] = e[2] * x + e[6] * y + e[10] * z + e[14];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      this.root.add(lines);
      created.push(lines);
    }

    try {
      const r = this.ensureRenderer();
      r.setSize(W, H, false);
      this.root.updateMatrixWorld(true);

      // ---- camera: orthographic, framed tightly on the projected brick boxes
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(20, size.length() / 2);
      const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(elev), Math.sin(elev), Math.cos(yaw) * Math.cos(elev));
      const cam = this.camera;
      cam.position.copy(centre).addScaledVector(dir, radius * 4);
      cam.up.set(0, 1, 0);
      cam.lookAt(centre);
      cam.updateMatrixWorld(true);
      const inv = cam.matrixWorldInverse;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      const v = new THREE.Vector3();
      for (const p of corners) {
        v.copy(p).applyMatrix4(inv);
        if (v.x < x0) x0 = v.x;
        if (v.x > x1) x1 = v.x;
        if (v.y < y0) y0 = v.y;
        if (v.y > y1) y1 = v.y;
        if (v.z < z0) z0 = v.z;
        if (v.z > z1) z1 = v.z;
      }
      const pad = 0.07;
      let hw = ((x1 - x0) / 2) * (1 + 2 * pad);
      let hh = ((y1 - y0) / 2) * (1 + 2 * pad);
      const aspect = W / H;
      if (hw / hh > aspect) hh = hw / aspect;
      else hw = hh * aspect;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      cam.left = cx - hw; cam.right = cx + hw; cam.top = cy + hh; cam.bottom = cy - hh;
      cam.near = Math.max(0.1, -z1 - radius);
      cam.far = -z0 + radius * 2;
      cam.updateProjectionMatrix();

      // ---- soft ground shadow under the model; key light from the camera's upper left
      const ground = box.min.y - 0.4;
      this.shadowPlane.position.set(centre.x, ground, centre.z);
      this.shadowPlane.scale.set(radius * 8, 1, radius * 8);
      const sunDir = new THREE.Vector3(Math.sin(yaw - 0.7), 1.6, Math.cos(yaw - 0.7)).normalize();
      this.sun.position.copy(centre).addScaledVector(sunDir, radius * 3);
      this.sun.target.position.copy(centre);
      this.sun.target.updateMatrixWorld();
      const sc = this.sun.shadow.camera;
      sc.left = -radius * 1.4; sc.right = radius * 1.4; sc.top = radius * 1.4; sc.bottom = -radius * 1.4;
      sc.near = radius * 0.5; sc.far = radius * 6;
      sc.updateProjectionMatrix();
      this.sun.shadow.needsUpdate = true;

      r.render(this.scene, cam);
      const url = r.domElement.toDataURL('image/png');
      const t2 = performance.now();
      this.lastTiming = {
        parts: Math.round(t1 - t0), render: Math.round(t2 - t1), total: Math.round(t2 - t0),
        bricks: bricks.length, drawCalls: r.info.render.calls,
      };
      return url;
    } finally {
      for (const o of created) {
        this.root.remove(o);
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); // geometry is shared
        else o.geometry.dispose();
      }
      // free the shadow map; it is re-created at the next render
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      if (!this.disposed) this.scheduleRelease();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.releaseRenderer();
    this.shadowPlane.geometry.dispose();
    (this.shadowPlane.material as THREE.Material).dispose();
  }
}
