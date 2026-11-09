import type { Brick, Mat3, Model, Vec3 } from './types';
import { newId } from './id';

const fmt = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Serialize a model to LDraw .ldr text (opens in BrickLink Studio, LDCad, LeoCAD). */
export function toLdr(model: Model): string {
  const lines = [
    `0 ${model.name || 'Untitled'}`,
    `0 Name: ${(model.name || 'untitled').replace(/\s+/g, '_')}.ldr`,
    `0 Author: ${model.author ?? 'Brickyard'}`,
    '0 !LDRAW_ORG Unofficial_Model',
    '',
  ];
  for (const b of model.bricks) {
    lines.push(['1', b.color, ...b.pos.map(fmt), ...b.rot.map(fmt), b.part].join(' '));
  }
  lines.push('0');
  return lines.join('\r\n') + '\r\n';
}

/** Parse LDraw .ldr / .mpd text. Only type-1 lines of the first (main) file are taken. */
export function fromLdr(text: string): Model {
  const bricks: Brick[] = [];
  let name = '';
  let author: string | undefined;
  let fileCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.split(/\s+/);
    if (t[0] === '0') {
      if (t[1] === 'FILE') { fileCount++; if (fileCount > 1) break; continue; }
      if (t[1] === 'Author:') author = t.slice(2).join(' ');
      else if (!name && t[1] && !t[1].endsWith(':') && !t[1].startsWith('!')) name = t.slice(1).join(' ');
      continue;
    }
    if (t[0] !== '1' || t.length < 15) continue;
    const n = t.slice(2, 14).map(Number);
    if (n.some(Number.isNaN)) continue;
    bricks.push({
      id: newId(),
      color: Number(t[1]),
      pos: n.slice(0, 3) as Vec3,
      rot: n.slice(3, 12) as Mat3,
      part: t.slice(14).join(' ').toLowerCase().replace(/\\/g, '/'),
    });
  }
  return { name: name || 'Imported model', author, bricks };
}
