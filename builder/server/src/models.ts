// Shared models live in the owner's lego.sqlite (shared_models table) so they
// are created, synced and backed up together with the rest of the user data.
// A public share link is resolved by scanning the users' files for the id.
import crypto from 'node:crypto';
import type { SharedModel } from './types.js';
import { ALPHABET, ID_LEN } from './model-validation.js';
import { deviceId, listUsers, openUserDb } from './db.js';

export { isValidModelId, MAX_NAME_LEN, validateModelInput, ValidationError } from './model-validation.js';

function newId(): string {
  let s = '';
  for (let i = 0; i < ID_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export async function saveModel(name: string, ldr: string, owner: string): Promise<SharedModel> {
  const db = openUserDb(owner);
  const now = Date.now();
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = newId();
    try {
      db.prepare(
        'INSERT INTO shared_models (id,name,ldr,created_at,updated_at,deleted,device_id) VALUES (?,?,?,?,?,0,?)',
      ).run(id, name, ldr, now, now, deviceId(db));
      return { id, name, ldr, createdAt: new Date(now).toISOString() };
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Could not allocate a model id.');
}

export async function loadModel(id: string): Promise<SharedModel | null> {
  for (const user of listUsers()) {
    try {
      const db = openUserDb(user);
      const row = db
        .prepare('SELECT id,name,ldr,created_at FROM shared_models WHERE id=? AND deleted=0')
        .get(id) as { id: string; name: string; ldr: string; created_at: number } | undefined;
      db.close();
      if (row) return { id: row.id, name: row.name, ldr: row.ldr, createdAt: new Date(row.created_at).toISOString() };
    } catch {
      /* skip unreadable user db */
    }
  }
  return null;
}
