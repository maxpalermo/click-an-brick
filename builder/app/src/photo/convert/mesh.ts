// Loader-agnostic triangle soup consumed by the voxelizer (ported from research/photo2brick/src/mesh.ts).
// Filled from three's GLTFLoader output by gltf.ts. No DOM or Node APIs.

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA8, row-major, top row first (glTF UV v = 0 is the top row). */
  data: Uint8Array | Uint8ClampedArray;
}

export interface MeshMaterial {
  /** Linear RGBA base colour factor (glTF semantics). */
  baseColorFactor: [number, number, number, number];
  /** Decoded sRGB base colour texture, or null. UVs (already transformed) live in TriangleMesh.uvs. */
  texture: RgbaImage | null;
}

export interface TriangleMesh {
  /** World-space positions, glTF axes (+Y up), 3 floats per vertex. */
  positions: Float32Array;
  /** 2 floats per vertex, or null. */
  uvs: Float32Array | null;
  /** Linear RGBA per vertex (COLOR_0), 4 floats per vertex, or null. */
  colors: Float32Array | null;
  /** 3 indices per triangle, counter-clockwise = outward. */
  indices: Uint32Array;
  /** Material index per triangle. */
  triMaterial: Uint16Array;
  materials: MeshMaterial[];
}

export interface PrimitiveInput {
  positions: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array;
  material: number;
}

/** Concatenate primitives into one soup (single allocation per array). */
export function buildMesh(prims: PrimitiveInput[], materials: MeshMaterial[]): TriangleMesh {
  let nv = 0, nt = 0;
  const anyUv = prims.some((p) => p.uvs), anyCol = prims.some((p) => p.colors);
  for (const p of prims) { nv += p.positions.length / 3; nt += p.indices.length / 3; }
  const positions = new Float32Array(nv * 3);
  const uvs = anyUv ? new Float32Array(nv * 2) : null;
  const colors = anyCol ? new Float32Array(nv * 4).fill(1) : null;
  const indices = new Uint32Array(nt * 3);
  const triMaterial = new Uint16Array(nt);
  let v = 0, t = 0;
  for (const p of prims) {
    const n = p.positions.length / 3;
    positions.set(p.positions, v * 3);
    if (uvs && p.uvs) uvs.set(p.uvs, v * 2);
    if (colors && p.colors) colors.set(p.colors, v * 4);
    for (let i = 0; i < p.indices.length; i++) indices[t * 3 + i] = p.indices[i] + v;
    triMaterial.fill(p.material, t, t + p.indices.length / 3);
    v += n;
    t += p.indices.length / 3;
  }
  return { positions, uvs, colors, indices, triMaterial, materials };
}
