// Photo capture helpers: crop + resize to ≤1024 px long side, JPEG q0.85. Drawing through a canvas
// drops all EXIF/GPS metadata; EXIF orientation is applied when decoding files.

export const MAX_SIDE = 1024;
export const JPEG_QUALITY = 0.85;

/** Rectangle as fractions (0..1) of an image. */
export interface Rect01 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Shot {
  /** JPEG data URI, EXIF-free. */
  dataUrl: string;
  width: number;
  height: number;
  /** Framing guide (where the user fitted the object) in photo fractions. */
  guide: Rect01;
  /** Studs across the guide width when the photo was taken (grid overlay, UX A). */
  studsW: number;
}

/** Draw a source region to a canvas scaled so the long side is ≤ MAX_SIDE, return a JPEG data URI. */
export function encodeJpeg(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): { dataUrl: string; width: number; height: number } {
  const k = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * k));
  const height = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, width, height);
  return { dataUrl: c.toDataURL('image/jpeg', JPEG_QUALITY), width, height };
}

/**
 * Decode an image file with EXIF orientation applied into a canvas (long side ≤ 2048, so the grid
 * preview stays fast). The final JPEG is re-encoded from this canvas, so metadata never survives.
 */
export async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  let src: ImageBitmap | HTMLImageElement;
  let w: number, h: number;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch {
    // Older Safari: <img> decoding applies EXIF orientation by default (image-orientation: from-image).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      src = img;
      w = img.naturalWidth;
      h = img.naturalHeight;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!w || !h) throw new Error("That file doesn't look like a photo.");
  const k = Math.min(1, 2048 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if ('close' in src) src.close();
  return c;
}
