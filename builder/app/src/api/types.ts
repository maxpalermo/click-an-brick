// API client contract. Implementation: app/src/api/client.ts (backend agent).
import type { BrickColor, CatalogPart } from '../model/types';

export interface SharedModel {
  id: string;
  name: string;
  ldr: string;
  createdAt: string;
}

export interface ApiClient {
  getCatalog(): Promise<CatalogPart[]>;
  getColors(): Promise<BrickColor[]>;
  shareModel(name: string, ldr: string): Promise<{ id: string }>;
  getSharedModel(id: string): Promise<SharedModel>;
}
