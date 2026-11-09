// Brickyard render engine: plain three.js scene kept in sync with the zustand editor store.
// All model data is LDU in LDraw axes (-Y up); the `root` group is rotated π around X.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { BrickyardEngine, EngineFeedback, EngineOptions, PendingState } from './types';
import type { Brick, Mat3, Vec3, ViewMode } from '../model/types';
import { useEditor } from '../model/store';
import { newId } from '../model/id';
import { Outline, type OutlineSet } from './outline';
import { ViewCube } from './viewcube';
import { Footprint, type FootRect } from './footprint';
import { EDGE_LAYER, PartLibrary, type BuiltPart, type Look, type PartTemplate } from './parts';
import { Thumbnailer } from './thumbs';
import { ModelRenderer } from './modelRender';
import { CONE_LEN, Gizmo, type HandleId } from './gizmo';
import {
  applyMat3, clean, gridShift, headingDeg, isAxisAligned, ldToThreeBox, mat4From, mulMat3, normRot, rotY90, rotYDeg,
  snapAxis, solidOf, solidsOverlap, toLDraw, type Solid,
} from './math';

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const CLICK_PX = 5;
/** Finger taps wiggle far more than a mouse click — beyond this it is an orbit/drag, not a tap. */
const TOUCH_TAP_PX = 24;
const ORTHO_HALF = 240;
const BASE_STUDS = 48;
const BASE_SIZE = BASE_STUDS * 20;
const CAM_2D_HEIGHT = 5000;

interface Entry {
  brick: Brick;
  built: BuiltPart | null;
  tpl: PartTemplate | null;
  /** World body box (LDraw coords, root-local), null until geometry is loaded. */
  body: THREE.Box3 | null;
  /** Collision shape (AABB + oriented footprint when rotated off-grid). */
  solid: Solid | null;
  look: Look | 'hidden' | null;
}

interface Hit {
  id: string;
  entry: Entry;
  point: THREE.Vector3; // three world
  normal: THREE.Vector3; // three world
}

interface Press {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
  shift: boolean;
  /** select tool: shift-click on an already selected brick → deselect it on release. */
  toggleOff: string | null;
  /** A long-press selected a brick: ignore the rest of this gesture. */
  longPressed?: boolean;
}

interface Drag {
  ids: string[];
  idSet: Set<string>;
  planeY: number; // three world Y of the drag plane
  start: THREE.Vector3; // LDraw
  dx: number;
  dz: number;
  active: boolean;
  blocked: boolean;
}

/** A brick-like thing the gizmo manipulates: the pending brick (id null) or a model brick. */
interface Item {
  id: string | null;
  tpl: PartTemplate;
  pos: Vec3;
  rot: Mat3;
}

interface HandleDrag {
  pointerId: number;
  handle: HandleId;
  kind: 'pending' | 'selection';
  base: Item[];
  preview: Item[];
  idSet: Set<string>;
  /** Axis handles: line origin / unit direction in three world space, start parameter. */
  origin: THREE.Vector3;
  dirW: THREE.Vector3 | null;
  t0: number;
  /** Ring: last screen angle and the unwrapped total. */
  angle: number;
  total: number;
  key: string;
  x: number;
  y: number;
  moved: boolean;
  blocked: boolean;
  changed: boolean;
}

interface GizmoInfo {
  center: THREE.Vector3;
  centerS: { x: number; y: number } | null;
  /** Base plane centre (three world): horizontal cones, the ring and the knob live here. */
  base: THREE.Vector3;
  baseS: { x: number; y: number } | null;
  arrows: Array<{ id: HandleId; dir: THREE.Vector3; origin: THREE.Vector3; a: { x: number; y: number }; b: { x: number; y: number } }>;
  knob: { x: number; y: number } | null;
}

const ARROW_HIT_PX = 24; // radius of the cone hit area (48 px)
const KNOB_HIT_PX = 26; // ring knob hit area (52 px); the ring itself is not grabbable

const sameVec = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);

