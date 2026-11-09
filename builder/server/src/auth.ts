// Session auth shared with the FastAPI app: the bs_session cookie is validated
// against admin.db (sessions + users), exactly like the Python side does.
import type { Request } from 'express';
import { openAdminDb } from './db.js';

const COOKIE = 'bs_session';

function sessionToken(req: Request): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** The logged-in username, or null. */
export function userOf(req: Request): string | null {
  const token = sessionToken(req);
  if (!token) return null;
  try {
    const db = openAdminDb();
    const row = db
      .prepare(
        'SELECT s.username FROM sessions s JOIN users u ON u.username=s.username ' +
          'WHERE s.token=? AND s.expires_at>?',
      )
      .get(token, Date.now()) as { username: string } | undefined;
    db.close();
    return row?.username ?? null;
  } catch {
    return null;
  }
}
