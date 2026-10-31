import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';

import { migrate, waitForDb, pool } from './db.js';
import {
  COOKIE_NAME, SESSION_TTL_MS, SESSION_RENEW_AFTER_MS,
  loadSession, touchSession, pruneSessions, cookieOpts,
} from './sessions.js';
import { authRoutes } from './auth.js';
import { armiesRoutes } from './armies.js';
import { stateRoutes } from './state.js';
import { imagesRoutes } from './images.js';
import { adminRoutes } from './admin.js';
import { bugsRoutes } from './bugs.js';
import { ATTACH_MAX } from './attachments.js';
import { notifyPendingSignups } from './signup-notify.js';
import { asNumber } from './validate.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
  bodyLimit: 2_000_000,
});

// pg-pool emits 'error' when Postgres drops an IDLE client (a postgres restart,
// pg_terminate_backend). With no listener that EventEmitter 'error' throws and
// takes the whole process down. The pool has already discarded the client, so
// logging is all there is to do; the next query opens a fresh connection.
pool.on('error', (err) => app.log.warn({ err }, 'idle pg client error'));

// Every 5xx answers a fixed body and is logged with its stack here; nothing
// from a thrown error (a Postgres message, a SQLSTATE, a constraint name)
// reaches the client. 4xx errors with a `publicBody` (limits.js) send that
// body; other 4xx (bad JSON, body too large, rate limit on the auth routes)
// go on to Fastify's default handler and keep their usual shape. Set before
// the route plugins are registered so every child context inherits it.
app.setErrorHandler((err, req, reply) => {
  const sc = Number(err.statusCode);
  const status = sc >= 400 && sc < 600 ? sc : 500;
  if (status >= 500) {
    req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: 'internal' });
  }
  if (err.publicBody) return reply.code(status).send(err.publicBody);
  return reply.send(err);
});

await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(rateLimit, {
  global: false,
  max: 60,
  timeWindow: '1 minute',
});

// Only POST /bugs takes multipart (an optional screenshot / recording). One
// file, 50 MB, a handful of short text fields; everything else stays JSON.
// fieldSize is in BYTES: 64 KiB holds the 16,000-char diagnostics cap even
// when every char is 4 bytes of UTF-8, so bugs.js's own char-based truncation
// is what applies on both the JSON and the multipart path. (It was 20,000,
// which silently cut multibyte diagnostics short on the multipart path only.)
await app.register(multipart, {
  limits: { fileSize: ATTACH_MAX, files: 1, fields: 10, fieldSize: 64 * 1024, parts: 12 },
});

app.decorateRequest('user', null);

app.addHook('preHandler', async (req, reply) => {
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return;
  const session = await loadSession(sid);
  // Treat revoked users as signed-out — leave req.user null so handlers
  // 401 the same way as an expired/missing cookie. The admin's revoke
  // action also wipes session rows, so this is belt-and-braces.
  if (session && !session.revoked) {
    req.user = {
      user_id: asNumber(session.user_id),
      username: session.username,
      is_admin: !!session.is_admin,
      session_id: session.session_id,
    };
    // Sliding expiry: if the row was last extended more than RENEW_AFTER ago,
    // push it out to a full TTL and re-send the cookie so Max-Age moves too.
    // Never on logout, and a failure here must not fail the request.
    const remaining = new Date(session.expires_at).getTime() - Date.now();
    if (remaining < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS
        && !String(req.url).startsWith('/auth/logout')) {
      try {
        await touchSession(sid);
        reply.setCookie(COOKIE_NAME, sid, cookieOpts());
      } catch (err) {
        req.log.warn({ err }, 'session touch failed');
      }
    }
  }
});

app.get('/healthz', async () => ({ ok: true }));

await app.register(authRoutes);
await app.register(armiesRoutes);
await app.register(stateRoutes);
await app.register(imagesRoutes);
await app.register(adminRoutes);
await app.register(bugsRoutes);

const close = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  try { await app.close(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(0);
};
process.on('SIGINT',  () => close('SIGINT'));
process.on('SIGTERM', () => close('SIGTERM'));

app.log.info('waiting for postgres');
await waitForDb();
app.log.info('running migrations');
await migrate();

async function runPrune() {
  try {
    const n = await pruneSessions();
    app.log.info({ pruned: n }, `pruned ${n} expired sessions`);
  } catch (err) {
    app.log.warn({ err }, 'session prune failed');
  }
}
await runPrune();
setInterval(runPrune, 24 * 60 * 60 * 1000).unref();

// Pending-signup notices are batched to one mail an hour (signup-notify.js).
// Register sends the first one at once; this sweep sends the batched ones
// once the hour is up. Cheap when there is nothing new: one small query.
async function runSignupSweep() {
  try { await notifyPendingSignups(app.log); }
  catch (err) { app.log.warn({ err }, 'pending-signup sweep failed'); }
}
await runSignupSweep();
setInterval(runSignupSweep, 5 * 60 * 1000).unref();

await app.listen({ host: HOST, port: PORT });
