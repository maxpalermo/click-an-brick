// "Continue your last photo build": once a job's 3D shape has been downloaded, enough of the flow is kept in
// localStorage to rebuild the bricks after a reload (the GLB itself is in IndexedDB, see glb.ts), so a reload never
// costs another photo build. Needed when the brick converter cannot start in an open tab after a new deploy.
import type { PhotoAnalysis } from '../convert/contracts';
import type { PhotoApiView, PhotoMode } from '../types';
import type { Measure } from './scale';
import type { SizeChoice } from './size';

export interface ResumeRecord {
  jobId: string;
  mode: PhotoMode;
  measure: Measure;
  hollow: boolean;
  analysis?: PhotoAnalysis;
  /** Model size picked on the Confirm screen (absent in records from before the size choice: old behaviour). */
  size?: SizeChoice;
  /** Which photos the job was made from (front, back, side; or front, right, back, left, top), for the resume card. */
  views?: PhotoApiView[];
  /** A quality build (4 sides + top, Tripo); absent in older records and for quick builds. */
  quality?: boolean;
  /** Front photo (only when small enough to store; back / side photos are never kept). */
  image?: string;
  t: number;
}

const KEY = 'brickyard.photo.resume.v1';
/** Session flag: open the photo flow on this record right after the reload we triggered. */
const AUTO = 'brickyard.photo.autoresume';
/** Results are kept on the server for 7 days; the IndexedDB copy may last longer, but stay on the safe side. */
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_IMAGE = 400_000;

export function saveResume(r: Omit<ResumeRecord, 't' | 'image'> & { image?: string }): void {
  const rec: ResumeRecord = { ...r, image: r.image && r.image.length <= MAX_IMAGE ? r.image : undefined, t: Date.now() };
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch {
    try { localStorage.setItem(KEY, JSON.stringify({ ...rec, image: undefined })); } catch { /* quota / private mode */ }
  }
}

export function loadResume(): ResumeRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as ResumeRecord;
    if (!r?.jobId || !r.measure || Date.now() - r.t > MAX_AGE_MS) return null;
    return r;
  } catch {
    return null;
  }
}

export function clearResume(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Reload the page (gets the newly deployed app) and reopen the photo flow on the saved build. */
export function reloadAndResume(): void {
  try { sessionStorage.setItem(AUTO, '1'); } catch { /* the user can still pick "Continue" by hand */ }
  window.location.reload();
}

/** True once after reloadAndResume. */
export function takeAutoResume(): boolean {
  try {
    const v = sessionStorage.getItem(AUTO) === '1';
    sessionStorage.removeItem(AUTO);
    return v;
  } catch {
    return false;
  }
}

/** Peek at the reload flag without consuming it (PhotoFlowHost opens the flow, PhotoFlow then takes it). */
export function hasAutoResume(): boolean {
  try { return sessionStorage.getItem(AUTO) === '1'; } catch { return false; }
}
