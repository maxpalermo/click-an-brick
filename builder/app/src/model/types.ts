// Shared data contract for Brickyard. All positions are LDraw units (LDU), LDraw axes (-Y up).

/** 3x3 rotation matrix, row-major: [a,b,c, d,e,f, g,h,i] as in an LDraw type-1 line. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Vec3 = [number, number, number];

export interface Brick {
  /** Unique within the model. */
  id: string;
  /** LDraw part file name without folder, e.g. "3001.dat". */
  part: string;
  /** LDraw colour code, e.g. 4 = Red. */
  color: number;
  pos: Vec3;
  rot: Mat3;
}

export interface Model {
  name: string;
  author?: string;
  bricks: Brick[];
}

export interface CatalogPart {
  /** File name, e.g. "3001.dat". */
  id: string;
  /** LDraw description, e.g. "Brick  2 x  4". */
  name: string;
  /** LDraw category, e.g. "Brick", "Plate", "Slope", "Technic". */
  category: string;
  keywords: string[];
}

export interface BrickColor {
  code: number;
  name: string;
  /** "#RRGGBB" */
  hex: string;
  edge: string;
  /** 0–255, 255 = opaque. */
  alpha: number;
  material?: 'solid' | 'transparent' | 'chrome' | 'metal' | 'pearl' | 'rubber' | 'glitter' | 'speckle';
}

export type Tool = 'place' | 'select' | 'paint' | 'erase';
export type ViewMode = '3d' | '2d';

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const STUD = 20;
export const PLATE_H = 8;
export const BRICK_H = 24;
