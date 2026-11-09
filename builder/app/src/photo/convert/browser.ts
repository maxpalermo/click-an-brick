// Browser (Web Worker) environment for the converter core: texture decoding with createImageBitmap +
// OffscreenCanvas, and a lazily created Draco decoder whose files are bundled by Vite (no CDN).

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import dracoWrapperUrl from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasmUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';
import dracoJsUrl from 'three/examples/jsm/libs/draco/gltf/draco_decoder.js?url';
import type { GltfEnv } from './gltf';
import type { RgbaImage } from './mesh';

/** Textures are sampled per voxel; more than 1024 px adds nothing at <= 64 studs and costs memory. */
const MAX_TEXTURE = 1024;

async function decodeImage(bytes: Uint8Array, mime: string): Promise<RgbaImage> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const probe = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  let bmp = probe;
  const k = Math.min(1, MAX_TEXTURE / Math.max(probe.width, probe.height));
  if (k < 1) {
    bmp = await createImageBitmap(probe, {
      resizeWidth: Math.max(1, Math.round(probe.width * k)), resizeHeight: Math.max(1, Math.round(probe.height * k)),
      resizeQuality: 'medium', colorSpaceConversion: 'none', premultiplyAlpha: 'none',
    });
    probe.close();
  }
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
  ctx.drawImage(bmp, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width, height, data };
}

let draco: DRACOLoader | null = null;
function getDraco(): DRACOLoader {
  if (!draco) {
    draco = new DRACOLoader();
    const urls: Record<string, string> = {
      'draco_wasm_wrapper.js': dracoWrapperUrl, 'draco_decoder.wasm': dracoWasmUrl, 'draco_decoder.js': dracoJsUrl,
    };
    // DRACOLoader fetches decoderPath + file name; map the names to the hashed Vite asset URLs instead.
    (draco as unknown as { _loadLibrary: (name: string, type: 'text' | 'arraybuffer') => Promise<string | ArrayBuffer> })._loadLibrary =
      async (name, type) => {
        const res = await fetch(urls[name] ?? name);
        if (!res.ok) throw new Error(`Draco decoder ${name}: HTTP ${res.status}`);
        return type === 'text' ? res.text() : res.arrayBuffer();
      };
    draco.setWorkerLimit(1);
  }
  return draco;
}

export const browserEnv: GltfEnv = { decodeImage, draco: getDraco };