function distToSeg(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? THREE.MathUtils.clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

export function createEngine(opts: EngineOptions): BrickyardEngine {
  const apiBase = (opts.apiBase ?? '').replace(/\/+$/, '');
  const lib = new PartLibrary(apiBase, opts.colors ?? []);
  const thumbs = new Thumbnailer(lib);
  const modelRenderer = new ModelRenderer(lib);
  const get = useEditor.getState;

  // ------------------------------------------------------------------ renderer & scene
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });

  const scene = new THREE.Scene();
  scene.background = null; // host element provides the background (transparent canvas)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  (room as unknown as { dispose?: () => void }).dispose?.();
  scene.environment = envRT.texture;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa4b0, 0.35);
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 3;
  scene.add(hemi, sun, sun.target);

  // Baseplate-like ground at Y = 0 with a stud grid (lines every 20 LDU).
  const owned: Array<{ dispose(): void }> = [];
  const baseGeo = new THREE.PlaneGeometry(BASE_SIZE, BASE_SIZE).rotateX(-Math.PI / 2);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0xd5dbe2, roughness: 0.92, metalness: 0 });
  const baseplate = new THREE.Mesh(baseGeo, baseMat);
  baseplate.position.y = -0.3;
  baseplate.receiveShadow = true;
  const grid = new THREE.GridHelper(BASE_SIZE, BASE_STUDS, 0x9aa6b3, 0xb4bec9);
  grid.position.y = 0.05;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.75;
  const shadowGeo = new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.12 });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.position.y = -0.6;
  shadowPlane.receiveShadow = true;
  const layerGrid = new THREE.GridHelper(BASE_SIZE * 2, BASE_STUDS * 2, 0x3b82f6, 0x8ea2bb);
  (layerGrid.material as THREE.Material).transparent = true;
  (layerGrid.material as THREE.Material).opacity = 0.55;
  (layerGrid.material as THREE.Material).depthWrite = false;
  layerGrid.renderOrder = 2;
  layerGrid.visible = false;
  scene.add(shadowPlane, baseplate, grid, layerGrid);
  owned.push(baseGeo, baseMat, shadowGeo, shadowMat, grid.geometry, grid.material as THREE.Material,
    layerGrid.geometry, layerGrid.material as THREE.Material, envRT, pmrem);

  const root = new THREE.Group();
  root.rotation.x = Math.PI; // LDraw (-Y up) → three (+Y up)
  scene.add(root);
  const bricksGroup = new THREE.Group();
  root.add(bricksGroup);
  const helpers = new THREE.Group();
  helpers.renderOrder = 40; // overlays (selection boxes, gizmo) sort after the transparent ghost
  scene.add(helpers);

  // ------------------------------------------------------------------ cameras & controls
  const persp = new THREE.PerspectiveCamera(40, 1, 1, 30000);
  persp.layers.enable(EDGE_LAYER);
  const ortho = new THREE.OrthographicCamera(-ORTHO_HALF, ORTHO_HALF, ORTHO_HALF, -ORTHO_HALF, 1, 30000);
  ortho.up.set(0, 0, -1); // screen-up = away from the "front" (three -Z)
  ortho.layers.enable(EDGE_LAYER);
  ortho.position.set(0, CAM_2D_HEIGHT, 0);
  ortho.lookAt(0, 0, 0);

  // Our pointer listeners must be registered BEFORE OrbitControls so we can disable them
  // for a brick drag before they see the pointerdown.
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);

  const controls3d = new OrbitControls(persp, canvas);
  controls3d.enableDamping = true;
  controls3d.dampingFactor = 0.12;
  controls3d.minDistance = 50; // can't zoom inside a brick
  controls3d.maxDistance = 9000;
  controls3d.maxPolarAngle = Math.PI * 0.495;
  controls3d.zoomToCursor = true;
  controls3d.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  const controls2d = new OrbitControls(ortho, canvas);
  controls2d.enableRotate = false;
  controls2d.enableDamping = true;
  controls2d.dampingFactor = 0.15;
  controls2d.screenSpacePanning = true;
  controls2d.zoomToCursor = true;
  controls2d.minZoom = 0.1;
  controls2d.maxZoom = 30;
  controls2d.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls2d.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  controls2d.enabled = false;

  const markDirty = () => { dirty = true; };
  controls3d.addEventListener('change', markDirty);
  controls2d.addEventListener('change', markDirty);

  // ------------------------------------------------------------------ state
  const entries = new Map<string, Entry>();
  let selectionSet = new Set<string>();
  let viewMode: ViewMode = '3d';
  let dirty = true;
  let raf = 0;
  let disposed = false;
  let container: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;
  let fitPending = false;
  let unsub: (() => void) | null = null;

  // ghost (place tool)
  let ghost: { part: string; color: number; tpl: PartTemplate; built: BuiltPart; look: Look } | null = null;
  let ghostReq = 0;
  let ghostRot: Mat3 = IDENTITY;
  let ghostPlacement: { pos: Vec3; valid: boolean } | null = null;

  // two-step placement + gizmo
  let pending: { pos: Vec3; rot: Mat3; blocked: boolean } | null = null;
  let handleDrag: HandleDrag | null = null;
  let hotHandle: HandleId | null = null;
  let gizmoInfo: GizmoInfo | null = null;
  let lastPendingKey = 'false|false|undefined|0';
  const pendingListeners = new Set<(s: PendingState) => void>();
  const blockedListeners = new Set<() => void>();
  let shakeUntil = 0;
  const gizmo = new Gizmo();
  gizmo.group.visible = false;
  helpers.add(gizmo.group);
  const angleLabel = document.createElement('div');
  Object.assign(angleLabel.style, {
    position: 'fixed', display: 'none', pointerEvents: 'none', zIndex: '30', transform: 'translate(-50%, -100%)',
    padding: '3px 9px', borderRadius: '999px', background: 'rgba(17, 24, 39, 0.85)', color: '#fff',
    font: '800 14px/1.3 system-ui, sans-serif', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);
  function showAngleLabel(text: string, x: number, y: number) {
    angleLabel.textContent = text;
    angleLabel.style.left = `${x}px`;
    angleLabel.style.top = `${y - 44}px`;
    angleLabel.style.display = 'block';
  }
  owned.push(gizmo);

  // duplicate-as-pending (several bricks at once, any tool)
  interface DupPiece { part: string; color: number; tpl: PartTemplate; built: BuiltPart; look: Look }
  let dup: { pieces: DupPiece[]; items: Item[]; src: Item[]; blocked: boolean } | null = null;
  let lastDup: { ids: string[]; offset: Vec3 } | null = null;

  // feedback (haptics are owned by the UI)
  const feedbackListeners = new Set<(e: EngineFeedback) => void>();
  function emit(e: EngineFeedback) {
    for (const cb of feedbackListeners) cb(e);
  }
  let lastStepAt = 0;
  function emitStep() {
    const now = performance.now();
    if (now - lastStepAt < 40) return;
    lastStepAt = now;
    emit({ type: 'step' });
  }
  let floating = false;

  // overlays
  const outline = new Outline();
  const viewCube = new ViewCube();
  const footprint = new Footprint();
  scene.add(footprint.group);
  owned.push(outline, viewCube, footprint);
  let footKey = '';
  let insets = { top: 0, bottom: 0, left: 0, right: 0 };
  let addMode = false;
  /** Scale "pop" animations: model bricks (id) or the pending ghost (id null). */
  const pops: Array<{ id: string | null; from: number; t0: number; dur: number }> = [];
  /** Just-placed bricks: soft outline fading over 600 ms. */
  let recent: { ids: string[]; t0: number } | null = null;
  const RECENT_MS = 600;

  // pointer
  const pointers = new Set<number>();
  let press: Press | null = null;
  let drag: Drag | null = null;
  let hoverXY: { x: number; y: number } | null = null;
  let hoverDirty = false;
  let hoverEraseId: string | null = null;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const loadingListeners = new Set<(n: number) => void>();

  const activeCamera = (): THREE.Camera => (viewMode === '2d' ? ortho : persp);
  const setControlsEnabled = (on: boolean) => {
    controls3d.enabled = on && viewMode === '3d';
    controls2d.enabled = on && viewMode === '2d';
  };

  lib.onPending((n) => {
    for (const cb of loadingListeners) cb(n);
    if (n === 0 && fitPending) {
      fitPending = false;
      zoomToFit();
    }
  });

  // ------------------------------------------------------------------ model sync
  function brickMatrix(b: Brick, out: THREE.Matrix4) {
    return mat4From(b.rot, b.pos, out);
  }

  function applyTransform(e: Entry) {
    if (!e.built || !e.tpl) return;
    brickMatrix(e.brick, e.built.group.matrix);
    e.built.group.matrixWorldNeedsUpdate = true;
    e.solid = solidOf(e.tpl.body, e.brick.rot, e.brick.pos);
    e.body = e.solid.box;
  }

  function buildEntry(id: string, e: Entry, tpl: PartTemplate) {
    e.tpl = tpl;
    e.built = lib.instantiate(tpl, e.brick.color);
    e.built.group.userData.brickId = id;
    e.look = 'normal';
    bricksGroup.add(e.built.group);
    applyTransform(e);
  }

  function ensureObject(id: string, e: Entry) {
    const part = e.brick.part;
    const cached = lib.peek(part);
    if (cached) {
      buildEntry(id, e, cached);
      return;
    }
    lib.get(part).then((tpl) => {
      if (disposed || entries.get(id) !== e || e.brick.part !== part || e.built) return;
      buildEntry(id, e, tpl);
      refreshLooks();
      updateSelectionHelpers();
      updateShadowBounds();
      hoverDirty = true;
      dirty = true;
    });
  }

  function destroyObject(e: Entry) {
    if (e.built) bricksGroup.remove(e.built.group);
    e.built = null;
    e.tpl = null;
    e.body = null;
    e.solid = null;
    e.look = null;
  }

  function syncModel(bricks: Brick[]) {
    const prevCount = entries.size;
    let overlap = 0;
    const seen = new Set<string>();
    for (const b of bricks) {
      seen.add(b.id);
      const e = entries.get(b.id);
      if (!e) {
        const ne: Entry = { brick: b, built: null, tpl: null, body: null, solid: null, look: null };
        entries.set(b.id, ne);
        ensureObject(b.id, ne);
        continue;
      }
      overlap++;
      if (e.brick === b) continue;
      const prev = e.brick;
      e.brick = b;
      if (prev.part.toLowerCase() !== b.part.toLowerCase()) {
        destroyObject(e);
        ensureObject(b.id, e);
        continue;
      }
      if (prev.color !== b.color && e.built) lib.recolor(e.built.nodes, b.color, e.look === 'hidden' || !e.look ? 'normal' : e.look);
      if (!sameVec(prev.pos, b.pos) || !sameVec(prev.rot, b.rot)) applyTransform(e);
    }
    for (const [id, e] of entries) {
      if (!seen.has(id)) {
        destroyObject(e);
        entries.delete(id);
      }
    }
    // A whole new model (load / import / shared link): frame it once its parts are loaded.
    if (bricks.length > 1 && (prevCount === 0 || overlap === 0)) fitPending = true;
    if (fitPending && lib.pendingCount === 0) {
      fitPending = false;
      zoomToFit();
    }
    refreshLooks();
    updateSelectionHelpers();
    updateShadowBounds();
    modelVersion++;
    if (pending) showPending(); // re-check overlap (undo / redo / other edits)
    if (dup) showDup();
    hoverDirty = true;
    dirty = true;
  }

  // ------------------------------------------------------------------ looks (selection, 2D layers)
  function desiredLook(id: string, e: Entry): Look | 'hidden' {
    if (drag?.active && drag.idSet.has(id)) return drag.blocked ? 'blocked' : 'selected';
    if (handleDrag?.kind === 'selection' && handleDrag.idSet.has(id)) return handleDrag.blocked ? 'blocked' : 'selected';
    if (hoverEraseId === id) return 'blocked';
    let layer: Look = 'normal';
    if (viewMode === '2d' && e.body) {
      const ly = get().layerY;
      if (e.body.max.y <= ly - 0.5) return 'hidden'; // entirely above the layer
      if (e.body.min.y >= ly - 0.5) layer = 'faded'; // entirely below the layer
    }
    if (selectionSet.has(id)) return 'selected';
    return layer;
  }

  function refreshLook(id: string, e: Entry, force = false) {
    if (!e.built) return;
    const look = desiredLook(id, e);
    if (!force && look === e.look) return;
    e.look = look;
    e.built.group.visible = look !== 'hidden';
    if (look !== 'hidden') lib.applyLook(e.built.nodes, look);
    dirty = true;
  }

  function refreshLooks() {
    for (const [id, e] of entries) refreshLook(id, e);
  }

  /** Selection is drawn as a screen-space outline at render time (outline.ts); just repaint. */
  function updateSelectionHelpers() {
    dirty = true;
  }

  function updateShadowBounds() {
    const sphere = modelBoxThree().getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 300) + 40;
    sun.target.position.copy(sphere.center);
    sun.position.copy(sphere.center).add(new THREE.Vector3(0.45, 1, 0.6).normalize().multiplyScalar(r * 2 + 400));
    const cam = sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 1; cam.far = r * 4 + 1200;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  function modelBoxThree(): THREE.Box3 {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const e of entries.values()) if (e.body) box.union(ldToThreeBox(e.body, tmp));
    if (box.isEmpty()) box.set(new THREE.Vector3(-100, 0, -100), new THREE.Vector3(100, 48, 100));
    return box;
  }

  // ------------------------------------------------------------------ view mode
  function positionLayerGrid() {
    layerGrid.position.y = -get().layerY + 0.1;
  }

  function applyViewMode(mode: ViewMode) {
    cancelCamAnim();
    viewMode = mode;
    layoutCube();
    setControlsEnabled(!press);
    layerGrid.visible = mode === '2d';
    grid.visible = mode === '3d';
    if (mode === '2d') {
      const t = controls3d.target;
      ortho.position.set(t.x, CAM_2D_HEIGHT, t.z);
      controls2d.target.set(t.x, 0, t.z);
      ortho.lookAt(controls2d.target);
      controls2d.update();
      positionLayerGrid();
    }
    canvas.style.cursor = '';
    refreshLooks();
    updateSelectionHelpers();
    hoverDirty = true;
    dirty = true;
  }

  function setAspect(aspect: number) {
    persp.aspect = aspect;
    persp.updateProjectionMatrix();
    ortho.left = -ORTHO_HALF * aspect;
    ortho.right = ORTHO_HALF * aspect;
    ortho.top = ORTHO_HALF;
    ortho.bottom = -ORTHO_HALF;
    ortho.updateProjectionMatrix();
  }

  function resize() {
    if (!container) return;
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    setAspect(w / h);
    outline.setSize(w, h);
    layoutCube();
    dirty = true;
  }

  // ------------------------------------------------------------------ picking helpers
  function setRay(x: number, y: number) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / Math.max(1, r.width)) * 2 - 1, -((y - r.top) / Math.max(1, r.height)) * 2 + 1);
    raycaster.setFromCamera(ndc, activeCamera());
  }

  /** Intersect the current ray with the horizontal plane at LDraw Y = yL; returns an LDraw point. */
  function rayToLDrawPlane(yL: number): THREE.Vector3 | null {
    const p = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), yL), new THREE.Vector3());
    return p ? toLDraw(p) : null;
  }

  function rayToThreePlane(y: number): THREE.Vector3 | null {
    return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  }

  /** Pick the brick under (x, y); expects setRay not yet called. */
  function pickBrick(x: number, y: number): Hit | null {
    setRay(x, y);
    root.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(bricksGroup.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && o.userData.brickId === undefined) o = o.parent;
      if (!o) continue;
      const id = o.userData.brickId as string;
      const e = entries.get(id);
      if (!e || !e.built || e.look === 'hidden') continue;
      if (viewMode === '2d' && e.look === 'faded') continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      return { id, entry: e, point: h.point.clone(), normal };
    }
    return null;
  }

  function collides(s: Solid, ignore?: Set<string>): boolean {
    if (s.box.max.y > 0.5) return true; // below the ground
    for (const [id, e] of entries) {
      if (!e.solid || ignore?.has(id)) continue;
      if (solidsOverlap(s, e.solid)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ ghost (place tool)
  function removeGhost() {
    ghostReq++;
    if (handleDrag?.kind === 'pending') endHandleDrag(false);
    if (ghost) root.remove(ghost.built.group);
    ghost = null;
    ghostPlacement = null;
    if (pending) {
      pending = null;
      emitPending();
    }
    dirty = true;
  }

  function updateGhostObject() {
    const st = get();
    if (st.readOnly || st.tool !== 'place' || !st.activePart) {
      removeGhost();
      return;
    }
    const part = st.activePart;
    if (ghost && ghost.part === part) {
      if (ghost.color !== st.activeColor) {
        ghost.color = st.activeColor;
        lib.recolor(ghost.built.nodes, ghost.color, ghost.look);
        dirty = true;
      }
      return;
    }
    removeGhost();
    const req = ghostReq;
    lib.get(part).then((tpl) => {
      if (disposed || req !== ghostReq) return;
      const color = get().activeColor;
      const built = lib.instantiate(tpl, color, 'ghost', false);
      built.group.visible = false;
      built.group.renderOrder = 5;
      built.group.traverse((o) => { o.renderOrder = 5; });
      root.add(built.group);
      ghost = { part, color, tpl, built, look: 'ghost' };
      if (color !== get().activeColor) updateGhostObject();
      hoverDirty = true;
      dirty = true;
    });
  }

  function computePlacement(x: number, y: number, rot: Mat3 = ghostRot): { pos: Vec3; valid: boolean } | null {
    if (!ghost) return null;
    const g = ghost.tpl.body.clone().applyMatrix4(mat4From(rot, [0, 0, 0], new THREE.Matrix4()));
    const pos = placementFor(x, y, g, isAxisAligned(rot));
    return pos ? { pos, valid: !collides(solidOf(ghost.tpl.body, rot, pos)) } : null;
  }

  /**
   * Where should something with origin-relative body box `g` (LDraw) go for a tap at (x, y)?
   * Stacks on the tapped brick's top, sits beside a tapped side face, else lands on the ground /
   * the 2D layer. Returns the snapped origin, or null when the tap hits nothing (sky).
   */
  function placementFor(x: number, y: number, g: THREE.Box3, aligned: boolean): Vec3 | null {
    const st = get();
    let px: number;
    let pz: number;
    let bottom: number;
    let fixedX: number | null = null;
    let fixedZ: number | null = null;

    if (viewMode === '2d') {
      setRay(x, y);
      const p = rayToLDrawPlane(st.layerY);
      if (!p) return null;
      px = p.x; pz = p.z; bottom = st.layerY;
    } else {
      const hit = pickBrick(x, y); // also sets the ray
      if (hit && hit.entry.body) {
        const b = hit.entry.body;
        const p = toLDraw(hit.point);
        const n = toLDraw(hit.normal);
        if (p.y <= b.min.y + 0.5 || n.y < -0.5 || Math.abs(n.y) >= 0.5) {
          // top face / studs (or underside): stack on top of the brick
          px = p.x; pz = p.z; bottom = b.min.y;
        } else {
          // side face: place adjacent, same bottom level as the hit brick
          bottom = b.max.y;
          px = p.x; pz = p.z;
          if (Math.abs(n.x) >= Math.abs(n.z)) {
            fixedX = n.x > 0 ? b.max.x - g.min.x : b.min.x - g.max.x;
          } else {
            fixedZ = n.z > 0 ? b.max.z - g.min.z : b.min.z - g.max.z;
          }
        }
      } else {
        const p = rayToLDrawPlane(0);
        if (!p) return null;
        px = p.x; pz = p.z; bottom = 0;
      }
    }
    // Off-grid rotations: the pivot (brick origin) snaps to the stud grid, centred on the pointer.
    const snapOrigin = (v: number, min: number, max: number) => clean(Math.round((v - (min + max) / 2) / 20) * 20);
    return [
      fixedX !== null ? clean(fixedX) : aligned ? snapAxis(px, g.min.x, g.max.x) : snapOrigin(px, g.min.x, g.max.x),
      clean(bottom - g.max.y),
      fixedZ !== null ? clean(fixedZ) : aligned ? snapAxis(pz, g.min.z, g.max.z) : snapOrigin(pz, g.min.z, g.max.z),
    ];
  }

  /** Hide the hover ghost — unless it is currently the pending brick. */
  function hideHoverGhost() {
    if (pending || !ghost?.built.group.visible) return;
    ghost.built.group.visible = false;
    dirty = true;
  }

  function placeGhostAt(x: number, y: number) {
    if (!ghost || pending) return;
    ghostPlacement = computePlacement(x, y);
    const grp = ghost.built.group;
    if (!ghostPlacement) {
      grp.visible = false;
    } else {
      mat4From(ghostRot, ghostPlacement.pos, grp.matrix);
      grp.matrixWorldNeedsUpdate = true;
      grp.visible = true;
      const look: Look = ghostPlacement.valid ? 'ghost' : 'blocked';
      if (look !== ghost.look) {
        ghost.look = look;
        lib.applyLook(ghost.built.nodes, look);
      }
    }
    dirty = true;
  }

  // ------------------------------------------------------------------ items (pending brick / selection)
  const itemBox = (it: Item) => it.tpl.body.clone().applyMatrix4(mat4From(it.rot, it.pos, new THREE.Matrix4()));

  function translateItems(items: Item[], d: Vec3): Item[] {
    return items.map((it) => ({
      ...it, pos: [clean(it.pos[0] + d[0]), clean(it.pos[1] + d[1]), clean(it.pos[2] + d[2])] as Vec3,
    }));
  }

  /**
   * Rotate items by R around the vertical axis. A single brick that ends up off-grid (e.g. 35°)
   * pivots on its own origin, which stays on the stud grid. Otherwise: around the common centre,
   * re-aligning the footprint with the stud grid when the result is 90°-aligned.
   */
  function rotateItems(items: Item[], R: Mat3): Item[] {
    if (items.length === 1 && !isAxisAligned(normRot(mulMat3(R, items[0].rot)))) {
      return [{ ...items[0], rot: normRot(mulMat3(R, items[0].rot)) }];
    }
    const union = new THREE.Box3();
    for (const it of items) union.union(itemBox(it));
    const cx = Math.round(((union.min.x + union.max.x) / 2) / 10) * 10;
    const cz = Math.round(((union.min.z + union.max.z) / 2) / 10) * 10;
    const next = items.map((it) => {
      const rel = applyMat3(R, [it.pos[0] - cx, it.pos[1], it.pos[2] - cz]);
      return { ...it, pos: [clean(rel[0] + cx), it.pos[1], clean(rel[2] + cz)] as Vec3, rot: normRot(mulMat3(R, it.rot)) };
    });
    if (next.every((n) => isAxisAligned(n.rot))) {
      const nb = new THREE.Box3();
      for (const n of next) nb.union(itemBox(n));
      const sx = gridShift(nb.min.x);
      const sz = gridShift(nb.min.z);
      for (const n of next) n.pos = [clean(n.pos[0] + sx), n.pos[1], clean(n.pos[2] + sz)];
    }
    return next;
  }

  const itemSolid = (it: Item) => solidOf(it.tpl.body, it.rot, it.pos);
  const itemsBlocked = (items: Item[], ignore?: Set<string>) => items.some((it) => collides(itemSolid(it), ignore));

  function selectionItems(): Item[] {
    const out: Item[] = [];
    for (const id of get().selection) {
      const e = entries.get(id);
      if (e?.tpl && e.body && e.built) out.push({ id, tpl: e.tpl, pos: e.brick.pos, rot: e.brick.rot });
    }
    return out;
  }

  function pendingItem(): Item | null {
    return pending && ghost ? { id: null, tpl: ghost.tpl, pos: pending.pos, rot: pending.rot } : null;
  }

  /** The pending brick(s): a duplicate group, else the single place-tool brick. */
  function pendingItems(): Item[] | null {
    if (dup) return dup.items;
    const p = pendingItem();
    return p ? [p] : null;
  }

  function setPendingItems(items: Item[]) {
    if (dup) {
      dup.items = items;
      showDup();
    } else if (pending) {
      pending.pos = items[0].pos;
      pending.rot = items[0].rot;
      showPending();
    }
  }

  const unionBox = (items: Item[]) => {
    const b = new THREE.Box3();
    for (const it of items) b.union(itemBox(it));
    return b;
  };

  // ------------------------------------------------------------------ pending brick
  function pendingState(): PendingState {
    if (dup) return { active: true, blocked: dup.blocked, kind: 'duplicate', count: dup.items.length };
    if (pending) return { active: true, blocked: pending.blocked, kind: 'brick', count: 1 };
    return { active: false, blocked: false, count: 0 };
  }

  function emitPending() {
    const s = pendingState();
    if (s.active) autoFrameReq = true;
    else setFloating(false);
    const key = `${s.active}|${s.blocked}|${s.kind}|${s.count}`;
    if (key === lastPendingKey) return;
    lastPendingKey = key;
    for (const cb of pendingListeners) cb(s);
  }

  function setFloating(f: boolean) {
    if (f === floating) return;
    floating = f;
    emit({ type: 'floating', floating: f });
  }

  /** Push the pending transform to the ghost object, re-check overlap, update its look. */
  function showPending() {
    const it = pendingItem();
    if (!pending || !ghost || !it) return;
    const grp = ghost.built.group;
    mat4From(pending.rot, pending.pos, grp.matrix);
    grp.matrixWorldNeedsUpdate = true;
    grp.visible = true;
    pending.blocked = collides(itemSolid(it));
    const look: Look = pending.blocked ? 'blocked' : 'ghost';
    if (look !== ghost.look) {
      ghost.look = look;
      lib.applyLook(ghost.built.nodes, look);
    }
    dirty = true;
    emitPending();
  }

  /** Same for a pending duplicate group. */
  function showDup() {
    const d = dup;
    if (!d) return;
    d.blocked = itemsBlocked(d.items);
    const look: Look = d.blocked ? 'blocked' : 'ghost';
    d.items.forEach((it, i) => {
      const pc = d.pieces[i];
      mat4From(it.rot, it.pos, pc.built.group.matrix);
      pc.built.group.matrixWorldNeedsUpdate = true;
      pc.built.group.visible = true;
      if (pc.look !== look) {
        pc.look = look;
        lib.applyLook(pc.built.nodes, look);
      }
    });
    dirty = true;
    emitPending();
  }

  function startPending(pos: Vec3, rot: Mat3) {
    pending = { pos, rot, blocked: false };
    showPending();
    addPop(null, 0.96, 120);
  }

  function removeDup() {
    if (!dup) return;
    for (const pc of dup.pieces) root.remove(pc.built.group);
    dup = null;
    hoverDirty = true;
    dirty = true;
    emitPending();
  }

  function cancelPending() {
    if (handleDrag?.kind === 'pending') endHandleDrag(false);
    if (dup) {
      removeDup();
      return;
    }
    if (!pending) return;
    pending = null;
    if (ghost) ghost.built.group.visible = false;
    hoverDirty = true;
    dirty = true;
    emitPending();
  }

  /** Attempted place on an overlapping spot: shake the ghost, tell the UI (toast + haptic). */
  function placeBlocked() {
    shakeUntil = performance.now() + 360;
    for (const cb of blockedListeners) cb();
    emit({ type: 'blocked' });
    dirty = true;
  }

  /** Committed bricks: placement pop, a short "what landed" outline, feedback. */
  function afterPlaced(ids: string[]) {
    for (const id of ids) addPop(id, 0.92, 120);
    recent = { ids, t0: performance.now() };
    emit({ type: 'placed' });
    dirty = true;
  }

  function confirmPending(): boolean {
    const st = get();
    if (st.readOnly || handleDrag) return false;
    if (dup) return confirmDup();
    if (!pending || !ghost) return false;
    if (pending.blocked) {
      placeBlocked();
      return false;
    }
    const { pos, rot } = pending;
    const part = ghost.part;
    pending = null;
    ghost.built.group.visible = false;
    ghostRot = rot; // the next brick keeps this orientation
    const id = st.addBrick({ part, color: st.activeColor, pos, rot });
    afterPlaced([id]);
    hoverDirty = true;
    dirty = true;
    emitPending();
    return true;
  }

  /** Commit a pending duplicate as one undo step; the copies become the selection. */
  function confirmDup(): boolean {
    const d = dup;
    if (!d) return false;
    if (d.blocked) {
      placeBlocked();
      return false;
    }
    const st = get();
    const bricks: Brick[] = d.items.map((it, i) => ({
      id: newId(), part: d.pieces[i].part, color: d.pieces[i].color, pos: it.pos, rot: it.rot,
    }));
    const unrotated = d.items.every((it, i) => sameVec(it.rot, d.src[i].rot));
    const off = [0, 1, 2].map((k) => clean(d.items[0].pos[k] - d.src[0].pos[k])) as Vec3;
    for (const pc of d.pieces) root.remove(pc.built.group);
    dup = null;
    st.setModel({ ...st.model, bricks: [...st.model.bricks, ...bricks] });
    const ids = bricks.map((b) => b.id);
    lastDup = unrotated ? { ids, offset: off } : null; // the next Duplicate keeps stepping the same way
    get().select(ids);
    afterPlaced(ids);
    hoverDirty = true;
    emitPending();
    return true;
  }

  /** Did a tap at (x, y) land on the pending brick(s)? (generous: boxes + a few px around the centre) */
  function hitsPending(x: number, y: number): boolean {
    const items = pendingItems();
    if (!items) return false;
    setRay(x, y);
    for (const it of items) {
      if (raycaster.ray.intersectsBox(ldToThreeBox(itemBox(it)).expandByScalar(4))) return true;
    }
    const c = toScreen(ldToThreeBox(unionBox(items)).getCenter(new THREE.Vector3()));
    return !!c && Math.hypot(c.x - x, c.y - y) < 26;
  }

  /** Translate the gizmo target (pending brick(s), else selection) by an LDraw delta. */
  function moveTargetBy(d: Vec3) {
    const st = get();
    if (st.readOnly || handleDrag) return;
    const pi = pendingItems();
    if (pi) {
      setPendingItems(translateItems(pi, d));
      emitStep();
      return;
    }
    const sel = selectionItems();
    if (!sel.length || drag) return;
    const next = translateItems(sel, d);
    if (itemsBlocked(next, new Set(sel.map((s) => s.id!)))) return;
    st.updateBricks(next.map((n) => ({ id: n.id!, pos: n.pos })));
    emitStep();
  }

  /** The horizontal stud axis closest to screen-right ('x') or into the screen ('z'), as an LDraw step. */
  function cameraAxisStep(axis: 'x' | 'z', step: number): Vec3 {
    const cam = activeCamera();
    cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    if (axis === 'x') v.set(1, 0, 0).applyQuaternion(cam.quaternion);
    else {
      cam.getWorldDirection(v);
      if (Math.hypot(v.x, v.z) < 0.2) v.set(0, 1, 0).applyQuaternion(cam.quaternion); // top-down: screen-up
    }
    // three → LDraw: x stays, z flips
    if (Math.abs(v.x) >= Math.abs(v.z)) return [Math.sign(v.x) * step, 0, 0];
    return [0, 0, -Math.sign(v.z) * step];
  }

  /**
   * Pending copy of the selection. Offset candidates (first free one wins): the last duplicate's
   * step (repeat → rows / walls), 1 stud camera-right, right next to it camera-right, on top.
   */
  function duplicateSelection() {
    const st = get();
    if (st.readOnly || handleDrag || drag) return;
    if (dup && !confirmDup()) return; // blocked: shake, keep it
    const sel = selectionItems();
    if (!sel.length) return;
    if (pending) cancelPending();
    const ids = sel.map((s) => s.id!);
    const union = unionBox(sel);
    const one = cameraAxisStep('x', 20);
    const width = one[0] !== 0 ? union.max.x - union.min.x : union.max.z - union.min.z;
    const adj = cameraAxisStep('x', Math.max(20, Math.round(width / 20) * 20));
    const candidates: Vec3[] = [];
    if (lastDup && lastDup.ids.length === ids.length && ids.every((id) => lastDup!.ids.includes(id))) {
      candidates.push(lastDup.offset);
    }
    candidates.push(one, adj, [0, clean(-(union.max.y - union.min.y)), 0]);
    let items = translateItems(sel, adj);
    for (const c of candidates) {
      const t = translateItems(sel, c);
      if (!itemsBlocked(t)) {
        items = t;
        break;
      }
    }
    const pieces: DupPiece[] = sel.map((it) => {
      const e = entries.get(it.id!)!;
      const built = lib.instantiate(it.tpl, e.brick.color, 'ghost', false);
      built.group.renderOrder = 5;
      built.group.traverse((o) => { o.renderOrder = 5; });
      root.add(built.group);
      return { part: e.brick.part, color: e.brick.color, tpl: it.tpl, built, look: 'ghost' as Look };
    });
    dup = { pieces, items: items.map((it) => ({ ...it, id: null })), src: sel.map((s) => ({ ...s })), blocked: false };
    hideHoverGhost();
    showDup();
  }

  /** Camera-relative step: 'x' = screen-right-ish stud axis, 'z' = into-the-screen, 'y' = up. */
  function nudge(axis: 'x' | 'y' | 'z', dir: '+' | '-', fine = false) {
    const sgn = dir === '+' ? 1 : -1;
    if (axis === 'y') {
      moveTargetBy([0, -8 * sgn, 0]);
      return;
    }
    moveTargetBy(cameraAxisStep(axis, (fine ? 10 : 20) * sgn));
  }

  // ------------------------------------------------------------------ gizmo
  function toScreen(v: THREE.Vector3): { x: number; y: number } | null {
    const cam = activeCamera();
    const p = v.clone().project(cam);
    if (p.z > 1 || p.z < -1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  function gizmoTarget(): { kind: 'pending' | 'selection'; items: Item[] } | null {
    const st = get();
    if (st.readOnly || disposed) return null;
    if (handleDrag) return { kind: handleDrag.kind, items: handleDrag.preview };
    if (dup) return { kind: 'pending', items: dup.items };
    if (st.tool === 'place') {
      const p = pendingItem();
      return p ? { kind: 'pending', items: [p] } : null;
    }
    if (st.tool === 'select' && !drag?.active) {
      const s = selectionItems();
      return s.length ? { kind: 'selection', items: s } : null;
    }
    return null;
  }

  /** Position / scale the gizmo for the current camera and cache its screen-space hit shapes. */
  function refreshGizmo() {
    const target = gizmoTarget();
    if (!target || !container) {
      gizmo.group.visible = false;
      gizmoInfo = null;
      return;
    }
    const box = new THREE.Box3();
    for (const it of target.items) box.union(itemBox(it));
    const tb = ldToThreeBox(box);
    const center = tb.getCenter(new THREE.Vector3());
    const half = tb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const cam = activeCamera();
    cam.updateMatrixWorld();
    const hPx = Math.max(1, canvas.clientHeight);
    let s: number;
    if (cam === persp) {
      const dist = Math.max(1, center.clone().sub(persp.position).dot(persp.getWorldDirection(new THREE.Vector3())));
      s = (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * dist) / hPx;
    } else {
      s = (ortho.top - ortho.bottom) / ortho.zoom / hPx;
    }
    gizmo.group.position.copy(center);
    gizmo.group.scale.setScalar(s);
    const onGround = box.max.y >= -0.5; // LDraw bottom at Y = 0
    const arrows: GizmoInfo['arrows'] = [];
    let ringPx = 0;
    // Horizontal cones + ring sit on the brick's base plane (so they project outside its
    // silhouette instead of over its faces); vertical cones above / below the box.
    const base = center.clone();
    base.y -= half.y;
    const baseOffPx = -half.y / s;
    for (const a of gizmo.arrows) {
      const horiz = a.dir.y === 0;
      const ext = Math.abs(a.dir.x) * half.x + Math.abs(a.dir.y) * half.y + Math.abs(a.dir.z) * half.z;
      const startPx = Math.max(ext / s + 10, 22);
      const origin = horiz ? base : center;
      a.group.position.copy(a.dir).multiplyScalar(startPx + CONE_LEN / 2);
      if (horiz) a.group.position.y = baseOffPx;
      if (horiz) ringPx = Math.max(ringPx, startPx + CONE_LEN + 26);
      const sa = toScreen(origin.clone().addScaledVector(a.dir, startPx * s));
      const sb = toScreen(origin.clone().addScaledVector(a.dir, (startPx + CONE_LEN) * s));
      // hide a cone that points (nearly) at the camera
      let vis = !!sa && !!sb && Math.hypot(sb.x - sa.x, sb.y - sa.y) > CONE_LEN * 0.45;
      if (a.id === 'y-' && onGround) vis = false;
      a.group.visible = vis;
      if (vis) arrows.push({ id: a.id, dir: a.dir, origin, a: sa!, b: sb! });
    }
    gizmo.setRingRadius(ringPx);
    const R = gizmo.ringR * s;
    const hd = THREE.MathUtils.degToRad(headingDeg(target.items[0].rot));
    gizmo.knobPivot.rotation.y = hd;
    gizmo.ring.position.y = baseOffPx;
    const knob = toScreen(new THREE.Vector3(base.x + Math.cos(hd) * R, base.y, base.z - Math.sin(hd) * R));
    gizmo.setHot(handleDrag?.handle ?? hotHandle);
    gizmo.group.visible = true;
    gizmoInfo = { center, centerS: toScreen(center), base, baseS: toScreen(base), arrows, knob };
  }

  /**
   * Gizmo hit test: cones, then the ring knob, then the brick body itself (pending brick: any
   * pointer; selected bricks: touch only — mouse keeps its own drag-to-move / shift-toggle).
   */
  function hitGizmo(x: number, y: number, pointerType = 'mouse'): HandleId | null {
    refreshGizmo();
    if (!gizmoInfo) return null;
    const p = { x, y };
    let best: HandleId | null = null;
    let bestD = Infinity;
    for (const a of gizmoInfo.arrows) {
      const d = distToSeg(p, a.a, a.b);
      if (d < ARROW_HIT_PX && d < bestD) { best = a.id; bestD = d; }
    }
    if (gizmoInfo.knob) {
      const d = Math.hypot(x - gizmoInfo.knob.x, y - gizmoInfo.knob.y);
      if (d < KNOB_HIT_PX && d < bestD) { best = 'ring'; bestD = d; }
    }
    // The brick body wins over a handle's generous margin (small bricks on screen), but not
    // over a direct hit on the drawn handle itself.
    const st = get();
    let body = false;
    if (dup || (st.tool === 'place' && pending)) body = hitsPending(x, y);
    else if (st.tool === 'select' && pointerType === 'touch') {
      const hit = pickBrick(x, y);
      body = !!hit && selectionSet.has(hit.id);
    }
    if (best && (!body || bestD < 12)) return best;
    return body ? 'body' : null;
  }

  /** Current ray ∩ horizontal plane at three height y. */
  function rayOnPlane(y: number): THREE.Vector3 | null {
    return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  }

  function screenAngle(x: number, y: number): number {
    const c = gizmoInfo?.baseS ?? { x, y: y + 1 };
    return Math.atan2(-(y - c.y), x - c.x); // CCW on screen = CCW seen from above
  }

  /** Closest-point parameter on the axis line (origin + t·dir) to the current pick ray. */
  function axisParam(origin: THREE.Vector3, dir: THREE.Vector3): number | null {
    const ray = raycaster.ray;
    const w0 = origin.clone().sub(ray.origin);
    const b = dir.dot(ray.direction);
    const d = dir.dot(w0);
    const e = ray.direction.dot(w0);
    const denom = 1 - b * b;
    if (denom < 1e-4) return null;
    return (b * e - d) / denom;
  }

  function startHandleDrag(h: HandleId, ev: PointerEvent) {
    const target = gizmoTarget();
    if (!target || !gizmoInfo) return;
    const arrow = gizmo.arrows.find((a) => a.id === h);
    const origin = (gizmoInfo.arrows.find((a) => a.id === h)?.origin ?? gizmoInfo.center).clone();
    let t0 = 0;
    setRay(ev.clientX, ev.clientY);
    if (arrow) t0 = axisParam(origin, arrow.dir) ?? 0;
    else if (h === 'body') {
      const p0 = rayOnPlane(origin.y);
      if (p0) origin.copy(p0);
    }
    const base = target.items.map((it) => ({ ...it }));
    handleDrag = {
      pointerId: ev.pointerId,
      handle: h,
      kind: target.kind,
      base,
      preview: base,
      idSet: new Set(base.filter((it) => it.id).map((it) => it.id!)),
      origin,
      dirW: arrow ? arrow.dir.clone() : null,
      t0,
      angle: screenAngle(ev.clientX, ev.clientY),
      total: 0,
      key: h === 'ring' ? 'r0' : '0,0,0',
      x: ev.clientX,
      y: ev.clientY,
      moved: false,
      blocked: target.kind === 'pending' ? pendingState().blocked : false,
      changed: false,
    };
    press = null;
    setControlsEnabled(false);
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    canvas.style.cursor = 'grabbing';
    dirty = true;
  }

  function moveHandleDrag(ev: PointerEvent) {
    const hd = handleDrag;
    if (!hd) return;
    const slop = ev.pointerType === 'touch' ? TOUCH_TAP_PX : CLICK_PX;
    if (!hd.moved && Math.hypot(ev.clientX - hd.x, ev.clientY - hd.y) >= slop) hd.moved = true;
    if (!hd.moved) return;
    let next: Item[];
    let key: string;
    if (hd.handle === 'body') {
      // drag the pending / selected brick itself across the horizontal plane
      setRay(ev.clientX, ev.clientY);
      const p = rayOnPlane(hd.origin.y);
      if (!p) return;
      const hs = ev.altKey || ev.shiftKey ? 10 : 20;
      const snap = (v: number) => clean(Math.round(THREE.MathUtils.clamp(v, -4000, 4000) / hs) * hs);
      const d: Vec3 = [snap(p.x - hd.origin.x), 0, snap(-(p.z - hd.origin.z))];
      key = d.join(',');
      if (key === hd.key) return;
      next = translateItems(hd.base, d);
    } else if (!hd.dirW) {
      const a = screenAngle(ev.clientX, ev.clientY);
      let da = a - hd.angle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      hd.total += da;
      hd.angle = a;
      // 5° steps with a stronger detent (±3°) at every 90°; multi-brick selections: 90° only
      const raw = THREE.MathUtils.radToDeg(hd.total);
      const n90 = Math.round(raw / 90) * 90;
      const deg = hd.base.length > 1 || Math.abs(raw - n90) <= 3 ? n90 : Math.round(raw / 5) * 5;
      const norm = ((deg % 360) + 360) % 360;
      key = `r${norm}`;
      const heading = (((Math.round(headingDeg(hd.base[0].rot)) + deg) % 360) + 360) % 360;
      showAngleLabel(`${heading}°`, ev.clientX, ev.clientY);
      dirty = true;
      if (key === hd.key) return;
      if (norm % 90 === 0) emit({ type: 'snap-detent' });
      next = norm === 0 ? hd.base : rotateItems(hd.base, rotYDeg(-deg)); // CCW from above = -LDraw Y
    } else {
      setRay(ev.clientX, ev.clientY);
      const t = axisParam(hd.origin, hd.dirW);
      if (t === null) return;
      const dt = THREE.MathUtils.clamp(t - hd.t0, -4000, 4000);
      const w = hd.dirW.clone().multiplyScalar(dt);
      const hs = ev.altKey || ev.shiftKey ? 10 : 20;
      const snap = (v: number, st: number) => clean(Math.round(v / st) * st);
      const d: Vec3 = [snap(w.x, hs), snap(-w.y, 8), snap(-w.z, hs)]; // three → LDraw
      key = d.join(',');
      if (key === hd.key) return;
      next = translateItems(hd.base, d);
    }
    if (hd.dirW || hd.handle === 'body') emitStep();
    hd.key = key;
    hd.preview = next;
    hd.changed = key !== '0,0,0' && key !== 'r0';
    hd.blocked = itemsBlocked(next, hd.idSet);
    applyHandlePreview(hd);
  }

  function applyHandlePreview(hd: HandleDrag) {
    if (hd.kind === 'pending') {
      setPendingItems(hd.preview);
      return;
    }
    for (const it of hd.preview) {
      const e = it.id ? entries.get(it.id) : undefined;
      if (!e?.built) continue;
      mat4From(it.rot, it.pos, e.built.group.matrix);
      e.built.group.matrixWorldNeedsUpdate = true;
      refreshLook(it.id!, e);
    }
    updateSelectionHelpers();
    dirty = true;
  }

  function endHandleDrag(commit: boolean) {
    const hd = handleDrag;
    if (!hd) return;
    handleDrag = null;
    try { canvas.releasePointerCapture(hd.pointerId); } catch { /* ignore */ }
    setControlsEnabled(true);
    angleLabel.style.display = 'none';
    canvas.style.cursor = '';
    if (hd.kind === 'pending') {
      const cur = pendingItems();
      if (cur) setPendingItems(commit ? cur : hd.base);
    } else {
      if (commit && hd.moved && hd.changed && !hd.blocked) {
        get().updateBricks(hd.preview.map((n) => ({ id: n.id!, pos: n.pos, rot: n.rot })));
      }
      for (const id of hd.idSet) {
        const e = entries.get(id);
        if (e) applyTransform(e); // revert the preview (or apply the committed brick)
      }
      refreshLooks();
      updateSelectionHelpers();
    }
    if (commit && !hd.moved) {
      // a tap: on the pending brick = place it; a cone = one step; the knob = a quarter turn
      if (hd.handle === 'body') {
        if (hd.kind === 'pending') {
          lastTap = null;
          confirmPending(); // also the "double-tap = instant place" fast path
        } else if (isDoubleTap(hd.x, hd.y)) {
          focusAt(hd.x, hd.y);
        } else {
          // touch, select tool: tap on a selected brick deselects it
          const hit = pickBrick(hd.x, hd.y);
          const st = get();
          if (hit && selectionSet.has(hit.id)) {
            const next = st.selection.filter((id) => id !== hit.id);
            st.select(next);
            emit({ type: 'selected', count: next.length });
          }
        }
      } else if (!hd.dirW) {
        rotate(1);
        emit({ type: 'snap-detent' });
      }
      else moveTargetBy([hd.dirW.x * 20, -hd.dirW.y * 8, -hd.dirW.z * 20]);
    }
    hoverDirty = true;
    dirty = true;
  }

  function setHot(h: HandleId | null) {
    if (h === hotHandle) return;
    hotHandle = h;
    dirty = true;
  }

  // ------------------------------------------------------------------ pointer handling
  const LONG_PRESS_MS = 450;
  const LONG_PRESS_PX = 8;
  const DOUBLE_TAP_MS = 320;
  const DOUBLE_TAP_PX = 28;
  let longPress: { pointerId: number; x: number; y: number; timer: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;
  let cubePress: { pointerId: number; x: number; y: number } | null = null;

  /** Register a tap; true when it completes a double tap (the pair is then consumed). */
  function isDoubleTap(x: number, y: number): boolean {
    const now = performance.now();
    const dbl = !!lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = dbl ? null : { t: now, x, y };
    return dbl;
  }

  function clearLongPress() {
    if (!longPress) return;
    clearTimeout(longPress.timer);
    longPress = null;
  }

  /** Place tool, touch: holding still on a brick selects it (the UI then switches to Select). */
  function fireLongPress() {
    const lp = longPress;
    longPress = null;
    if (!lp || !press || press.pointerId !== lp.pointerId || handleDrag || pointers.size !== 1) return;
    const st = get();
    if (st.readOnly || st.tool !== 'place') return;
    const hit = pickBrick(lp.x, lp.y);
    if (!hit) return;
    press.longPressed = true;
    setControlsEnabled(false); // stop the orbit this finger started
    cancelPending();
    st.select([hit.id]);
    addPop(hit.id, 1.05, 180);
    emit({ type: 'long-press-select', id: hit.id });
    emit({ type: 'selected', count: 1 });
  }

  function cancelPress() {
    clearLongPress();
    if (handleDrag) endHandleDrag(false);
    if (drag) endDrag(false);
    press = null;
    setControlsEnabled(true);
  }

  function localXY(ev: { clientX: number; clientY: number }) {
    const r = canvas.getBoundingClientRect();
    return { lx: ev.clientX - r.left, ly: ev.clientY - r.top };
  }

  function onPointerDown(ev: PointerEvent) {
    cancelCamAnim();
    pointers.add(ev.pointerId);
    if (pointers.size > 1) {
      cubePress = null;
      cancelPress();
      return;
    }
    // view cube: consume the gesture (OrbitControls never sees it)
    const { lx, ly } = localXY(ev);
    if (viewCube.visible && viewCube.contains(lx, ly)) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      cubePress = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
      viewCube.setHot(viewCube.pick(lx, ly)?.face ?? -1);
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      dirty = true;
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button !== 0) {
      // Right-click in place mode = quick erase (click only; right-drag still pans).
      if (ev.button === 2) {
        const st0 = get();
        if (!st0.readOnly && st0.tool === 'place') {
          press = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, shift: false, toggleOff: null };
        }
      }
      return;
    }
    const st = get();
    if (!st.readOnly) {
      // gizmo handles win over everything else (and keep the camera still)
      const h = hitGizmo(ev.clientX, ev.clientY, ev.pointerType);
      if (h) {
        startHandleDrag(h, ev);
        return;
      }
    }
    press = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, shift: ev.shiftKey, toggleOff: null };
    if (st.readOnly) return;
    if (st.tool === 'place' && ev.pointerType !== 'mouse' && !dup) {
      longPress = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, timer: window.setTimeout(fireLongPress, LONG_PRESS_MS) };
    }

    // On touch, a one-finger drag on a brick orbits; selection happens on tap and moving
    // goes through the gizmo. Mouse / pen keep drag-to-move.
    if (st.tool === 'select' && ev.pointerType !== 'touch' && !dup) {
      const hit = pickBrick(ev.clientX, ev.clientY);
      if (!hit) return;
      const additive = ev.shiftKey || addMode;
      if (!selectionSet.has(hit.id)) {
        st.select([hit.id], additive);
        emit({ type: 'selected', count: get().selection.length });
      } else if (additive) {
        press.toggleOff = hit.id;
      }
      const ids = get().selection.filter((id) => entries.get(id)?.built);
      if (!ids.length) return;
      drag = {
        ids,
        idSet: new Set(ids),
        planeY: hit.point.y,
        start: toLDraw(hit.point),
        dx: 0,
        dz: 0,
        active: false,
        blocked: false,
      };
      setControlsEnabled(false);
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    } else if (st.tool === 'place' && ev.pointerType === 'pen') {
      placeGhostAt(ev.clientX, ev.clientY);
    }
  }

  function onPointerMove(ev: PointerEvent) {
    if (cubePress) {
      if (cubePress.pointerId === ev.pointerId) {
        const { lx, ly } = localXY(ev);
        viewCube.setHot(viewCube.pick(lx, ly)?.face ?? -1);
        dirty = true;
      }
      return;
    }
    if (handleDrag) {
      if (handleDrag.pointerId === ev.pointerId) moveHandleDrag(ev);
      return;
    }
    if (longPress && longPress.pointerId === ev.pointerId
      && Math.hypot(ev.clientX - longPress.x, ev.clientY - longPress.y) >= LONG_PRESS_PX) clearLongPress();
    if (press?.longPressed) return;
    if (press && press.pointerId === ev.pointerId && !press.moved) {
      const slop = ev.pointerType === 'touch' ? TOUCH_TAP_PX : CLICK_PX;
      if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) >= slop) press.moved = true;
    }
    if (drag && press && press.pointerId === ev.pointerId) {
      if (press.moved) moveDrag(ev.clientX, ev.clientY, ev.altKey);
      return;
    }
    if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') {
      if (press && press.moved) {
        // orbiting / panning: hide hover feedback
        hideHoverGhost();
        hoverXY = null;
        return;
      }
      hoverXY = { x: ev.clientX, y: ev.clientY };
      hoverDirty = true;
    }
  }

  function onPointerUp(ev: PointerEvent) {
    pointers.delete(ev.pointerId);
    if (longPress?.pointerId === ev.pointerId) clearLongPress();
    if (cubePress && cubePress.pointerId === ev.pointerId) {
      const cp = cubePress;
      cubePress = null;
      viewCube.setHot(-1);
      dirty = true;
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      const { lx, ly } = localXY(ev);
      const pk = viewCube.pick(lx, ly);
      const slop = ev.pointerType === 'touch' ? TOUCH_TAP_PX : 12;
      if (pk && Math.hypot(ev.clientX - cp.x, ev.clientY - cp.y) < slop) cubeTap(pk.dir);
      return;
    }
    if (handleDrag && handleDrag.pointerId === ev.pointerId) {
      endHandleDrag(true);
      autoFrameReq = true;
      return;
    }
    if (!press || press.pointerId !== ev.pointerId) return;
    const p = press;
    press = null;
    if (p.longPressed) {
      setControlsEnabled(true);
      return;
    }
    if (drag) {
      const wasActive = drag.active;
      endDrag(wasActive);
      if (!wasActive && p.toggleOff) {
        const st = get();
        st.select(st.selection.filter((id) => id !== p.toggleOff), false);
        emit({ type: 'selected', count: get().selection.length });
      }
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      setControlsEnabled(true);
      if (!wasActive && isDoubleTap(ev.clientX, ev.clientY)) focusAt(ev.clientX, ev.clientY);
      return;
    }
    setControlsEnabled(true);
    if (!p.moved) handleClick(ev);
    if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') {
      hoverXY = { x: ev.clientX, y: ev.clientY };
      hoverDirty = true;
    }
  }

  function onPointerCancel(ev: PointerEvent) {
    pointers.delete(ev.pointerId);
    if (cubePress?.pointerId === ev.pointerId) {
      cubePress = null;
      viewCube.setHot(-1);
      dirty = true;
    }
    if (handleDrag && handleDrag.pointerId === ev.pointerId) endHandleDrag(false);
    if (press && press.pointerId === ev.pointerId) cancelPress();
  }

  function onPointerLeave(ev: PointerEvent) {
    if (ev.pointerType !== 'mouse') return;
    hoverXY = null;
    hoverDirty = true;
  }

  /** Double tap: on a brick = orbit around it; elsewhere = frame the whole build. */
  function focusAt(x: number, y: number) {
    const hit = pickBrick(x, y);
    if (hit?.entry.body) focusBox(ldToThreeBox(hit.entry.body));
    else zoomToFit(true);
  }

  function handleClick(ev: PointerEvent) {
    const st = get();
    const x = ev.clientX;
    const y = ev.clientY;
    const dbl = isDoubleTap(x, y);
    if (ev.button === 2) {
      if (st.tool === 'place' && !st.readOnly) {
        const hit = pickBrick(x, y);
        if (hit) st.removeBricks([hit.id]);
      }
      return;
    }
    if (st.readOnly) {
      if (dbl) focusAt(x, y);
      return;
    }
    if (dup) {
      // tap on the copies = place (handled by the gizmo body); elsewhere = move the group there
      const items = dup.items;
      const a = items[0].pos;
      const g = unionBox(items).translate(new THREE.Vector3(-a[0], -a[1], -a[2]));
      const pos = placementFor(x, y, g, items.every((it) => isAxisAligned(it.rot)));
      if (pos) setPendingItems(translateItems(items, [clean(pos[0] - a[0]), clean(pos[1] - a[1]), clean(pos[2] - a[2])]));
      else if (dbl) zoomToFit(true);
      return;
    }
    switch (st.tool) {
      case 'place': {
        if (!ghost || !st.activePart) {
          if (dbl) focusAt(x, y);
          return;
        }
        if (pending) {
          // tap 2: on the pending brick = place it (gizmo body); elsewhere = move it there; sky = nothing
          if (hitsPending(x, y)) {
            confirmPending();
            return;
          }
          const pl = computePlacement(x, y, pending.rot);
          if (pl) {
            pending.pos = pl.pos;
            showPending();
          } else if (dbl) zoomToFit(true);
          return;
        }
        if (ev.pointerType === 'touch' || ev.shiftKey) {
          // tap 1: drop a pending brick with the gizmo
          const pl = computePlacement(x, y, ghostRot);
          if (pl) startPending(pl.pos, ghostRot);
          else if (dbl) zoomToFit(true);
          return;
        }
        placeGhostAt(x, y);
        if (ghostPlacement?.valid) {
          const id = st.addBrick({ part: st.activePart, color: st.activeColor, pos: ghostPlacement.pos, rot: ghostRot });
          afterPlaced([id]);
        } else if (!ghostPlacement && dbl) zoomToFit(true);
        if (ev.pointerType !== 'mouse' && ghost) {
          ghost.built.group.visible = false;
          dirty = true;
        }
        break;
      }
      case 'select': {
        if (ev.pointerType === 'touch') {
          const hit = pickBrick(x, y);
          if (dbl) {
            focusAt(x, y);
          } else if (hit) {
            st.select([hit.id], addMode);
            emit({ type: 'selected', count: get().selection.length });
          } else if (st.selection.length && !addMode) {
            st.select([]);
            emit({ type: 'selected', count: 0 });
          }
          break;
        }
        if (dbl) {
          focusAt(x, y);
          break;
        }
        // brick clicks are handled on pointerdown; a click on empty space clears the selection
        if (!ev.shiftKey && !addMode && st.selection.length) {
          st.select([]);
          emit({ type: 'selected', count: 0 });
        }
        break;
      }
      case 'paint': {
        const hit = pickBrick(x, y);
        if (hit && hit.entry.brick.color !== st.activeColor) st.updateBricks([{ id: hit.id, color: st.activeColor }]);
        else if (!hit && dbl) zoomToFit(true);
        break;
      }
      case 'erase': {
        const hit = pickBrick(x, y);
        if (hit) {
          if (hoverEraseId === hit.id) hoverEraseId = null;
          st.removeBricks([hit.id]);
        } else if (dbl) zoomToFit(true);
        break;
      }
    }
  }

  function setHoverErase(id: string | null) {
    if (id === hoverEraseId) return;
    const prev = hoverEraseId;
    hoverEraseId = id;
    for (const k of [prev, id]) {
      if (!k) continue;
      const e = entries.get(k);
      if (e) refreshLook(k, e);
    }
  }

  function processHover() {
    hoverDirty = false;
    const st = get();
    if (drag?.active || handleDrag) return;
    if (hoverXY && viewCube.visible) {
      const { lx, ly } = localXY({ clientX: hoverXY.x, clientY: hoverXY.y });
      const over = viewCube.contains(lx, ly);
      viewCube.setHot(over ? viewCube.pick(lx, ly)?.face ?? -1 : -1);
      dirty = true;
      if (over) {
        hideHoverGhost();
        setHot(null);
        setHoverErase(null);
        canvas.style.cursor = 'pointer';
        return;
      }
    }
    if (!hoverXY || st.readOnly) {
      hideHoverGhost();
      setHot(null);
      setHoverErase(null);
      canvas.style.cursor = '';
      return;
    }
    const gh = gizmoInfo || pending || dup ? hitGizmo(hoverXY.x, hoverXY.y, 'mouse') : null;
    setHot(gh === 'body' ? null : gh);
    if (gh || dup || (st.tool === 'place' && pending)) {
      setHoverErase(null);
      canvas.style.cursor = gh ? (gh === 'body' ? 'pointer' : 'grab') : '';
      return;
    }
    if (st.tool === 'place') {
      setHoverErase(null);
      canvas.style.cursor = '';
      placeGhostAt(hoverXY.x, hoverXY.y);
      return;
    }
    const hit = pickBrick(hoverXY.x, hoverXY.y);
    canvas.style.cursor = hit ? 'pointer' : '';
    setHoverErase(st.tool === 'erase' && hit ? hit.id : null);
  }

  // ------------------------------------------------------------------ drag-move (select tool)
  function moveDrag(x: number, y: number, fine: boolean) {
    if (!drag) return;
    setRay(x, y);
    const p = rayToThreePlane(drag.planeY);
    if (!p) return;
    const ld = toLDraw(p);
    const step = fine ? 10 : 20;
    const dx = Math.round((ld.x - drag.start.x) / step) * step;
    const dz = Math.round((ld.z - drag.start.z) / step) * step;
    const first = !drag.active;
    drag.active = true;
    if (!first && dx === drag.dx && dz === drag.dz) return;
    drag.dx = dx;
    drag.dz = dz;
    let blocked = false;
    const m = new THREE.Matrix4();
    for (const id of drag.ids) {
      const e = entries.get(id);
      if (!e?.built || !e.tpl) continue;
      const pos: Vec3 = [e.brick.pos[0] + dx, e.brick.pos[1], e.brick.pos[2] + dz];
      mat4From(e.brick.rot, pos, m);
      e.built.group.matrix.copy(m);
      e.built.group.matrixWorldNeedsUpdate = true;
      if (!blocked && collides(solidOf(e.tpl.body, e.brick.rot, pos), drag.idSet)) blocked = true;
    }
    drag.blocked = blocked;
    for (const id of drag.ids) {
      const e = entries.get(id);
      if (e) refreshLook(id, e);
    }
    updateSelectionHelpers();
    dirty = true;
  }

  function endDrag(commit: boolean) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (commit && d.active && !d.blocked && (d.dx || d.dz)) {
      const patches = d.ids
        .map((id) => entries.get(id))
        .filter((e): e is Entry => !!e)
        .map((e) => ({
          id: e.brick.id,
          pos: [clean(e.brick.pos[0] + d.dx), e.brick.pos[1], clean(e.brick.pos[2] + d.dz)] as Vec3,
        }));
      get().updateBricks(patches);
    }
    for (const id of d.ids) {
      const e = entries.get(id);
      if (e) applyTransform(e); // revert preview (or apply the committed brick)
    }
    refreshLooks();
    updateSelectionHelpers();
    hoverDirty = true;
    dirty = true;
  }

  // ------------------------------------------------------------------ camera
  const reducedMotion = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };
  const coarsePointer = () => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  };

  /** Animated camera move (ease-out cubic): orbit offset in spherical coords so presets swing around the target. */
  interface CamAnim {
    mode: ViewMode;
    t0: number;
    dur: number;
    fromT: THREE.Vector3;
    toT: THREE.Vector3;
    fromS: THREE.Spherical;
    toS: THREE.Spherical;
    fromZoom: number;
    toZoom: number;
  }
  let camAnim: CamAnim | null = null;
  let autoFrameReq = false;

  function cancelCamAnim() {
    if (!camAnim) return;
    camAnim = null;
    controls3d.enableDamping = true;
    controls2d.enableDamping = true;
  }

  function animate3d(toTarget: THREE.Vector3, toPos: THREE.Vector3, dur = 300) {
    cancelCamAnim();
    if (dur <= 0 || viewMode !== '3d' || reducedMotion()) {
      controls3d.target.copy(toTarget);
      persp.position.copy(toPos);
      controls3d.update();
      dirty = true;
      return;
    }
    const fromS = new THREE.Spherical().setFromVector3(persp.position.clone().sub(controls3d.target));
    const toS = new THREE.Spherical().setFromVector3(toPos.clone().sub(toTarget));
    let dth = toS.theta - fromS.theta;
    while (dth > Math.PI) dth -= Math.PI * 2;
    while (dth < -Math.PI) dth += Math.PI * 2;
    toS.theta = fromS.theta + dth;
    camAnim = {
      mode: '3d', t0: performance.now(), dur, fromT: controls3d.target.clone(), toT: toTarget.clone(), fromS, toS,
      fromZoom: 1, toZoom: 1,
    };
    controls3d.enableDamping = false; // no leftover orbit inertia fighting the animation
    dirty = true;
  }

  function animate2d(toTarget: THREE.Vector3, toZoom: number, dur = 300) {
    cancelCamAnim();
    const z = THREE.MathUtils.clamp(toZoom, controls2d.minZoom, controls2d.maxZoom);
    if (dur <= 0 || viewMode !== '2d' || reducedMotion()) {
      controls2d.target.set(toTarget.x, 0, toTarget.z);
      ortho.position.set(toTarget.x, CAM_2D_HEIGHT, toTarget.z);
      ortho.zoom = z;
      ortho.updateProjectionMatrix();
      controls2d.update();
      dirty = true;
      return;
    }
    camAnim = {
      mode: '2d', t0: performance.now(), dur, fromT: controls2d.target.clone(), toT: new THREE.Vector3(toTarget.x, 0, toTarget.z),
      fromS: new THREE.Spherical(), toS: new THREE.Spherical(), fromZoom: ortho.zoom, toZoom: z,
    };
    controls2d.enableDamping = false;
    dirty = true;
  }

  function stepCamAnim(now: number) {
    const a = camAnim;
    if (!a) return;
    if (a.mode !== viewMode) {
      cancelCamAnim();
      return;
    }
    const k = Math.min(1, (now - a.t0) / a.dur);
    const e = 1 - (1 - k) ** 3;
    const L = THREE.MathUtils.lerp;
    if (a.mode === '3d') {
      controls3d.target.lerpVectors(a.fromT, a.toT, e);
      const sp = new THREE.Spherical(L(a.fromS.radius, a.toS.radius, e), L(a.fromS.phi, a.toS.phi, e), L(a.fromS.theta, a.toS.theta, e));
      persp.position.setFromSpherical(sp).add(controls3d.target);
    } else {
      controls2d.target.lerpVectors(a.fromT, a.toT, e);
      ortho.position.set(controls2d.target.x, CAM_2D_HEIGHT, controls2d.target.z);
      ortho.zoom = L(a.fromZoom, a.toZoom, e);
      ortho.updateProjectionMatrix();
    }
    dirty = true;
    if (k >= 1) cancelCamAnim();
  }

  /** The part of the canvas not covered by UI (CSS px, canvas-local). */
  function safeRect() {
    const W = Math.max(1, canvas.clientWidth);
    const H = Math.max(1, canvas.clientHeight);
    const l = THREE.MathUtils.clamp(insets.left, 0, W * 0.45);
    const r = THREE.MathUtils.clamp(insets.right, 0, W * 0.45);
    const t = THREE.MathUtils.clamp(insets.top, 0, H * 0.45);
    const b = THREE.MathUtils.clamp(insets.bottom, 0, H * 0.45);
    return { x: l, y: t, w: Math.max(40, W - l - r), h: Math.max(40, H - t - b), W, H };
  }

  /** Camera right / up (three world) for a view direction (target → camera). */
  function viewBasis(d: THREE.Vector3) {
    const fwd = d.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    return { right, up };
  }

  /** Fit `box` (three world) into the uncovered part of the screen, looking along `dir`. */
  function fitPersp(dir?: THREE.Vector3, animate = false, box = modelBoxThree()) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = (dir ?? persp.position.clone().sub(controls3d.target)).normalize();
    if (d.lengthSq() < 0.5) d.set(1, 0.85, 1).normalize();
    const sr = safeRect();
    const tv = Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2);
    const t = Math.min(tv * (sr.h / sr.H), tv * persp.aspect * (sr.w / sr.W));
    const dist = Math.max(60, (Math.max(sphere.radius, 12) / Math.sin(Math.atan(t))) * 1.08);
    // centre the model in the safe rect, not the canvas
    const wpp = (2 * tv * dist) / sr.H;
    const ox = sr.x + sr.w / 2 - sr.W / 2;
    const oy = sr.y + sr.h / 2 - sr.H / 2;
    const { right, up } = viewBasis(d);
    const target = sphere.center.clone().addScaledVector(right, -ox * wpp).addScaledVector(up, oy * wpp);
    persp.far = Math.max(30000, dist + sphere.radius * 10);
    persp.updateProjectionMatrix();
    animate3d(target, target.clone().addScaledVector(d, dist), animate ? 300 : 0);
  }

  function fitOrtho(animate = false, box = modelBoxThree()) {
    const sr = safeRect();
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const halfW = ortho.right;
    const halfH = ortho.top;
    const zoom = THREE.MathUtils.clamp(
      0.9 * Math.min((2 * halfW * (sr.w / sr.W)) / Math.max(s.x, 60), (2 * halfH * (sr.h / sr.H)) / Math.max(s.z, 60)),
      controls2d.minZoom, controls2d.maxZoom,
    );
    // ortho camera: screen right = +X, screen down = +Z
    const wpp = (2 * halfH) / zoom / sr.H;
    const ox = sr.x + sr.w / 2 - sr.W / 2;
    const oy = sr.y + sr.h / 2 - sr.H / 2;
    animate2d(new THREE.Vector3(c.x - ox * wpp, 0, c.z - oy * wpp), zoom, animate ? 300 : 0);
  }

  function zoomToFit(animate = false) {
    if (viewMode === '2d') fitOrtho(animate);
    else fitPersp(undefined, animate);
    dirty = true;
  }

  /** Frame the pending brick(s), else the selection, else everything. */
  function frameSelection() {
    const items = pendingItems() ?? selectionItems();
    const box = items.length ? ldToThreeBox(unionBox(items)) : modelBoxThree();
    if (viewMode === '2d') fitOrtho(true, box);
    else fitPersp(undefined, true, box);
  }

  /** Orbit around `box` without zooming (double-tap a brick). */
  function focusBox(box: THREE.Box3) {
    const c = box.getCenter(new THREE.Vector3());
    if (viewMode === '2d') {
      animate2d(c, ortho.zoom, 300);
      return;
    }
    const delta = c.clone().sub(controls3d.target);
    animate3d(c, persp.position.clone().add(delta), 300);
  }

  /** View cube tap: snap to that face (keeping the distance); the face you already look at, an edge or a corner = fit. */
  function cubeTap(dir: THREE.Vector3) {
    if (viewMode !== '3d') return;
    const d = dir.clone();
    const axes = Math.abs(Math.sign(d.x)) + Math.abs(Math.sign(Math.round(d.y * 1000))) + Math.abs(Math.sign(d.z));
    if (d.y < -0.1) d.y = axes === 1 ? 1 : -d.y; // no views from below the baseplate
    if (axes === 1 && Math.abs(d.y) < 0.1) d.y = 0.12; // side views: a little from above, like the presets
    if (axes === 1 && d.y > 0.9) d.set(0, 1, 0.001);
    d.normalize();
    const cur = persp.position.clone().sub(controls3d.target).normalize();
    if (axes > 1 || cur.angleTo(d) < 0.06) {
      fitPersp(d, true);
      return;
    }
    const dist = persp.position.distanceTo(controls3d.target);
    animate3d(controls3d.target.clone(), controls3d.target.clone().addScaledVector(d, dist), 300);
  }

  /** Keep the pending / selected brick inside the uncovered screen area (pan only, 250 ms). */
  function autoFrame() {
    autoFrameReq = false;
    if (camAnim || pointers.size || !container) return;
    const st = get();
    const items = pendingItems() ?? (st.tool === 'select' ? selectionItems() : []);
    if (!items.length) return;
    const tb = ldToThreeBox(unionBox(items));
    const cam = activeCamera();
    cam.updateMatrixWorld();
    const sr = safeRect();
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? tb.max.x : tb.min.x, i & 2 ? tb.max.y : tb.min.y, i & 4 ? tb.max.z : tb.min.z).project(cam);
      if (v.z > 1 || v.z < -1) return; // behind the camera: leave it alone
      const sx = ((v.x + 1) / 2) * sr.W;
      const sy = ((1 - v.y) / 2) * sr.H;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    const M = Math.min(coarsePointer() ? 72 : 24, sr.w / 4, sr.h / 4);
    const L = sr.x + M; const R = sr.x + sr.w - M; const T = sr.y + M; const B = sr.y + sr.h - M;
    const shift = (lo: number, hi: number, a: number, b: number) =>
      hi - lo > b - a ? (a + b) / 2 - (lo + hi) / 2 : lo < a ? a - lo : hi > b ? b - hi : 0;
    const dx = shift(minX, maxX, L, R);
    const dy = shift(minY, maxY, T, B);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    if (viewMode === '2d') {
      const wpp = (ortho.top - ortho.bottom) / ortho.zoom / sr.H;
      animate2d(new THREE.Vector3(controls2d.target.x - dx * wpp, 0, controls2d.target.z - dy * wpp), ortho.zoom, 250);
      return;
    }
    const c = tb.getCenter(new THREE.Vector3());
    const fwd = persp.getWorldDirection(new THREE.Vector3());
    const dist = Math.max(1, c.clone().sub(persp.position).dot(fwd));
    const wpp = (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) * dist) / sr.H;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(persp.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(persp.quaternion);
    const delta = right.multiplyScalar(-dx * wpp).addScaledVector(up, dy * wpp);
    animate3d(controls3d.target.clone().add(delta), persp.position.clone().add(delta), 250);
  }

  const PRESETS: Record<'iso' | 'front' | 'side' | 'top', THREE.Vector3> = {
    iso: new THREE.Vector3(1, 0.85, 1.15),
    front: new THREE.Vector3(0, 0.12, 1),
    side: new THREE.Vector3(1, 0.12, 0),
    top: new THREE.Vector3(0, 1, 0.001),
  };

  // ------------------------------------------------------------------ rotate
  /** Rotate around the vertical axis by `step` degrees (default 90) — the pending brick(s), else ghost, else selection. */
  function rotate(dir: 1 | -1 = 1, step = 90) {
    const st = get();
    if (st.readOnly || handleDrag) return;
    const R = step === 90 ? rotY90(dir) : rotYDeg(dir * step);
    if (dup) {
      setPendingItems(rotateItems(dup.items, R));
      return;
    }
    if (st.tool === 'place' && pending && ghost) {
      const [it] = rotateItems([pendingItem()!], R);
      pending.pos = it.pos;
      pending.rot = it.rot;
      showPending();
      return;
    }
    if (st.tool === 'place' && ghost) {
      ghostRot = normRot(mulMat3(R, ghostRot));
      if (hoverXY) placeGhostAt(hoverXY.x, hoverXY.y);
      dirty = true;
      return;
    }
    const sel = selectionItems();
    if (!sel.length || drag) return;
    const next = rotateItems(sel, R);
    if (itemsBlocked(next, new Set(sel.map((s) => s.id!)))) return;
    st.updateBricks(next.map((n) => ({ id: n.id!, pos: n.pos, rot: n.rot })));
  }

  // ------------------------------------------------------------------ micro-animations
  function addPop(id: string | null, from: number, dur: number) {
    if (reducedMotion()) return;
    const i = pops.findIndex((p) => p.id === id);
    if (i >= 0) pops.splice(i, 1);
    pops.push({ id, from, t0: performance.now(), dur });
    dirty = true;
  }

  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  /** Brick transform scaled by `s` around the centre of its body. */
  function scaledAbout(rot: Mat3, pos: Vec3, body: THREE.Box3, s: number, out: THREE.Matrix4) {
    const c = body.getCenter(tmpV);
    mat4From(rot, pos, out);
    out.multiply(tmpM.makeTranslation(c.x, c.y, c.z));
    out.multiply(tmpM.makeScale(s, s, s));
    out.multiply(tmpM.makeTranslation(-c.x, -c.y, -c.z));
  }

  function stepPops(now: number) {
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      const k = Math.min(1, (now - p.t0) / p.dur);
      const s = p.from + (1 - p.from) * (1 - (1 - k) ** 3);
      if (p.id === null) {
        if (!pending || !ghost || shakeUntil) {
          pops.splice(i, 1);
          continue;
        }
        scaledAbout(pending.rot, pending.pos, ghost.tpl.body, s, ghost.built.group.matrix);
        ghost.built.group.matrixWorldNeedsUpdate = true;
      } else {
        const e = entries.get(p.id);
        const busy = (drag?.idSet.has(p.id)) || (handleDrag?.idSet.has(p.id));
        if (!e?.built || !e.tpl || busy) {
          pops.splice(i, 1);
          continue;
        }
        scaledAbout(e.brick.rot, e.brick.pos, e.tpl.body, s, e.built.group.matrix);
        e.built.group.matrixWorldNeedsUpdate = true;
      }
      if (k >= 1) pops.splice(i, 1);
      dirty = true;
    }
  }

  function stepShake(now: number) {
    const left = shakeUntil - now;
    if (left <= 0 || (!dup && (!pending || !ghost))) {
      shakeUntil = 0;
      if (dup) showDup();
      else if (pending) showPending();
      return;
    }
    const off = Math.sin(left / 18) * 4 * (left / 360);
    if (dup) {
      dup.items.forEach((it, i) => {
        const g = dup!.pieces[i].built.group;
        mat4From(it.rot, [it.pos[0] + off, it.pos[1], it.pos[2]], g.matrix);
        g.matrixWorldNeedsUpdate = true;
      });
    } else if (pending && ghost) {
      const p = pending.pos;
      mat4From(pending.rot, [p[0] + off, p[1], p[2]], ghost.built.group.matrix);
      ghost.built.group.matrixWorldNeedsUpdate = true;
    }
    dirty = true;
  }

  // ------------------------------------------------------------------ footprint (snapping feedback)
  let modelVersion = 0;

  function footprintItems(): { items: Item[]; ignore?: Set<string>; isPending: boolean } | null {
    if (handleDrag) return { items: handleDrag.preview, ignore: handleDrag.idSet, isPending: handleDrag.kind === 'pending' };
    const pi = pendingItems();
    if (pi) return { items: pi, isPending: true };
    if (drag?.active) {
      const items: Item[] = [];
      for (const id of drag.ids) {
        const e = entries.get(id);
        if (e?.tpl) items.push({ id, tpl: e.tpl, rot: e.brick.rot, pos: [e.brick.pos[0] + drag.dx, e.brick.pos[1], e.brick.pos[2] + drag.dz] });
      }
      return { items, ignore: drag.idSet, isPending: false };
    }
    if (ghost && ghostPlacement && ghost.built.group.visible && get().tool === 'place') {
      return { items: [{ id: null, tpl: ghost.tpl, pos: ghostPlacement.pos, rot: ghostRot }], isPending: false };
    }
    return null;
  }

  /**
   * Footprint of the manipulated brick(s) on the first surface below, white dots on the studs it
   * will connect to, a drop line when floating. Recomputed only when the bricks or the model change.
   */
  function updateFootprint() {
    const f = footprintItems();
    if (!f || !f.items.length) {
      if (footKey) {
        footKey = '';
        footprint.hide();
      }
      if (!dup && !pending) setFloating(false);
      return;
    }
    const key = `${modelVersion}|${viewMode}|${f.items.map((it) => `${it.pos.join(',')}/${it.rot.join(',')}`).join(';')}`;
    if (key === footKey) return;
    footKey = key;
    const solids = f.items.map(itemSolid);
    const lowest = Math.max(...solids.map((s) => s.box.max.y)); // LDraw: larger y = lower
    const rects: FootRect[] = [];
    const dots: Array<[number, number, number]> = [];
    let floats = true;
    const inside = (s: (typeof solids)[number], x: number, z: number) => {
      if (!s.obb) return x > s.box.min.x + 1 && x < s.box.max.x - 1 && z > s.box.min.z + 1 && z < s.box.max.z - 1;
      const o = s.obb;
      const dx = x - o.cx;
      const dz = z - o.cz;
      return Math.abs(dx * o.ux + dz * o.uz) < o.hx - 1 && Math.abs(dx * o.vx + dz * o.vz) < o.hz - 1;
    };
    for (const s of solids) {
      const b = s.box;
      const bottom = b.max.y;
      if (bottom < lowest - 0.5) continue; // upper members of a group rest on the group itself
      const probe = { box: b.clone(), obb: s.obb };
      probe.box.min.y = -1e9;
      probe.box.max.y = 1e9;
      let surf = 0; // ground
      let under: Entry[] = [];
      for (const [id, e] of entries) {
        if (!e.solid || f.ignore?.has(id) || e.look === 'hidden') continue;
        const top = e.solid.box.min.y;
        if (top < bottom - 0.5 || top > surf + 0.5) continue; // above the brick / lower than the best so far
        if (!solidsOverlap(probe, e.solid)) continue;
        if (top < surf - 0.5) {
          surf = top;
          under = [];
        }
        under.push(e);
      }
      if (surf - bottom <= 0.5) floats = false;
      const onBrick = under.length > 0;
      const rect: FootRect = s.obb
        ? { cx: s.obb.cx, cz: -s.obb.cz, hx: s.obb.hx, hz: s.obb.hz, heading: Math.atan2(s.obb.uz, s.obb.ux), surfaceY: -surf + 0.4, bottomY: -bottom }
        : {
          cx: (b.min.x + b.max.x) / 2, cz: -(b.min.z + b.max.z) / 2, hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2,
          heading: 0, surfaceY: -surf + (onBrick ? 0.4 : 0.3), bottomY: -bottom,
        };
      rects.push(rect);
      if (dots.length > 500) continue;
      if (!onBrick) {
        for (let x = Math.floor(b.min.x / 20) * 20 + 10; x < b.max.x; x += 20) {
          for (let z = Math.floor(b.min.z / 20) * 20 + 10; z < b.max.z; z += 20) {
            if (Math.abs(x) < BASE_SIZE / 2 && Math.abs(z) < BASE_SIZE / 2 && inside(s, x, z)) dots.push([x, 0.6, -z]);
          }
        }
      } else {
        for (const e of under) {
          if (!e.solid || e.solid.obb) continue;
          const eb = e.solid.box;
          for (let x = eb.min.x + 10; x < eb.max.x; x += 20) {
            for (let z = eb.min.z + 10; z < eb.max.z; z += 20) {
              if (inside(s, x, z)) dots.push([x, -surf + 4.6, -z]);
            }
          }
        }
      }
    }
    footprint.update(viewMode === '3d' ? rects : [], viewMode === '3d' ? dots : []);
    if (f.isPending) setFloating(floats);
    else if (!dup && !pending) setFloating(false);
  }

  // ------------------------------------------------------------------ outlines & view cube
  const tmpBox = new THREE.Box3();
  const outlineBox = new THREE.Box3();

  function renderOutlines(cam: THREE.Camera, now: number) {
    const sets: OutlineSet[] = [];
    outlineBox.makeEmpty();
    const add = (objs: THREE.Object3D[], channel: 0 | 1 | 2) => { if (objs.length) sets.push({ objects: objs, channel }); };
    const boxOf = (tplBox: THREE.Box3, m: THREE.Matrix4) => {
      outlineBox.union(ldToThreeBox(tmpBox.copy(tplBox).applyMatrix4(m), tmpBox));
    };
    const sel: THREE.Object3D[] = [];
    for (const id of selectionSet) {
      const e = entries.get(id);
      if (!e?.built || !e.tpl || e.look === 'hidden') continue;
      sel.push(e.built.group);
      boxOf(e.tpl.box, e.built.group.matrix);
    }
    add(sel, 0);
    let fade = 0;
    if (recent) {
      fade = 1 - (now - recent.t0) / RECENT_MS;
      const rec: THREE.Object3D[] = [];
      for (const id of recent.ids) {
        const e = entries.get(id);
        if (!e?.built || !e.tpl || e.look === 'hidden' || selectionSet.has(id)) continue;
        rec.push(e.built.group);
        boxOf(e.tpl.box, e.built.group.matrix);
      }
      add(rec, 1);
    }
    const gh: THREE.Object3D[] = [];
    if (dup) {
      for (const pc of dup.pieces) {
        gh.push(pc.built.group);
        boxOf(pc.tpl.box, pc.built.group.matrix);
      }
    } else if (pending && ghost?.built.group.visible) {
      gh.push(ghost.built.group);
      boxOf(ghost.tpl.box, ghost.built.group.matrix);
    }
    add(gh, 2);
    if (!sets.length) return;
    // scissor rectangle: projected bounds + the outline width
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    let behind = false;
    for (let i = 0; i < 8 && !behind; i++) {
      tmpV.set(i & 1 ? outlineBox.max.x : outlineBox.min.x, i & 2 ? outlineBox.max.y : outlineBox.min.y, i & 4 ? outlineBox.max.z : outlineBox.min.z).project(cam);
      if (tmpV.z > 1 || tmpV.z < -1) behind = true;
      const sx = ((tmpV.x + 1) / 2) * W;
      const sy = ((1 - tmpV.y) / 2) * H;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    if (!behind) {
      if (maxX < -10 || minX > W + 10 || maxY < -10 || minY > H + 10) return; // off screen
      rect = { x: minX - 10, y: minY - 10, w: maxX - minX + 20, h: maxY - minY + 20 };
    }
    root.updateMatrixWorld();
    outline.render(renderer, scene, cam, sets, { fade: Math.max(0, fade), blocked: pendingState().blocked, rect });
  }

  function layoutCube() {
    const W = canvas.clientWidth;
    viewCube.x = Math.max(0, W - Math.max(0, insets.right) - 10 - viewCube.size);
    viewCube.y = Math.max(0, insets.top) + 10;
    viewCube.visible = viewMode === '3d' && !!container;
    dirty = true;
  }

  // ------------------------------------------------------------------ loop
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    if (hoverDirty) processHover();
    stepCamAnim(now);
    if (shakeUntil) stepShake(now);
    if (pops.length) stepPops(now);
    if (recent) {
      if (now - recent.t0 >= RECENT_MS) recent = null;
      dirty = true;
    }
    const ctl = viewMode === '2d' ? controls2d : controls3d;
    if (ctl.update()) dirty = true;
    if (autoFrameReq && !pointers.size && !camAnim && !handleDrag) autoFrame();
    if (dirty) {
      dirty = false;
      const cam = activeCamera();
      refreshGizmo();
      updateFootprint();
      helpers.visible = false;
      renderer.render(scene, cam);
      renderOutlines(cam, now);
      helpers.visible = true;
      const size = renderer.getSize(new THREE.Vector2());
      if (gizmo.group.visible) {
        renderer.autoClear = false;
        renderer.render(helpers, cam); // gizmo on top of everything, outlines included
        renderer.autoClear = true;
      }
      if (viewCube.visible) {
        viewCube.sync(persp);
        viewCube.render(renderer, size.x, size.y);
      }
    }
  }

  function onStoreChange(s: ReturnType<typeof get>, p: ReturnType<typeof get>) {
    if (disposed) return;
    if (handleDrag?.kind === 'selection' && (s.model !== p.model || s.selection !== p.selection || s.tool !== p.tool)) {
      endHandleDrag(false);
    }
    if (handleDrag?.kind === 'pending' && (s.tool !== p.tool || s.readOnly)) endHandleDrag(false);
    if (pending && (s.tool !== 'place' || s.readOnly)) cancelPending();
    if (dup && (s.tool !== p.tool || s.readOnly)) cancelPending();
    if (dup && s.activeColor !== p.activeColor) {
      for (const pc of dup.pieces) {
        pc.color = s.activeColor;
        lib.recolor(pc.built.nodes, pc.color, pc.look);
      }
    }
    if (s.model !== p.model) syncModel(s.model.bricks);
    if (s.selection !== p.selection) {
      selectionSet = new Set(s.selection);
      refreshLooks();
      updateSelectionHelpers();
      if (s.selection.length) autoFrameReq = true;
    }
    if (s.viewMode !== p.viewMode) applyViewMode(s.viewMode);
    else if (s.layerY !== p.layerY && s.viewMode === '2d') {
      positionLayerGrid();
      refreshLooks();
      updateSelectionHelpers();
    }
    if (s.readOnly !== p.readOnly && s.readOnly) {
      if (drag) cancelPress();
      setHoverErase(null);
    }
    if (s.tool !== p.tool || s.activePart !== p.activePart || s.activeColor !== p.activeColor || s.readOnly !== p.readOnly) {
      if (s.tool !== 'erase') setHoverErase(null);
      updateGhostObject();
    }
    hoverDirty = true;
    dirty = true;
  }

  // ------------------------------------------------------------------ public API
  const engine: BrickyardEngine = {
    mount(el: HTMLElement) {
      if (disposed) return;
      if (container === el && canvas.parentElement === el) return;
      ro?.disconnect();
      container = el;
      el.appendChild(canvas);
      if (!angleLabel.isConnected) document.body.appendChild(angleLabel);
      ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      if (!unsub) {
        const st = get();
        viewMode = st.viewMode;
        selectionSet = new Set(st.selection);
        persp.position.copy(PRESETS.iso).normalize().multiplyScalar(520);
        controls3d.target.set(0, 20, 0);
        persp.position.add(controls3d.target);
        controls3d.update();
        fitPending = st.model.bricks.length > 0;
        syncModel(st.model.bricks);
        applyViewMode(viewMode);
        updateGhostObject();
        unsub = useEditor.subscribe(onStoreChange);
      }
      if (!raf) raf = requestAnimationFrame(frame);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      unsub?.();
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      controls3d.dispose();
      controls2d.dispose();
      clearLongPress();
      removeDup();
      removeGhost();
      for (const e of entries.values()) destroyObject(e);
      entries.clear();
      loadingListeners.clear();
      pendingListeners.clear();
      blockedListeners.clear();
      feedbackListeners.clear();
      thumbs.dispose();
      modelRenderer.dispose();
      lib.dispose();
      for (const o of owned) o.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      angleLabel.remove();
      container = null;
    },

    rotate,
    zoomToFit: () => zoomToFit(true),

    setCameraPreset(p) {
      const dir = PRESETS[p]?.clone();
      if (!dir) return;
      fitPersp(dir, true);
      dirty = true;
    },

    renderThumbnail(partId, color, size = 96) {
      if (disposed) return Promise.reject(new Error('engine disposed'));
      return thumbs.render(partId, color, size);
    },

    renderModel(bricks, o) {
      if (disposed) return Promise.reject(new Error('engine disposed'));
      return modelRenderer.render(bricks, o);
    },

    async screenshot(width, height) {
      const ghostVis = ghost?.built.group.visible ?? false;
      if (ghost) ghost.built.group.visible = false;
      for (const pc of dup?.pieces ?? []) pc.built.group.visible = false;
      helpers.visible = false;
      footprint.group.visible = false;
      const cam = activeCamera();
      let url: string;
      if (width && height) {
        const size = renderer.getSize(new THREE.Vector2());
        const pr = renderer.getPixelRatio();
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        setAspect(width / height);
        renderer.render(scene, cam);
        url = canvas.toDataURL('image/png');
        renderer.setPixelRatio(pr);
        renderer.setSize(size.x, size.y, false);
        setAspect(size.x / Math.max(1, size.y));
      } else {
        renderer.render(scene, cam);
        url = canvas.toDataURL('image/png');
      }
      if (ghost) ghost.built.group.visible = ghostVis;
      for (const pc of dup?.pieces ?? []) pc.built.group.visible = true;
      helpers.visible = true;
      footKey = ''; // re-show the footprint on the next frame
      dirty = true;
      return url;
    },

    getPending: pendingState,
    confirmPending,
    cancelPending,
    nudge,
    onPendingChange(cb) {
      pendingListeners.add(cb);
      return () => { pendingListeners.delete(cb); };
    },
    onPlaceBlocked(cb) {
      blockedListeners.add(cb);
      return () => { blockedListeners.delete(cb); };
    },

    onLoading(cb) {
      loadingListeners.add(cb);
      cb(lib.pendingCount);
      return () => { loadingListeners.delete(cb); };
    },

    duplicateSelection,
    frameSelection,
    setInsets(i) {
      const n = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
      const next = { top: n(i.top), bottom: n(i.bottom), left: n(i.left), right: n(i.right) };
      if (next.top === insets.top && next.bottom === insets.bottom && next.left === insets.left && next.right === insets.right) return;
      insets = next;
      layoutCube();
      autoFrameReq = true;
    },
    onFeedback(cb) {
      feedbackListeners.add(cb);
      return () => { feedbackListeners.delete(cb); };
    },
    setAddMode(on) {
      addMode = !!on;
    },
    isFloating: () => floating,
  };

  // Dev-only inspection hook for manual / automated gizmo testing (stripped from production builds).
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__brickyardDebug = {
      gizmo: () => { refreshGizmo(); return gizmoInfo; },
      pending: () => (pending ? { ...pending } : null),
      dup: () => (dup ? dup.items.map((it) => ({ pos: it.pos, rot: it.rot })) : null),
      floating: () => floating,
      cube: () => ({ x: viewCube.x, y: viewCube.y, size: viewCube.size, visible: viewCube.visible }),
      camera: () => ({ pos: persp.position.toArray(), target: controls3d.target.toArray(), zoom: ortho.zoom, anim: !!camAnim }),
      insets: () => ({ ...insets }),
      footprint: () => footprint.group.visible,
      engine,
      modelTiming: () => ({ ...modelRenderer.lastTiming }),
    };
  }

  return engine;
}
