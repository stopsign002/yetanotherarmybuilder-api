import { pool } from './db.js';
import { saveAttachment, removeAttachment, attachDirFreeBytes } from './attachments.js';
import { reject, requireUser } from './http.js';
import { perUserLimit } from './limits.js';
import { asNumber } from './validate.js';

// Field caps from the docs/ADMIN_API.md spec.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const DIAGNOSTICS_MAX = 16000;               // longer diagnostics are truncated, not refused
const DIAG_MARK = '\n…(truncated by server)…';
const EMAIL_MAX = 254;                       // RFC 5321 practical maximum
// Deliberately permissive: the address is only ever used to send a courtesy
// note, so the cost of rejecting a valid-but-unusual address is higher than
// the cost of accepting one that bounces.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Abuse limits (api#2). Each report can carry a 50 MB file onto the host's
// root filesystem and queues work for the hourly bug-fixer, so:
const REPORTS_PER_HOUR = 5;                       // per user (route rate limit)
const OPEN_MAX = 10;                              // unfixed reports per user
const ATTACH_BYTES_MAX = 200 * 1024 * 1024;       // attachment bytes on disk per user
const DISK_FLOOR = 2 * 1024 * 1024 * 1024;        // refuse attachments (507) below this free
// Namespace for the two-int advisory lock below. The images cap uses the
// one-bigint form, which Postgres keeps in a separate key space.
const BUG_LOCK_NS = 7301;

// Cut to DIAGNOSTICS_MAX chars including the marker, without splitting a
// surrogate pair. The client already trims, but its own marker took it 14
// chars over the old hard cap, which refused the very reports it meant to fix.
function clampDiagnostics(s) {
  if (s.length <= DIAGNOSTICS_MAX) return s;
  let cut = s.slice(0, DIAGNOSTICS_MAX - DIAG_MARK.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
  return cut + DIAG_MARK;
}

// Open reports and attachment bytes still on disk for this submitter. Every
// row with a file counts, fixed or not, because the file stays until an admin
// deletes the report. Keyed on the username snapshot (bug_reports has no FK).
async function usage(db, username) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE fixed = FALSE)::int AS open,
            COALESCE(SUM(attachment_size) FILTER (WHERE attachment_file IS NOT NULL), 0)::bigint AS bytes
       FROM bug_reports
      WHERE username = $1`,
    [username]
  );
  return { open: rows[0].open, bytes: asNumber(rows[0].bytes) };
}

const OPEN_MSG = `You already have ${OPEN_MAX} open reports. Please wait for some to be resolved before sending more.`;
const QUOTA_MSG = 'Your attachment storage is full (200 MB across your reports). Send this one without an attachment.';

export async function bugsRoutes(app) {
  // Any signed-in user can submit. Admin browsing/management endpoints
  // live in admin.js under /admin/bugs.
  app.post('/bugs', perUserLimit(REPORTS_PER_HOUR, '1 hour', 'Too many reports sent.'), async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const isMultipart = !!(req.isMultipart && req.isMultipart());

    // Cheap refusals before a byte of the upload is read. The same limits are
    // checked again under a lock at insert time (below), so concurrent
    // requests cannot slip past them.
    const pre = await usage(pool, u.username);
    if (pre.open >= OPEN_MAX) return reject(reply, 429, OPEN_MSG);
    if (isMultipart) {
      if (pre.bytes >= ATTACH_BYTES_MAX) return reject(reply, 413, QUOTA_MSG);
      let free = Infinity;
      try { free = await attachDirFreeBytes(); }
      catch (err) { req.log.warn({ err }, 'statfs on attachment dir failed; not enforcing the disk floor'); }
      if (free < DISK_FLOOR) {
        req.log.warn({ free }, 'attachment refused: free disk below floor');
        return reject(reply, 507, 'The server is low on disk space, so attachments are paused. Send the report without one.');
      }
    }

    // Two shapes (app docs/ADMIN_API.md §5): JSON, or multipart/form-data with
    // the same text fields plus an optional `attachment` file part. The file is
    // streamed to disk as it arrives; anything that fails after that point must
    // remove it again, so an orphan never outlives a rejected report.
    let body = req.body || {};
    let att = null;
    if (isMultipart) {
      body = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'attachment' || att) { part.file.resume(); continue; }
            att = await saveAttachment(part);
          } else if (typeof part.value === 'string') {
            body[part.fieldname] = part.value;
          }
        }
      } catch (err) {
        if (att) await removeAttachment(att.file);
        const code = err.statusCode === 415 || err.statusCode === 413 ? err.statusCode
          : (err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400);
        return reject(reply, code, code === 415 ? 'attachment must be an image or video'
          : code === 413 ? 'attachment too large (max 50 MB)' : 'bad upload');
      }
    }
    const refuse = async (code, error) => {
      if (att) await removeAttachment(att.file);
      return reject(reply, code, error);
    };

    const kind = body.kind === 'feature' ? 'feature' : 'bug';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const diagnostics = typeof body.diagnostics === 'string' ? clampDiagnostics(body.diagnostics) : null;
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!title) return refuse(400, 'title required');
    if (title.length > TITLE_MAX) return refuse(400, 'title too long');
    if (!description) return refuse(400, 'description required');
    if (description.length > DESCRIPTION_MAX) return refuse(400, 'description too long');
    // Optional. Reject a malformed one rather than storing it — a silently
    // dropped address means the reporter waits for a note that never comes.
    if (email && (email.length > EMAIL_MAX || !EMAIL_RE.test(email))) {
      return refuse(400, 'email looks invalid');
    }

    // Re-check the per-user limits and insert in one transaction, serialised
    // per submitter by an advisory lock, so two concurrent submissions cannot
    // both pass the count. The attachment's real size is known only now.
    let rows;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [BUG_LOCK_NS, u.username]);
      const now = await usage(client, u.username);
      if (now.open >= OPEN_MAX) {
        await client.query('ROLLBACK');
        return refuse(429, OPEN_MSG);
      }
      if (att && now.bytes + att.size > ATTACH_BYTES_MAX) {
        await client.query('ROLLBACK');
        return refuse(413, QUOTA_MSG);
      }
      ({ rows } = await client.query(
        `INSERT INTO bug_reports (username, kind, title, description, diagnostics, email,
                                  attachment_file, attachment_mime, attachment_size)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
        [u.username, kind, title, description, diagnostics, email || null,
         att ? att.file : null, att ? att.mime : null, att ? att.size : null]
      ));
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (att) await removeAttachment(att.file);
      throw err;
    } finally {
      client.release();
    }
    // No submission email on purpose. bug-fixer.sh picks this up within the
    // hour and mails either "fixed" or "needs you" — a heads-up now would
    // just be noise arriving minutes before the useful message.
    return { id: asNumber(rows[0].id) };
  });
}
