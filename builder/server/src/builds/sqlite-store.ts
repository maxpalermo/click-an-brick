// SqliteBuildStore: "My builds" persisted in the user's own lego.sqlite so they
// travel with device sync, side by side with the LEGO collection.
import type { DatabaseSync } from 'node:sqlite';
import { openUserDb, deviceId } from '../db.js';
import type { BuildRow, BuildStore } from './core.js';

const SUMMARY = 'id,user,name,parts,thumb,source,share_id,photo_job_id,created_at,updated_at,deleted,device_id';

export class SqliteBuildStore implements BuildStore {
  private db: DatabaseSync;

  constructor(private user: string) {
    this.db = openUserDb(user);
  }

  async list(_user: string) {
    return this.db
      .prepare(`SELECT ${SUMMARY} FROM builds WHERE deleted=0 ORDER BY updated_at DESC`)
      .all() as Omit<BuildRow, 'ldr'>[];
  }

  async count(_user: string) {
    const r = this.db.prepare('SELECT COUNT(*) n FROM builds WHERE deleted=0').get() as { n: number };
    return r.n;
  }

  async get(id: string) {
    return (
      (this.db
        .prepare(`SELECT ${SUMMARY}, ldr FROM builds WHERE id=? AND deleted=0`)
        .get(id) as BuildRow | undefined) ?? null
    );
  }

  async insert(row: BuildRow) {
    try {
      this.db
        .prepare(
          'INSERT INTO builds (id,user,name,ldr,parts,thumb,source,share_id,photo_job_id,created_at,updated_at,deleted,device_id) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)',
        )
        .run(
          row.id, row.user, row.name, row.ldr, row.parts, row.thumb, row.source,
          row.share_id, row.photo_job_id, row.created_at, row.updated_at, deviceId(this.db),
        );
      return true;
    } catch {
      return false;
    }
  }

  async update(id: string, _user: string, patch: Partial<BuildRow>) {
    const cols = ['name', 'ldr', 'parts', 'thumb', 'source', 'share_id', 'photo_job_id', 'updated_at'] as const;
    const sets = cols.filter((c) => patch[c] !== undefined).map((c) => `${c}=?`);
    if (!sets.length) return;
    this.db
      .prepare(`UPDATE builds SET ${sets.join(',')}, device_id=? WHERE id=?`)
      .run(...cols.filter((c) => patch[c] !== undefined).map((c) => patch[c] as string | number | null), deviceId(this.db), id);
  }

  async delete(id: string, _user: string) {
    const r = this.db
      .prepare('UPDATE builds SET deleted=1, updated_at=?, device_id=? WHERE id=? AND deleted=0')
      .run(new Date().toISOString(), deviceId(this.db), id);
    return Number(r.changes) > 0;
  }
}
