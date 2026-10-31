import { query } from './db.js';
import { NOT_SIGNED_IN, reject, requireUser } from './http.js';
import { lwwUpsertSql } from './lww.js';
import { parseTs } from './validate.js';

const PAYLOAD_MAX = 1_000_000;

// Built once; same clamp and `applied` flag as PUT /armies/:id — see lww.js.
const UPSERT = lwwUpsertSql({
  table: 'state_bags',
  insert: ['user_id', 'payload'],
  conflict: 'user_id',
  lww: ['payload'],
});

export async function stateRoutes(app) {
  app.get('/state', async (req, reply) => {
    const u = requireUser(req, reply, NOT_SIGNED_IN);
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
    const u = requireUser(req, reply, NOT_SIGNED_IN);
    if (!u) return;
    const { payload, updated_at } = req.body || {};
    if (typeof payload !== 'string' || payload.length > PAYLOAD_MAX) {
      return reject(reply, 400, 'Bad payload.');
    }
    const ts = parseTs(updated_at) || new Date();

    const { rows } = await query(UPSERT, [u.user_id, payload, ts]);
    return { updated_at: rows[0].updated_at.toISOString(), applied: rows[0].applied === true };
  });
}
