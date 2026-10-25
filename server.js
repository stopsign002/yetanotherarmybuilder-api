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

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  trustProxy: true,
  bodyLimit: 2_000_000,
});

await app.register(cookie, { secret: process.env.SESSION_SECRET });
await app.register(rateLimit, {
  global: false,
  max: 60,
  timeWindow: '1 minute',
});

// Only POST /bugs takes multipart (an optional screenshot / recording). One
// file, 50 MB, a handful of short text fields; everything else stays JSON.
await app.register(multipart, {
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, fieldSize: 20_000, parts: 12 },
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
      user_id: Number(session.user_id),
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

await app.listen({ host: HOST, port: PORT });
