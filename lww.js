import { clampedTs } from './validate.js';

// The last-write-wins upsert shared by PUT /armies/:id and PUT /state. The two
// statements differ only in table, columns and conflict target, so both are
// built from this one template.
//
// Last-write-wins on updated_at: if the incoming timestamp is older than what
// we have, keep the existing row but echo the stored timestamp so the client
// can reconcile.
//
// The client's clock is clamped to the server's (LEAST(ts, now())) before it
// is compared or stored. Without that, one device with a fast clock writes a
// future-dated row and every correctly-set device then loses the >= race until
// wall-clock time catches up — a silent lockout with no error anywhere
// (yetanotherarmybuilder-api#1). A client may be early but never in the future.
//
// `applied` says whether THIS write landed. The upsert always "updates" the
// row (often to its own values), so rowCount is 1 either way and the echoed
// updated_at alone can't distinguish "your write won" from "your clock was
// clamped" — both differ from what was sent.
//
//   table     table name
//   insert    columns bound to $1..$n, in order (updated_at is $n+1)
//   conflict  the unique column the upsert resolves on
//   lww       columns overwritten when the write wins
//   owner     optional column that must match for the write to win; it is also
//             returned so the caller can tell a foreign row (403)
export function lwwUpsertSql({ table, insert, conflict, lww, owner }) {
  const ts = `$${insert.length + 1}`;
  const win = (owner ? `${table}.${owner} = EXCLUDED.${owner} AND ` : '')
    + `EXCLUDED.updated_at >= ${table}.updated_at`;
  const set = [...lww, 'updated_at']
    .map((c) => {
      const p = c.padEnd(10);
      return `${p} = CASE WHEN ${win} THEN EXCLUDED.${p} ELSE ${table}.${p} END`;
    })
    .join(',\n                  ');
  return `INSERT INTO ${table} (${[...insert, 'updated_at'].join(', ')})
            VALUES (${insert.map((_, i) => `$${i + 1}`).join(', ')}, ${clampedTs(ts)})
       ON CONFLICT (${conflict}) DO UPDATE
              SET ${set}
        RETURNING ${owner ? `${owner}, ` : ''}updated_at,
                  (updated_at = ${clampedTs(ts)}) AS applied`;
}
