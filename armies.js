import { query } from './db.js';

// Client-generated army ids: short base36-ish strings, but accept anything
// URL-safe up to 128 chars to keep this future-proof if the client switches
// to UUIDs or longer ids later.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const NAME_MAX = 200;
const PAYLOAD_MAX = 1_000_000;

function requireUser(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'Not signed in.' });
    return null;
  }
  return req.user;
}

function parseTs(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

export async function armiesRoutes(app) {
  app.get('/armies', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const { rows } = await query(
      `SELECT id, name, updated_at
         FROM armies
        WHERE user_id = $1
        ORDER BY updated_at DESC`,
      [u.user_id]
    );
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      updated_at: r.updated_at.toISOString(),
    }));
  });

  app.get('/armies/:id', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Bad army id.' });

    const { rows } = await query(
      `SELECT id, name, payload, updated_at
         FROM armies
        WHERE user_id = $1 AND id = $2`,
      [u.user_id, id]
    );
    if (!rows[0]) return reply.code(404).send({ error: 'Not found.' });
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      payload: r.payload,
      updated_at: r.updated_at.toISOString(),
    };
  });

  app.put('/armies/:id', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Bad army id.' });

    const { name, payload, updated_at } = req.body || {};
    if (typeof name !== 'string' || name.length > NAME_MAX) {
      return reply.code(400).send({ error: 'Bad name.' });
    }
    if (typeof payload !== 'string' || payload.length > PAYLOAD_MAX) {
      return reply.code(400).send({ error: 'Bad payload.' });
    }
    const ts = parseTs(updated_at) || new Date();

    // Last-write-wins on updated_at: if incoming timestamp is older than what
    // we have, keep the existing row but echo the stored timestamp so the
    // client can reconcile.
    const { rows } = await query(
      `INSERT INTO armies (id, user_id, name, payload, updated_at)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
              SET name       = CASE WHEN armies.user_id = EXCLUDED.user_id AND EXCLUDED.updated_at >= armies.updated_at THEN EXCLUDED.name       ELSE armies.name       END,
                  payload    = CASE WHEN armies.user_id = EXCLUDED.user_id AND EXCLUDED.updated_at >= armies.updated_at THEN EXCLUDED.payload    ELSE armies.payload    END,
                  updated_at = CASE WHEN armies.user_id = EXCLUDED.user_id AND EXCLUDED.updated_at >= armies.updated_at THEN EXCLUDED.updated_at ELSE armies.updated_at END
        RETURNING user_id, updated_at`,
      [id, u.user_id, name, payload, ts]
    );
    const row = rows[0];
    if (Number(row.user_id) !== u.user_id) {
      return reply.code(403).send({ error: 'Army belongs to another user.' });
    }
    return { id, updated_at: row.updated_at.toISOString() };
  });

  app.delete('/armies/:id', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'Bad army id.' });

    await query('DELETE FROM armies WHERE id = $1 AND user_id = $2', [id, u.user_id]);
    return reply.code(204).send();
  });
}
