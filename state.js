import { query } from './db.js';

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

export async function stateRoutes(app) {
  app.get('/state', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const { rows } = await query(
      'SELECT payload, updated_at FROM state_bags WHERE user_id = $1',
      [u.user_id]
    );
    if (!rows[0]) return null;
    return {
      payload: rows[0].payload,
      updated_at: rows[0].updated_at.toISOString(),
    };
  });

  app.put('/state', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const { payload, updated_at } = req.body || {};
    if (typeof payload !== 'string' || payload.length > PAYLOAD_MAX) {
      return reply.code(400).send({ error: 'Bad payload.' });
    }
    const ts = parseTs(updated_at) || new Date();

    const { rows } = await query(
      `INSERT INTO state_bags (user_id, payload, updated_at)
            VALUES ($1, $2, LEAST($3::timestamptz, now()))
       ON CONFLICT (user_id) DO UPDATE
              SET payload    = CASE WHEN EXCLUDED.updated_at >= state_bags.updated_at THEN EXCLUDED.payload    ELSE state_bags.payload    END,
                  updated_at = CASE WHEN EXCLUDED.updated_at >= state_bags.updated_at THEN EXCLUDED.updated_at ELSE state_bags.updated_at END
        RETURNING updated_at,
                  (updated_at = LEAST($3::timestamptz, now())) AS applied`,
      [u.user_id, payload, ts]
    );
    // Same clock clamp and `applied` flag as PUT /armies/:id — see armies.js.
    return { updated_at: rows[0].updated_at.toISOString(), applied: rows[0].applied === true };
  });
}
