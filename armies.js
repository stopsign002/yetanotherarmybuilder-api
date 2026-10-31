import { query } from './db.js';
import { NOT_SIGNED_IN, reject, requireUser } from './http.js';
import { lwwUpsertSql } from './lww.js';
import { ID_RE, asNumber, parseTs } from './validate.js';

const NAME_MAX = 200;
const PAYLOAD_MAX = 1_000_000;

// Built once; see lww.js for the clamp / `applied` / ownership rules.
const UPSERT = lwwUpsertSql({
  table: 'armies',
  insert: ['id', 'user_id', 'name', 'payload'],
  conflict: 'id',
  lww: ['name', 'payload'],
  owner: 'user_id',
});

export async function armiesRoutes(app) {
  app.get('/armies', async (req, reply) => {
    const u = requireUser(req, reply, NOT_SIGNED_IN);
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
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reject(reply, 400, 'Bad army id.');

    const { rows } = await query(
      `SELECT id, name, payload, updated_at
         FROM armies
        WHERE user_id = $1 AND id = $2`,
      [u.user_id, id]
    );
    if (!rows[0]) return reject(reply, 404, 'Not found.');
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      payload: r.payload,
      updated_at: r.updated_at.toISOString(),
    };
  });

  app.put('/armies/:id', async (req, reply) => {
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reject(reply, 400, 'Bad army id.');

    const { name, payload, updated_at } = req.body || {};
    if (typeof name !== 'string' || name.length > NAME_MAX) {
      return reject(reply, 400, 'Bad name.');
    }
    if (typeof payload !== 'string' || payload.length > PAYLOAD_MAX) {
      return reject(reply, 400, 'Bad payload.');
    }
    const ts = parseTs(updated_at) || new Date();

    const { rows } = await query(UPSERT, [id, u.user_id, name, payload, ts]);
    const row = rows[0];
    if (asNumber(row.user_id) !== u.user_id) {
      return reject(reply, 403, 'Army belongs to another user.');
    }
    return { id, updated_at: row.updated_at.toISOString(), applied: row.applied === true };
  });

  app.delete('/armies/:id', async (req, reply) => {
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    const id = req.params.id;
    if (!ID_RE.test(id)) return reject(reply, 400, 'Bad army id.');

    await query('DELETE FROM armies WHERE id = $1 AND user_id = $2', [id, u.user_id]);
    return reply.code(204).send();
  });
}
