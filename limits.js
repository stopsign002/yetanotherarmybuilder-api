// Shared helpers for per-route rate limits and client-facing errors.
//
// @fastify/rate-limit is registered with `global: false` in server.js, so a
// route is limited only when it carries `config.rateLimit`. The helpers here
// build that object for the signed-in routes.

// An error whose body is safe to show the client. server.js's error handler
// sends `publicBody` as-is with `statusCode`; anything without it keeps
// Fastify's default 4xx shape, and every 5xx answers `{ error: 'internal' }`.
export function publicError(statusCode, error) {
  return Object.assign(new Error(error), { statusCode, publicBody: { error } });
}

// Key a limit on the signed-in user, falling back to the client IP for
// anonymous callers (they get a 401 from the handler anyway, but they still
// count, so a flood of anonymous requests is limited too). Prefixed so a user
// id can never collide with an IP string.
export function userOrIpKey(req) {
  return req.user ? `u:${req.user.user_id}` : `ip:${req.ip}`;
}

// Route options for a per-user limit: `max` requests per `timeWindow`
// ('1 minute', '1 hour', or ms). Spread into the route's options object.
//
// `hook: 'preHandler'` is load-bearing. The plugin's default hook is
// onRequest, which runs before server.js's session-loading preHandler, so
// `req.user` would always be null there and every key would silently fall back
// to the IP. Route-level preHandler hooks run after the app-level one, so the
// user is resolved by the time the key is computed. The cost is that a JSON
// body is parsed before the limit is checked; multipart (POST /bugs) is not,
// since its parts are only read inside the handler.
//
// `message`, if given, becomes the 429 body's `error` (with the retry time
// appended), which the bug-report and image clients show to the user.
export function perUserLimit(max, timeWindow, message) {
  const rateLimit = { max, timeWindow, hook: 'preHandler', keyGenerator: userOrIpKey };
  if (message) {
    rateLimit.errorResponseBuilder = (req, ctx) =>
      publicError(ctx.statusCode || 429, `${message} Try again in ${ctx.after}.`);
  }
  return { config: { rateLimit } };
}
