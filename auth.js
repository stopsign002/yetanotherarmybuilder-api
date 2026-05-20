import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { query } from './db.js';
import {
  COOKIE_NAME,
  cookieOpts,
  clearCookieOpts,
  createSession,
  deleteSession,
  deleteAllUserSessions,
} from './sessions.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MIN_PW = 8;
const MAX_PW = 256;
const RECOVERY_BYTES = 18;

function generateRecoveryCode() {
  return randomBytes(RECOVERY_BYTES).toString('base64url');
}

function badInput(reply, error, status = 400) {
  return reply.code(status).send({ error });
}

export async function authRoutes(app) {
  const authLimit = {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  };

  app.post('/auth/register', authLimit, async (req, reply) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return badInput(reply, 'Username must be 3–32 characters; letters, digits, _, ., - only.');
    }
    if (typeof password !== 'string' || password.length < MIN_PW || password.length > MAX_PW) {
      return badInput(reply, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
    }

    const existing = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (existing.rowCount) {
      return badInput(reply, 'Username is already taken.', 409);
    }

    const recoveryCode = generateRecoveryCode();
    const [pwHash, recHash] = await Promise.all([
      argon2.hash(password, { type: argon2.argon2id }),
      argon2.hash(recoveryCode, { type: argon2.argon2id }),
    ]);

    const { rows } = await query(
      `INSERT INTO users (username, password, recovery_code_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [username, pwHash, recHash]
    );
    const user = rows[0];

    // Approval gating: don't issue a session — admin must approve first.
    // The client (auth-modal.js) reads `pending: true` and shows a
    // "pending approval" message instead of auto-signing-in.
    return { username: user.username, recoveryCode, pending: true };
  });

  app.post('/auth/login', authLimit, async (req, reply) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return badInput(reply, 'Username and password required.');
    }

    const { rows } = await query(
      'SELECT id, username, password, approved, revoked, is_admin FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];

    // Always verify against *something* to keep timing roughly equal between
    // missing-user and wrong-password.
    const stored = user
      ? user.password
      : '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let ok = false;
    try {
      ok = await argon2.verify(stored, password);
    } catch (_) {
      ok = false;
    }
    if (!user || !ok) {
      return badInput(reply, 'Invalid username or password.', 401);
    }
    // Approval gating: distinct error codes once credentials are known
    // valid, so the client can render the right message. (Pre-check we
    // can't distinguish — that would leak which usernames exist.)
    if (user.revoked)  return reply.code(403).send({ error: 'revoked' });
    if (!user.approved) return reply.code(403).send({ error: 'pending_approval' });

    const { sid } = await createSession(user.id);
    reply.setCookie(COOKIE_NAME, sid, cookieOpts());
    return { username: user.username, is_admin: !!user.is_admin };
  });

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies?.[COOKIE_NAME];
    if (sid) await deleteSession(sid);
    reply.clearCookie(COOKIE_NAME, clearCookieOpts());
    return reply.code(204).send();
  });

  app.get('/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in.' });
    return { username: req.user.username, is_admin: !!req.user.is_admin };
  });

  app.post('/auth/recover', authLimit, async (req, reply) => {
    const { username, recoveryCode, newPassword } = req.body || {};
    if (typeof username !== 'string' || typeof recoveryCode !== 'string' || typeof newPassword !== 'string') {
      return badInput(reply, 'username, recoveryCode, and newPassword required.');
    }
    if (newPassword.length < MIN_PW || newPassword.length > MAX_PW) {
      return badInput(reply, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
    }

    const { rows } = await query(
      'SELECT id, username, recovery_code_hash, approved, revoked FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const stored = user
      ? user.recovery_code_hash
      : '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let ok = false;
    try {
      ok = await argon2.verify(stored, recoveryCode);
    } catch (_) {
      ok = false;
    }
    if (!user || !ok) {
      return badInput(reply, 'Invalid username or recovery code.', 401);
    }
    // Same approval gating as login: a recovery code rotation that
    // didn't actually unlock access would be confusing.
    if (user.revoked)  return reply.code(403).send({ error: 'revoked' });
    if (!user.approved) return reply.code(403).send({ error: 'pending_approval' });

    const newRecoveryCode = generateRecoveryCode();
    const [pwHash, recHash] = await Promise.all([
      argon2.hash(newPassword, { type: argon2.argon2id }),
      argon2.hash(newRecoveryCode, { type: argon2.argon2id }),
    ]);

    await query(
      'UPDATE users SET password = $1, recovery_code_hash = $2 WHERE id = $3',
      [pwHash, recHash, user.id]
    );
    await deleteAllUserSessions(user.id);

    const { sid } = await createSession(user.id);
    reply.setCookie(COOKIE_NAME, sid, cookieOpts());
    return { username: user.username, recoveryCode: newRecoveryCode };
  });

  app.post('/auth/change-password', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in.' });
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return badInput(reply, 'oldPassword and newPassword required.');
    }
    if (newPassword.length < MIN_PW || newPassword.length > MAX_PW) {
      return badInput(reply, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
    }

    const { rows } = await query('SELECT password FROM users WHERE id = $1', [req.user.user_id]);
    const stored = rows[0]?.password;
    let ok = false;
    try { ok = stored ? await argon2.verify(stored, oldPassword) : false; }
    catch (_) { ok = false; }
    if (!ok) return badInput(reply, 'Old password is incorrect.', 401);

    const pwHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await query('UPDATE users SET password = $1 WHERE id = $2', [pwHash, req.user.user_id]);

    // Rotate sessions: invalidate all except the current one.
    const currentSid = req.cookies?.[COOKIE_NAME];
    await query(
      'DELETE FROM sessions WHERE user_id = $1 AND session_id <> $2',
      [req.user.user_id, currentSid]
    );
    return { ok: true };
  });
}
