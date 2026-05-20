import { randomBytes } from 'node:crypto';
import { query } from './db.js';

export const COOKIE_NAME = 'yaab_sid';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
