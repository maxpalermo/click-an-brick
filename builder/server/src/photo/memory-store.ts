// In-memory JobStore + BlobStore for the Express dev server (lost on restart; dev only).
import type { BlobObject, BlobStore, CreditKind, CreditRow, JobStore, PhotoJobRow } from './core.js';
import type { SegmentLog, SegmentRow } from './segment.js';

export class MemoryJobStore implements JobStore, SegmentLog {
  private rows = new Map<string, PhotoJobRow>();
  private segments: SegmentRow[] = [];
  private credits: CreditRow[] = [];

  async insert(row: PhotoJobRow) {
    if (this.rows.has(row.id)) throw new Error('duplicate job id');
    this.rows.set(row.id, { ...row });
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async update(id: string, patch: Partial<PhotoJobRow>, expect?: Partial<PhotoJobRow>) {
    const r = this.rows.get(id);
    if (!r) return false;
    if (expect) for (const [k, v] of Object.entries(expect)) if (r[k as keyof PhotoJobRow] !== v) return false;
    Object.assign(r, patch);
    return true;
  }
  async countUserSince(user: string, since: number) {
    let n = 0;
    for (const r of this.rows.values()) if (r.user === user && r.created_at >= since) n++;
    return n;
  }
  async spendSince(since: number) {
    let s = 0;
    for (const r of this.rows.values()) if (r.created_at >= since) s += r.cost_usd;
    for (const r of this.segments) if (r.created_at >= since) s += r.cost_usd;
    return s;
  }
  async addCredit(row: CreditRow) {
    this.credits.push({ ...row });
  }
  async creditSumSince(user: string, since: number, kinds: readonly CreditKind[]) {
    let s = 0;
    for (const r of this.credits) if (r.user === user && r.created_at >= since && kinds.includes(r.kind)) s += r.amount;
    return s;
  }
  async creditsOfJob(jobId: string) {
    return this.credits.filter((r) => r.job_id === jobId).map((r) => ({ ...r }));
  }
  async recordSegment(row: SegmentRow) {
    this.segments.push({ ...row });
    if (this.segments.length > 5000) this.segments.splice(0, 1000);
  }
  async countSegmentsSince(user: string, since: number) {
    let n = 0;
    for (const r of this.segments) if (r.user === user && r.created_at >= since) n++;
    return n;
  }
}

export class MemoryBlobStore implements BlobStore {
  private blobs = new Map<string, Uint8Array>();
  /** Drop the oldest entries beyond this many (dev memory guard). */
  constructor(private max = 200) {}

  async put(key: string, data: ArrayBuffer | Uint8Array | string) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    this.blobs.set(key, bytes);
    while (this.blobs.size > this.max) this.blobs.delete(this.blobs.keys().next().value as string);
  }
  async get(key: string): Promise<BlobObject | null> {
    const b = this.blobs.get(key);
    return b ? { body: b, size: b.byteLength } : null;
  }
  async getText(key: string) {
    const b = this.blobs.get(key);
    return b ? new TextDecoder().decode(b) : null;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}
