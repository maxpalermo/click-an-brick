// Screen-space silhouette outlines (docs/UX_REVIEW.md §3.3, §3.7):
//  R channel = selection  → white inner line · 2 px blue (#2D6FD6) · faint white halo (readable on any brick / background)
//  G channel = just placed → the same, fading out (600 ms "what landed" glow)
//  B channel = pending ghost → dashed white line with a dark halo (solid red when blocked)
// Cost: the masked objects are re-rendered into a CSS-pixel-sized mask (flat material, no shadows) and a
// small dilation shader runs — both scissored to the objects' screen rectangle, and only while something
// is outlined.
import * as THREE from 'three';

export const MASK_LAYER = 3;

export interface OutlineSet {
  objects: THREE.Object3D[];
  channel: 0 | 1 | 2;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 texel;
uniform float fade;
uniform float dpr;
uniform float blocked;
varying vec2 vUv;

vec4 over(vec4 top, vec4 bot) {
  float a = top.a + bot.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / a, a);
}

void main() {
  vec3 c = texture2D(tMask, vUv).rgb;
  vec3 n1 = vec3(0.0); vec3 n2 = vec3(0.0); vec3 n3 = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 d = vec2(cos(a), sin(a)) * texel;
    n1 = max(n1, texture2D(tMask, vUv + d * 1.25).rgb);
    n2 = max(n2, texture2D(tMask, vUv + d * 3.0).rgb);
    n3 = max(n3, texture2D(tMask, vUv + d * 4.5).rgb);
  }
  vec3 outside = 1.0 - smoothstep(0.35, 0.65, c);
  n1 = smoothstep(0.2, 0.6, n1) * outside;
  n2 = smoothstep(0.2, 0.6, n2) * outside;
  n3 = smoothstep(0.2, 0.6, n3) * outside;
  vec3 white = vec3(1.0);
  vec3 blue = vec3(0.176, 0.435, 0.839);

  // selection
  vec4 sel = over(vec4(white, n1.r), over(vec4(blue, n2.r), vec4(white, n3.r * 0.75)));
  // just placed (fading)
  vec4 rec = over(vec4(white, n1.g), vec4(blue, n2.g * 0.85));
  rec.a *= fade;
  // pending ghost: dashed white with a dark halo; solid red when blocked
  float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / (14.0 * dpr)));
  vec3 gcol = mix(white, vec3(0.86, 0.11, 0.24), blocked);
  float ga = n2.b * mix(dash, 1.0, blocked);
  vec4 gh = over(vec4(gcol, ga), vec4(vec3(0.07, 0.09, 0.15), n3.b * 0.35));

  vec4 o = over(sel, over(gh, rec));
  if (o.a < 0.01) discard;
  gl_FragColor = o;
}`;

export class Outline {
  private rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
  private mats = [0xff0000, 0x00ff00, 0x0000ff].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, toneMapped: false }));
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadGeo = new THREE.PlaneGeometry(2, 2);
  private mat: THREE.ShaderMaterial;
  private w = 1;
  private h = 1;
  private stash: Array<{ o: THREE.Mesh; m: THREE.Material | THREE.Material[]; layers: number }> = [];

  constructor() {
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.rt.texture.generateMipmaps = false;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tMask: { value: this.rt.texture },
        texel: { value: new THREE.Vector2(1, 1) },
        fade: { value: 1 },
        dpr: { value: 1 },
        blocked: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(this.quadGeo, this.mat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** CSS pixel size of the canvas. */
  setSize(w: number, h: number) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.rt.setSize(this.w, this.h);
    (this.mat.uniforms.texel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
  }

  /**
   * Draw outlines for `sets` over what is already in the canvas.
   * `rect` = CSS px rectangle (top-left origin) that contains everything outlined (null = whole canvas).
   */
  render(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, sets: OutlineSet[],
    opts: { fade: number; blocked: boolean; rect: { x: number; y: number; w: number; h: number } | null },
  ) {
    // swap materials of the meshes to outline and put them on the mask layer
    for (const s of sets) {
      const mat = this.mats[s.channel];
      for (const root of s.objects) {
        if (!root.visible) continue;
        root.traverseVisible((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          this.stash.push({ o: m, m: m.material, layers: m.layers.mask });
          m.material = mat;
          m.layers.enable(MASK_LAYER);
        });
      }
    }
    if (!this.stash.length) return;

    const r = opts.rect;
    const x = r ? Math.max(0, Math.floor(r.x)) : 0;
    const yTop = r ? Math.max(0, Math.floor(r.y)) : 0;
    const x2 = r ? Math.min(this.w, Math.ceil(r.x + r.w)) : this.w;
    const y2 = r ? Math.min(this.h, Math.ceil(r.y + r.h)) : this.h;
    const sw = x2 - x;
    const sh = y2 - yTop;
    const yb = this.h - y2; // bottom-left origin

    if (sw > 0 && sh > 0) {
      const camLayers = camera.layers.mask;
      const autoShadow = renderer.shadowMap.autoUpdate;
      const prevClear = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      const prevRT = renderer.getRenderTarget();
      const bg = scene.background;
      camera.layers.set(MASK_LAYER);
      renderer.shadowMap.autoUpdate = false;
      scene.background = null;
      this.rt.scissor.set(x, yb, sw, sh);
      this.rt.scissorTest = true;
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prevRT);
      renderer.setClearColor(prevClear, prevAlpha);
      scene.background = bg;
      renderer.shadowMap.autoUpdate = autoShadow;
      camera.layers.mask = camLayers;

      this.mat.uniforms.fade.value = opts.fade;
      this.mat.uniforms.blocked.value = opts.blocked ? 1 : 0;
      this.mat.uniforms.dpr.value = renderer.getPixelRatio();
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setScissor(x, yb, sw, sh);
      renderer.setScissorTest(true);
      renderer.render(this.quadScene, this.quadCam);
      renderer.setScissorTest(false);
      renderer.autoClear = autoClear;
    }

    for (const s of this.stash) {
      s.o.material = s.m;
      s.o.layers.mask = s.layers;
    }
    this.stash.length = 0;
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
    this.quadGeo.dispose();
    for (const m of this.mats) m.dispose();
  }
}
