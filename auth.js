import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { query } from './db.js';
import { kickSignupNotice } from './signup-notify.js';
import { NOT_SIGNED_IN, reject, requireUser } from './http.js';
import { perUserLimit } from './limits.js';
import { USERNAME_RE } from './validate.js';
import {
  COOKIE_NAME,
  cookieOpts,
  clearCookieOpts,
  createSession,
  deleteSession,
  deleteAllUserSessions,
} from './sessions.js';

const MIN_PW = 8;
const MAX_PW = 256;
const RECOVERY_BYTES = 18;
// Registration is refused (503) once this many accounts are awaiting approval.
// Nothing prunes pending rows, and register needs no login, so without a cap a
// script could fill the admin Users tab with thousands of them.
const PENDING_MAX = 25;

function generateRecoveryCode() {
  return randomBytes(RECOVERY_BYTES).toString('base64url');
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
      return reject(reply, 400, 'Username must be 3–32 characters; letters, digits, _, ., - only.');
    }
    if (typeof password !== 'string' || password.length < MIN_PW || password.length > MAX_PW) {
      return reject(reply, 400, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
    }

    const existing = await query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (existing.rowCount) {
      return reject(reply, 409, 'Username is already taken.');
    }

    // Before the argon2 work, so a refused request costs one COUNT.
    const pending = await query(
      'SELECT COUNT(*)::int AS c FROM users WHERE approved = FALSE AND revoked = FALSE'
    );
    if (pending.rows[0].c >= PENDING_MAX) {
      return reject(reply, 503, 'Sign-ups are paused while existing requests are reviewed. Try again later.');
    }

    const recoveryCode = generateRecoveryCode();
    const [pwHash, recHash] = await Promise.all([
      argon2.hash(password, { type: argon2.argon2id }),
      argon2.hash(recoveryCode, { type: argon2.argon2id }),
    ]);

    let rows;
    try {
      ({ rows } = await query(
        `INSERT INTO users (username, password, recovery_code_hash)
         VALUES ($1, $2, $3)
         RETURNING id, username`,
        [username, pwHash, recHash]
      ));
    } catch (err) {
      // Two concurrent registrations of one name both pass the SELECT above;
      // the loser hits the UNIQUE constraint. Same answer as the pre-check.
      if (err.code === '23505') return reject(reply, 409, 'Username is already taken.');
      throw err;
    }
    const user = rows[0];

    // Coalesced: at most one operator mail an hour (signup-notify.js).
    kickSignupNotice(req.log);

    // Approval gating: don't issue a session — admin must approve first.
    // The client (auth-modal.js) reads `pending: true` and shows a
    // "pending approval" message instead of auto-signing-in.
    return { username: user.username, recoveryCode, pending: true };
  });

  app.post('/auth/login', authLimit, async (req, reply) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reject(reply, 400, 'Username and password required.');
    }
    // Validate the format before it reaches Postgres: a NUL byte used to come
    // back as a raw 500 with the SQLSTATE. The rules are public (register
    // states them), so a 400 here says nothing about which accounts exist.
    if (!USERNAME_RE.test(username)) {
      return reject(reply, 400, 'Invalid username or password.');
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
      return reject(reply, 401, 'Invalid username or password.');
    }
    // Approval gating: distinct error codes once credentials are known
    // valid, so the client can render the right message. (Pre-check we
    // can't distinguish — that would leak which usernames exist.)
    if (user.revoked)  return reject(reply, 403, 'revoked');
    if (!user.approved) return reject(reply, 403, 'pending_approval');

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
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    return { username: u.username, is_admin: !!u.is_admin };
  });

  app.post('/auth/recover', authLimit, async (req, reply) => {
    const { username, recoveryCode, newPassword } = req.body || {};
    if (typeof username !== 'string' || typeof recoveryCode !== 'string' || typeof newPassword !== 'string') {
      return reject(reply, 400, 'username, recoveryCode, and newPassword required.');
    }
    if (!USERNAME_RE.test(username)) {
      return reject(reply, 400, 'Invalid username or recovery code.');
    }
    if (newPassword.length < MIN_PW || newPassword.length > MAX_PW) {
      return reject(reply, 400, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
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
      return reject(reply, 401, 'Invalid username or recovery code.');
    }
    // Same approval gating as login: a recovery code rotation that
    // didn't actually unlock access would be confusing.
    if (user.revoked)  return reject(reply, 403, 'revoked');
    if (!user.approved) return reject(reply, 403, 'pending_approval');

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

  // Same 5/min as login, but keyed on the signed-in user (IP fallback): a
  // stolen cookie must not allow unlimited guessing of the current password,
  // and a flood of argon2 verifies must not stall the 4-thread libuv pool that
  // every other login shares.
  app.post('/auth/change-password', perUserLimit(5, '1 minute'), async (req, reply) => {
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return reject(reply, 400, 'oldPassword and newPassword required.');
    }
    if (newPassword.length < MIN_PW || newPassword.length > MAX_PW) {
      return reject(reply, 400, `Password must be ${MIN_PW}–${MAX_PW} characters.`);
    }

    const { rows } = await query('SELECT password FROM users WHERE id = $1', [u.user_id]);
    const stored = rows[0]?.password;
    let ok = false;
    try { ok = stored ? await argon2.verify(stored, oldPassword) : false; }
    catch (_) { ok = false; }
    if (!ok) return reject(reply, 401, 'Old password is incorrect.');

    const pwHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await query('UPDATE users SET password = $1 WHERE id = $2', [pwHash, u.user_id]);

    // Rotate sessions: invalidate all except the current one.
    const currentSid = req.cookies?.[COOKIE_NAME];
    await query(
      'DELETE FROM sessions WHERE user_id = $1 AND session_id <> $2',
      [u.user_id, currentSid]
    );
    return { ok: true };
  });
}
