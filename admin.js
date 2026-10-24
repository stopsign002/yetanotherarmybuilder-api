import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { attachmentPath, extForMime, removeAttachment } from './attachments.js';
import { query } from './db.js';
import { deleteAllUserSessions } from './sessions.js';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const FIX_NOTE_MAX = 4000;

function requireAdmin(req, reply) {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  if (!req.user.is_admin) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return req.user;
}

function tsToMs(t) {
  if (!t) return null;
  if (t instanceof Date) return t.getTime();
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

function bugRowToRecord(r) {
  return {
    id:          Number(r.id),
    username:    r.username,
    kind:        r.kind || 'bug',
    attachment_url:  r.attachment_file ? `/api/admin/bugs/${Number(r.id)}/attachment` : null,
    attachment_mime: r.attachment_mime || null,
    attachment_size: r.attachment_size != null ? Number(r.attachment_size) : null,
    title:       r.title,
    description: r.description,
    diagnostics: r.diagnostics,
    fixed:       !!r.fixed,
    fixed_at:    tsToMs(r.fixed_at),
    fixed_by:    r.fixed_by,
    fixed_note:  r.fixed_note,
    created_at:  tsToMs(r.created_at),
  };
}

export async function adminRoutes(app) {
  app.get('/admin/users', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;

    const { rows } = await query(
      `SELECT u.username, u.approved, u.revoked, u.is_admin,
              u.created_at, u.approved_at, u.approved_by,
              (SELECT COUNT(*)::int FROM card_back_images i WHERE i.user_id = u.id)
                AS image_count
         FROM users u
        ORDER BY u.created_at DESC, u.username ASC`
    );
    return rows.map(r => ({
      username:    r.username,
      approved:    !!r.approved,
      revoked:     !!r.revoked,
      is_admin:    !!r.is_admin,
      created_at:  tsToMs(r.created_at),
      approved_at: tsToMs(r.approved_at),
      approved_by: r.approved_by,
      image_count: r.image_count,
    }));
  });

  app.post('/admin/users/:username/approve', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const target = req.params.username;
    if (!USERNAME_RE.test(target)) return reply.code(404).send({ error: 'not found' });

    const { rowCount } = await query(
      `UPDATE users
          SET approved    = TRUE,
              revoked     = FALSE,
              revoked_at  = NULL,
              approved_at = now(),
              approved_by = $1
        WHERE username = $2`,
      [u.username, target]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post('/admin/users/:username/revoke', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const target = req.params.username;
    if (!USERNAME_RE.test(target)) return reply.code(404).send({ error: 'not found' });

    const { rows } = await query(
      'SELECT id, is_admin FROM users WHERE username = $1',
      [target]
    );
    const targetUser = rows[0];
    if (!targetUser) return reply.code(404).send({ error: 'not found' });
    // Refuse admin-on-admin via the API. Demote in the DB if needed.
    if (targetUser.is_admin) return reply.code(403).send({ error: 'cannot revoke admin' });

    await query(
      'UPDATE users SET revoked = TRUE, revoked_at = now() WHERE id = $1',
      [targetUser.id]
    );
    // Wipe sessions so any active cookies stop working immediately.
    await deleteAllUserSessions(targetUser.id);
    return { ok: true };
  });

  app.get('/admin/images', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const { rows } = await query(
      `SELECT i.id, i.name, i.data_url, i.added_at, u.username AS owner
         FROM card_back_images i
         JOIN users u ON u.id = i.user_id
        ORDER BY i.added_at DESC, i.id DESC`
    );
    return rows.map(r => ({
      id:      Number(r.id),
      owner:   r.owner,
      name:    r.name,
      dataUrl: r.data_url,
      addedAt: tsToMs(r.added_at),
    }));
  });

  app.delete('/admin/images/:id', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const idStr = req.params.id;
    if (!/^[0-9]{1,20}$/.test(idStr)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { rowCount } = await query(
      'DELETE FROM card_back_images WHERE id = $1',
      [idStr]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  // Lightweight pending-approval count for the admin-only banner. Client
  // has a fallback that counts /admin/users itself, so this is just an
  // optimisation — but the banner polls every 60 s, so a cheap query
  // matters more here than for one-shot reads.
  app.get('/admin/users/pending-count', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c
         FROM users
        WHERE approved = FALSE AND revoked = FALSE`
    );
    return { count: rows[0].c };
  });

  app.get('/admin/bugs', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const { rows } = await query(
      `SELECT id, username, title, description, diagnostics,
              fixed, fixed_at, fixed_by, fixed_note, created_at,
              kind, attachment_file, attachment_mime, attachment_size
         FROM bug_reports
        ORDER BY created_at DESC, id DESC`
    );
    return rows.map(bugRowToRecord);
  });

  app.post('/admin/bugs/:id/fix', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const idStr = req.params.id;
    if (!/^[0-9]{1,20}$/.test(idStr)) {
      return reply.code(404).send({ error: 'not found' });
    }

    const body = req.body || {};
    let note = null;
    if (typeof body.note === 'string') {
      const t = body.note.trim();
      if (t) {
        if (t.length > FIX_NOTE_MAX) {
          return reply.code(400).send({ error: 'note too long' });
        }
        note = t;
      }
    }

    const { rows } = await query(
      `UPDATE bug_reports
          SET fixed      = TRUE,
              fixed_at   = now(),
              fixed_by   = $1,
              fixed_note = $2
        WHERE id = $3
        RETURNING id, username, title, description, diagnostics,
                  fixed, fixed_at, fixed_by, fixed_note, created_at,
              kind, attachment_file, attachment_mime, attachment_size`,
      [u.username, note, idStr]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return bugRowToRecord(rows[0]);
  });

  app.post('/admin/bugs/:id/unfix', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const idStr = req.params.id;
    if (!/^[0-9]{1,20}$/.test(idStr)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { rows } = await query(
      `UPDATE bug_reports
          SET fixed      = FALSE,
              fixed_at   = NULL,
              fixed_by   = NULL,
              fixed_note = NULL
        WHERE id = $1
        RETURNING id, username, title, description, diagnostics,
                  fixed, fixed_at, fixed_by, fixed_note, created_at,
              kind, attachment_file, attachment_mime, attachment_size`,
      [idStr]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return bugRowToRecord(rows[0]);
  });

  app.delete('/admin/bugs/:id', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const idStr = req.params.id;
    if (!/^[0-9]{1,20}$/.test(idStr)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { rows } = await query(
      'DELETE FROM bug_reports WHERE id = $1 RETURNING attachment_file',
      [idStr]
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    if (rows[0].attachment_file) await removeAttachment(rows[0].attachment_file);
    return reply.code(204).send();
  });

  // The report's screenshot / recording. Admin only — reporters attach their
  // own screens, which can show anything. Sandbox CSP + nosniff so even a
  // mislabelled file can never run as a page on this origin.
  app.get('/admin/bugs/:id/attachment', async (req, reply) => {
    const u = requireAdmin(req, reply);
    if (!u) return;
    const idStr = req.params.id;
    if (!/^[0-9]{1,20}$/.test(idStr)) return reply.code(404).send({ error: 'not found' });
    const { rows } = await query(
      'SELECT attachment_file, attachment_mime FROM bug_reports WHERE id = $1', [idStr]);
    const p = rows[0] && attachmentPath(rows[0].attachment_file);
    if (!p || !extForMime(rows[0].attachment_mime)) return reply.code(404).send({ error: 'not found' });
    let st;
    try { st = await stat(p); } catch (_) { return reply.code(404).send({ error: 'not found' }); }
    return reply
      .header('Content-Type', rows[0].attachment_mime)
      .header('Content-Length', st.size)
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox")
      .header('Cache-Control', 'private, max-age=3600')
      .send(createReadStream(p));
  });
}
