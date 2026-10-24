import { query } from './db.js';
import { saveAttachment, removeAttachment } from './attachments.js';

// Field caps from the docs/ADMIN_API.md spec.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const DIAGNOSTICS_MAX = 16000;
const EMAIL_MAX = 254;                       // RFC 5321 practical maximum
// Deliberately permissive: the address is only ever used to send a courtesy
// note, so the cost of rejecting a valid-but-unusual address is higher than
// the cost of accepting one that bounces.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function requireUser(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return req.user;
}

export async function bugsRoutes(app) {
  // Any signed-in user can submit. Admin browsing/management endpoints
  // live in admin.js under /admin/bugs.
  app.post('/bugs', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;

    // Two shapes (app docs/ADMIN_API.md §5): JSON, or multipart/form-data with
    // the same text fields plus an optional `attachment` file part. The file is
    // streamed to disk as it arrives; anything that fails after that point must
    // remove it again, so an orphan never outlives a rejected report.
    let body = req.body || {};
    let att = null;
    if (req.isMultipart && req.isMultipart()) {
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
        return reply.code(code).send({ error: code === 415 ? 'attachment must be an image or video'
          : code === 413 ? 'attachment too large (max 50 MB)' : 'bad upload' });
      }
    }
    const reject = async (code, error) => {
      if (att) await removeAttachment(att.file);
      return reply.code(code).send({ error });
    };

    const kind = body.kind === 'feature' ? 'feature' : 'bug';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const diagnostics = typeof body.diagnostics === 'string' ? body.diagnostics : null;
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!title) return reject(400, 'title required');
    if (title.length > TITLE_MAX) return reject(400, 'title too long');
    if (!description) return reject(400, 'description required');
    if (description.length > DESCRIPTION_MAX) return reject(400, 'description too long');
    if (diagnostics && diagnostics.length > DIAGNOSTICS_MAX) {
      return reject(400, 'diagnostics too long');
    }
    // Optional. Reject a malformed one rather than storing it — a silently
    // dropped address means the reporter waits for a note that never comes.
    if (email && (email.length > EMAIL_MAX || !EMAIL_RE.test(email))) {
      return reject(400, 'email looks invalid');
    }

    let rows;
    try {
      ({ rows } = await query(
        `INSERT INTO bug_reports (username, kind, title, description, diagnostics, email,
                                  attachment_file, attachment_mime, attachment_size)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
        [u.username, kind, title, description, diagnostics, email || null,
         att ? att.file : null, att ? att.mime : null, att ? att.size : null]
      ));
    } catch (err) {
      if (att) await removeAttachment(att.file);
      throw err;
    }
    // No submission email on purpose. bug-fixer.sh picks this up within the
    // hour and mails either "fixed" or "needs you" — a heads-up now would
    // just be noise arriving minutes before the useful message.
    return { id: Number(rows[0].id) };
  });
}
