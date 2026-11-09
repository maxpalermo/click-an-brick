// Mirrors of the shared contract in app/src/model/types.ts and app/src/api/types.ts.
// (Duplicated because server/tsconfig has rootDir=src; keep in sync with the contract.)

export interface CatalogPart {
  id: string;
  name: string;
  category: string;
  keywords: string[];
}

export interface BrickColor {
  code: number;
  name: string;
  hex: string;
  edge: string;
  alpha: number;
  material?: 'solid' | 'transparent' | 'chrome' | 'metal' | 'pearl' | 'rubber' | 'glitter' | 'speckle';
}

export interface SharedModel {
  id: string;
  name: string;
  ldr: string;
  createdAt: string;
}
