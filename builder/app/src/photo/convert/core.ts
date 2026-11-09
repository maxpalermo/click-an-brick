// Converter core: GLB bytes -> ConvertResult. Environment-agnostic (the image decoder / Draco come in through
// GltfEnv), so the same code runs in the Web Worker (worker.ts) and in Node tests.

import type { BrickColor } from '../../model/types';
import type { ConvertMessage, ConvertOptions, ConvertResult } from '../types';
import { buildPalette } from './color';
import { loadGlbMesh, type GltfEnv } from './gltf';
import { photoToBricks, type PipelineOptions, type PipelineResult } from './pipeline';

export type ProgressMessage = Extract<ConvertMessage, { type: 'progress' }>;

export interface CoreOutput { result: ConvertResult; detail: PipelineResult; loadMs: number; triangles: number }

export async function convertGlb(
  glb: ArrayBuffer, colors: BrickColor[], options: ConvertOptions | PipelineOptions, env: GltfEnv,
  onProgress?: (m: ProgressMessage) => void,
): Promise<CoreOutput> {
  const t0 = performance.now();
  let last = '';
  const emit = (stage: ProgressMessage['stage'], fraction: number) => {
    const f = Math.round(Math.min(1, Math.max(0, fraction)) * 100) / 100;
    const key = `${stage}${f}`;
    if (key === last) return;
    last = key;
    onProgress?.({ type: 'progress', stage, fraction: f });
  };
  emit('load', 0);
  const mesh = await loadGlbMesh(glb, env);
  emit('load', 1);
  const loadMs = performance.now() - t0;
  const palette = buildPalette(colors);
  const detail = photoToBricks(mesh, palette, options, emit);
  return {
    result: {
      bricks: detail.bricks,
      bom: detail.bom,
      stats: { voxels: detail.stats.voxels, parts: detail.stats.parts, colours: detail.stats.colours, ms: Math.round(performance.now() - t0),
        sizeSource: detail.stats.sizeSource, longestStuds: Math.round(detail.stats.longestStuds * 10) / 10,
        ...(detail.stats.cappedFrom !== undefined ? { cappedFrom: detail.stats.cappedFrom } : {}) },
    },
    detail,
    loadMs,
    triangles: mesh.indices.length / 3,
  };
}
