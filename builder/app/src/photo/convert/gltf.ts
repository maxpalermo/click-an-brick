// GLB -> TriangleMesh via three's GLTFLoader, without any DOM: textures are decoded by an injected decoder
// (browser worker: createImageBitmap + OffscreenCanvas; Node tests: sharp) through a GLTFLoader plugin that
// replaces the default ImageBitmapLoader / ImageLoader path. Supports node hierarchies, quantized and
// interleaved attributes, COLOR_0, baseColorFactor, baseColorTexture (any TEXCOORD_n, KHR_texture_transform),
// meshopt (built in) and Draco (when the environment provides a DRACOLoader).

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { buildMesh, type MeshMaterial, type PrimitiveInput, type RgbaImage, type TriangleMesh } from './mesh';

export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<RgbaImage>;

export interface GltfEnv {
  decodeImage: ImageDecoder;
  /** Needed only for KHR_draco_mesh_compression files. */
  draco?: () => DRACOLoader;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Read the GLB JSON chunk (cheap) to see which extensions are used. */
export function glbExtensions(glb: ArrayBuffer): string[] {
  const dv = new DataView(glb);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB has no JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, len)));
  return json.extensionsUsed ?? [];
}

const isRgba = (x: unknown): x is RgbaImage =>
  !!x && typeof (x as RgbaImage).width === 'number' && !!(x as RgbaImage).data;

