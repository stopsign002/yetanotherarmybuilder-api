import { pool, query } from './db.js';
import { reject, requireUser } from './http.js';
import { perUserLimit } from './limits.js';
import { asNumber, isNumericId } from './validate.js';

// Per-user library cap and per-image size cap. The library cap matches the
// client's hard-coded ImageStore.LIMIT in cards-mode.js. The size cap is
// the data-URL string length, sized for ~5 MB of binary after base64
// (≈ 6.7 MB string) plus a small JSON envelope.
const LIMIT = 30;
const NAME_MAX = 200;
const DATA_URL_MAX = 7_000_000;

// Route-level body limit. Lets a single image POST hold a 5 MB binary
// (≈ 6.7 MB base64) plus the JSON envelope, without raising the global
// 2 MB Fastify body limit that the small /armies and /state PUTs rely on.
const POST_BODY_LIMIT = 10_000_000;

// Uploads per user per hour. Generous for building a library, but each one can
// be a 7 MB row that rides every nightly pg_dumpall into the year-locked B2
// bucket, so it is not unlimited. Keyed on the user (limits.js); because the
// limit runs at preHandler, the JSON body is parsed before it is checked.
const POSTS_PER_HOUR = 30;

// data: URL allowlist. Anchored prefix; everything after the comma is the
// base64 payload itself, which we don't validate beyond length.
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/;

function rowToRecord(row) {
  return {
    id: asNumber(row.id),
    name: row.name,
    dataUrl: row.data_url,
    addedAt: row.added_at instanceof Date ? row.added_at.getTime() : Date.parse(row.added_at),
  };
}

export async function imagesRoutes(app) {
  app.get('/images', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const { rows } = await query(
      `SELECT id, name, data_url, added_at
         FROM card_back_images
        WHERE user_id = $1
        ORDER BY added_at DESC, id DESC`,
      [u.user_id]
    );
    return rows.map(rowToRecord);
  });

  app.post('/images', {
    bodyLimit: POST_BODY_LIMIT,
    ...perUserLimit(POSTS_PER_HOUR, '1 hour', 'Too many image uploads.'),
  }, async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;

    const body = req.body || {};
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';

    if (!rawName) return reject(reply, 400, 'name required');
    if (rawName.length > NAME_MAX) return reject(reply, 400, 'name too long');
    if (!dataUrl) return reject(reply, 400, 'dataUrl required');
    if (!DATA_URL_RE.test(dataUrl)) return reject(reply, 400, 'unsupported image type');
    if (dataUrl.length > DATA_URL_MAX) return reject(reply, 413, 'image too large');

    // Single transaction: advisory-lock on the user_id, count, then insert.
    // The lock makes the count→insert pair race-free vs other concurrent
    // POSTs from the same user (different sessions/devices) so the cap
    // can't be exceeded.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [u.user_id]);

      const cnt = await client.query(
        'SELECT COUNT(*)::int AS c FROM card_back_images WHERE user_id = $1',
        [u.user_id]
      );
      const count = cnt.rows[0].c;
      if (count >= LIMIT) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'limit', limit: LIMIT, count });
      }

      const ins = await client.query(
        `INSERT INTO card_back_images (user_id, name, data_url)
              VALUES ($1, $2, $3)
           RETURNING id, name, data_url, added_at`,
        [u.user_id, rawName, dataUrl]
      );
      await client.query('COMMIT');
      return rowToRecord(ins.rows[0]);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  });

  app.delete('/images/:id', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;

    const idStr = req.params.id;
    if (!isNumericId(idStr)) return reject(reply, 404, 'not found');

    const result = await query(
      'DELETE FROM card_back_images WHERE id = $1 AND user_id = $2',
      [idStr, u.user_id]
    );
    if (result.rowCount === 0) return reject(reply, 404, 'not found');
    return reply.code(204).send();
  });
}
