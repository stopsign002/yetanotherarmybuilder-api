// Shared input validators and the client-timestamp parser.

// Client-generated army ids: short base36-ish strings, but accept anything
// URL-safe up to 128 chars to keep this future-proof if the client switches
// to UUIDs or longer ids later.
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

// Numeric ids are capped at 18 digits: always within BIGINT, so an oversized
// id is a 404 instead of a Postgres "out of range" 500.
const NUMERIC_ID_RE = /^[0-9]{1,18}$/;
export function isNumericId(s) {
  return NUMERIC_ID_RE.test(s);
}

export function parseTs(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

// SQL for a client timestamp parameter clamped to the server's clock. A client
// may be early but never in the future — see the note in lww.js.
export function clampedTs(param) {
  return `LEAST(${param}::timestamptz, now())`;
}

// pg returns BIGINT columns (user ids, serial ids, sizes) as strings.
export const asNumber = (v) => Number(v);