export async function loadGlbMesh(glb: ArrayBuffer, env: GltfEnv): Promise<TriangleMesh> {
  const used = glbExtensions(glb);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (used.includes('KHR_draco_mesh_compression')) {
    if (!env.draco) throw new Error('Draco-compressed GLB, but no Draco decoder is available here');
    loader.setDRACOLoader(env.draco());
  }
  if (used.includes('KHR_texture_basisu')) console.warn('[photo] KTX2 textures are not decoded; base colours only');

  // Texture plugin: decode embedded images ourselves into RGBA8 so we can sample texels.
  // It must run before three's built-in EXT_texture_webp/avif plugins (registered in the
  // constructor), which would otherwise load the image via DOM Image (absent in workers/Node).
  const register = (cb: (parser: Json) => any) => (loader as unknown as { pluginCallbacks: unknown[] }).pluginCallbacks.unshift(cb);
  register((parser: Json): any => {
    const cache = new Map<number, Promise<THREE.Texture | null>>();
    return {
      name: 'brickyard_texel_decoder',
      loadTexture(textureIndex: number) {
        const json = parser.json;
        const td = json.textures[textureIndex];
        const src: number | undefined = td.source ?? td.extensions?.EXT_texture_webp?.source ?? td.extensions?.EXT_texture_avif?.source;
        if (src === undefined) return Promise.resolve(null);
        if (!cache.has(src)) {
          const img = json.images[src];
          const p = (async () => {
            let bytes: Uint8Array;
            let mime: string = img.mimeType ?? 'image/png';
            if (img.bufferView !== undefined) {
              bytes = new Uint8Array(await parser.getDependency('bufferView', img.bufferView));
            } else if (typeof img.uri === 'string' && img.uri.startsWith('data:')) {
              const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(img.uri);
              if (!m) return null;
              mime = m[1] ?? mime;
              bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
            } else return null; // external URIs: not used in GLB results
            if (mime === 'image/ktx2') return null;
            const rgba = await env.decodeImage(bytes, mime);
            const tex = new THREE.Texture();
            tex.image = rgba;
            return tex;
          })().catch((e) => { console.warn('[photo] texture decode failed', e); return null; });
          cache.set(src, p);
        }
        return cache.get(src)!.then((t) => {
          if (!t) return null;
          const c = t.clone();
          c.flipY = false;
          return c;
        });
      },
    };
  });

  const gltf = await loader.parseAsync(glb, '');
  const scene = gltf.scene ?? gltf.scenes?.[0];
  if (!scene) throw new Error('GLB has no scene');
  scene.updateMatrixWorld(true);

  const materials: MeshMaterial[] = [];
  const matIndex = new Map<THREE.Material, number>();
  const texUvChannel = new Map<number, number>();
  const texMatrix = new Map<number, THREE.Matrix3 | null>();
  const getMat = (m: THREE.Material): number => {
    let i = matIndex.get(m);
    if (i !== undefined) return i;
    const mm = m as THREE.MeshStandardMaterial;
    const c = mm.color ?? new THREE.Color(1, 1, 1); // linear working space
    const map = mm.map;
    const rgba = map && isRgba(map.image) ? (map.image as RgbaImage) : null;
    i = materials.length;
    materials.push({ baseColorFactor: [c.r, c.g, c.b, mm.opacity ?? 1], texture: rgba });
    matIndex.set(m, i);
    if (rgba && map) {
      texUvChannel.set(i, map.channel ?? 0);
      map.updateMatrix();
      const isIdentity = map.matrix.elements.every((v, k) => v === [1, 0, 0, 0, 1, 0, 0, 0, 1][k]);
      texMatrix.set(i, isIdentity ? null : map.matrix.clone());
    }
    return i;
  };
  const defaultMat = { m: null as number | null };

  const prims: PrimitiveInput[] = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const nv = pos.count;
    const world = new Float32Array(nv * 3);
    const mw = mesh.matrixWorld;
    for (let k = 0; k < nv; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mw);
      world[k * 3] = v.x; world[k * 3 + 1] = v.y; world[k * 3 + 2] = v.z;
    }
    const flip = mw.determinant() < 0;
    const idxAttr = geo.getIndex();
    const allIdx = new Uint32Array(idxAttr ? idxAttr.count : nv);
    for (let k = 0; k < allIdx.length; k++) allIdx[k] = idxAttr ? idxAttr.getX(k) : k;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: allIdx.length, materialIndex: 0 }];
    const colAttr = geo.getAttribute('color');

    for (const gr of groups) {
      const m = mats[gr.materialIndex ?? 0] ?? mats[0];
      let mi: number;
      if (m) mi = getMat(m);
      else {
        if (defaultMat.m === null) { defaultMat.m = materials.length; materials.push({ baseColorFactor: [0.8, 0.8, 0.8, 1], texture: null }); }
        mi = defaultMat.m;
      }
      const start = gr.start, end = Math.min(allIdx.length, gr.start + gr.count);
      const indices = new Uint32Array(Math.floor((end - start) / 3) * 3);
      for (let k = 0; k < indices.length; k += 3) {
        indices[k] = allIdx[start + k];
        indices[k + 1] = allIdx[start + k + (flip ? 2 : 1)];
        indices[k + 2] = allIdx[start + k + (flip ? 1 : 2)];
      }
      let uvs: Float32Array | null = null;
      if (materials[mi].texture) {
        const ch = texUvChannel.get(mi) ?? 0;
        const uvAttr = geo.getAttribute(ch === 0 ? 'uv' : `uv${ch}`) ?? geo.getAttribute('uv');
        if (uvAttr) {
          uvs = new Float32Array(nv * 2);
          const tm = texMatrix.get(mi);
          const e = tm?.elements;
          for (let k = 0; k < nv; k++) {
            let s = uvAttr.getX(k), t = uvAttr.getY(k);
            if (e) { const s2 = e[0] * s + e[3] * t + e[6]; t = e[1] * s + e[4] * t + e[7]; s = s2; }
            uvs[k * 2] = s; uvs[k * 2 + 1] = t;
          }
        }
      }
      let colors: Float32Array | null = null;
      if (colAttr && (m as THREE.MeshStandardMaterial | undefined)?.vertexColors !== false) {
        colors = new Float32Array(nv * 4);
        const n4 = colAttr.itemSize >= 4;
        for (let k = 0; k < nv; k++) {
          colors[k * 4] = colAttr.getX(k); colors[k * 4 + 1] = colAttr.getY(k); colors[k * 4 + 2] = colAttr.getZ(k);
          colors[k * 4 + 3] = n4 ? colAttr.getW(k) : 1;
        }
      }
      prims.push({ positions: world, uvs, colors, indices, material: mi });
    }
  });
  if (!prims.length) throw new Error('GLB contains no triangle meshes');
  // a primitive with neither UVs nor colours while others have them gets neutral fill (buildMesh)
  return buildMesh(prims, materials);
}
