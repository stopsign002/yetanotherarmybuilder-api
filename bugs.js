import { query } from './db.js';

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

    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const diagnostics = typeof body.diagnostics === 'string' ? body.diagnostics : null;
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!title) return reply.code(400).send({ error: 'title required' });
    if (title.length > TITLE_MAX) return reply.code(400).send({ error: 'title too long' });
    if (!description) return reply.code(400).send({ error: 'description required' });
    if (description.length > DESCRIPTION_MAX) return reply.code(400).send({ error: 'description too long' });
    if (diagnostics && diagnostics.length > DIAGNOSTICS_MAX) {
      return reply.code(400).send({ error: 'diagnostics too long' });
    }
    // Optional. Reject a malformed one rather than storing it — a silently
    // dropped address means the reporter waits for a note that never comes.
    if (email && (email.length > EMAIL_MAX || !EMAIL_RE.test(email))) {
      return reply.code(400).send({ error: 'email looks invalid' });
    }

    const { rows } = await query(
      `INSERT INTO bug_reports (username, title, description, diagnostics, email)
            VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
      [u.username, title, description, diagnostics, email || null]
    );
    // No submission email on purpose. bug-fixer.sh picks this up within the
    // hour and mails either "fixed" or "needs you" — a heads-up now would
    // just be noise arriving minutes before the useful message.
    return { id: Number(rows[0].id) };
  });
}
