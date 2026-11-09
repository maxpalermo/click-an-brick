// Offscreen part thumbnails: one small shared WebGLRenderer, requests rendered sequentially,
// results cached as PNG data URLs.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EDGE_LAYER, type PartLibrary } from './parts';
import { ldToThreeBox } from './math';

export class Thumbnailer {
  private renderer: THREE.WebGLRenderer | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private scene = new THREE.Scene();
  private root = new THREE.Group();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private cache = new Map<string, string>();
  private inflight = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private lib: PartLibrary) {
    this.root.rotation.x = Math.PI;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d96a0, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 800, 500);
    this.scene.add(sun);
    this.camera.layers.enable(EDGE_LAYER);
  }

  render(partId: string, color: number, size = 96): Promise<string> {
    const key = `${partId.toLowerCase()}|${color}|${size}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.lib.get(partId, false).then((tpl) => {
      if (tpl.missing) throw new Error(`Unknown part ${partId}`);
      const job = this.queue.then(() => this.renderNow(tpl, color, size));
      this.queue = job.catch(() => undefined);
      return job;
    }).then((url) => {
      this.cache.set(key, url);
      return url;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private ensureRenderer(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0);
    const pmrem = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.envRT = pmrem.fromScene(room, 0.04);
    (room as unknown as { dispose?: () => void }).dispose?.();
    pmrem.dispose();
    this.scene.environment = this.envRT.texture;
    this.renderer = r;
    return r;
  }

  private renderNow(tpl: Parameters<PartLibrary['instantiate']>[0], color: number, size: number): string {
    if (this.disposed) throw new Error('engine disposed');
    const r = this.ensureRenderer();
    r.setSize(size, size, false);
    const built = this.lib.instantiate(tpl, color, 'normal', false);
    this.root.add(built.group);
    this.root.updateMatrixWorld(true);

    const box = ldToThreeBox(tpl.box);
    const centre = box.getCenter(new THREE.Vector3());
    const dir = new THREE.Vector3(1, 0.85, 1.25).normalize();
    const cam = this.camera;
    cam.position.copy(centre).addScaledVector(dir, 1500);
    cam.up.set(0, 1, 0);
    cam.lookAt(centre);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    let ext = 1;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
      ext = Math.max(ext, Math.abs(v.x), Math.abs(v.y));
    }
    ext *= 1.08;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1; cam.far = 4000;
    cam.updateProjectionMatrix();

    r.render(this.scene, cam);
    const url = r.domElement.toDataURL('image/png');
    this.root.remove(built.group);
    return url;
  }

  dispose() {
    this.disposed = true;
    this.cache.clear();
    this.envRT?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }
}
