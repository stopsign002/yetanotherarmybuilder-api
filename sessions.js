import { randomBytes } from 'node:crypto';
import { query } from './db.js';

export const COOKIE_NAME = 'yaab_sid';
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
// Sliding expiry: a session row is pushed out to a full TTL again at most once
// per this interval (see the preHandler in server.js).
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

function newSessionId() {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId) {
  const sid = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    'INSERT INTO sessions (session_id, user_id, expires_at) VALUES ($1, $2, $3)',
    [sid, userId, expiresAt]
  );
  return { sid, expiresAt };
}

export async function loadSession(sid) {
  if (!sid) return null;
  const { rows } = await query(
    `SELECT s.session_id, s.user_id, s.expires_at,
            u.username, u.is_admin, u.revoked
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.session_id = $1
        AND s.expires_at > now()`,
    [sid]
  );
  return rows[0] || null;
}

// Push a live session's expiry out to a full TTL from now.
export async function touchSession(sid) {
  if (!sid) return;
  await query(
    `UPDATE sessions SET expires_at = now() + ($2::bigint * interval '1 millisecond') WHERE session_id = $1`,
    [sid, SESSION_TTL_MS]
  );
}

// Delete expired rows (loadSession already ignores them; this just bounds the table).
export async function pruneSessions() {
  const res = await query('DELETE FROM sessions WHERE expires_at < now()');
  return res.rowCount;
}

export async function deleteSession(sid) {
  if (!sid) return;
  await query('DELETE FROM sessions WHERE session_id = $1', [sid]);
}

export async function deleteAllUserSessions(userId) {
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export function cookieOpts(maxAgeMs = SESSION_TTL_MS) {
  return {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export function clearCookieOpts() {
  return { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0 };
}
