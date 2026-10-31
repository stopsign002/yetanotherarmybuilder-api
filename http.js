// Shared reply helpers. Every route answers errors as `{ error }` with an
// explicit status; this is the one place that shape is spelled.

// Wording the signed-in routes have always used. `requireUser` defaults to the
// short form (images, bugs, admin); armies, state and auth pass NOT_SIGNED_IN.
// Both are client-visible, so a route keeps whichever it had.
export const NOT_SIGNED_IN = 'Not signed in.';

export function reject(reply, status, error) {
  return reply.code(status).send({ error });
}

// Returns the signed-in user, or answers 401 and returns null — callers do
// `const u = requireUser(req, reply); if (!u) return;`.
export function requireUser(req, reply, error = 'unauthorized') {
  if (!req.user) {
    reject(reply, 401, error);
    return null;
  }
  return req.user;
}

// 401 when anonymous, 403 when signed in but not an admin.
export function requireAdmin(req, reply) {
  const u = requireUser(req, reply);
  if (!u) return null;
  if (!u.is_admin) {
    reject(reply, 403, 'forbidden');
    return null;
  }
  return u;
}
