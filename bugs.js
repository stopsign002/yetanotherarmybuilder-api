import { query } from './db.js';

// Field caps from the docs/ADMIN_API.md spec.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const DIAGNOSTICS_MAX = 16000;

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

    if (!title) return reply.code(400).send({ error: 'title required' });
    if (title.length > TITLE_MAX) return reply.code(400).send({ error: 'title too long' });
    if (!description) return reply.code(400).send({ error: 'description required' });
    if (description.length > DESCRIPTION_MAX) return reply.code(400).send({ error: 'description too long' });
    if (diagnostics && diagnostics.length > DIAGNOSTICS_MAX) {
      return reply.code(400).send({ error: 'diagnostics too long' });
    }

    const { rows } = await query(
      `INSERT INTO bug_reports (username, title, description, diagnostics)
            VALUES ($1, $2, $3, $4)
         RETURNING id`,
      [u.username, title, description, diagnostics]
    );
    return { id: Number(rows[0].id) };
  });
}
