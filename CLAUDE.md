# CLAUDE.md (api)

## What this is

Fastify backend for yaab. Provides username/password auth, per-user army sync, and an opaque KV state-bag, all behind a sliding one-year server-stored session cookie. Served behind the host's shared Caddy at `https://yaab.thewheeliebois.com/api/*`; Caddy strips the `/api` prefix before reaching the container, so route handlers register clean paths (`/auth/login`, not `/api/auth/login`). Container is named `yaab-api`, joins the external `web` Docker network, and reaches Postgres at host `postgres`. See `~/sites/CLAUDE.md` for the host infra and `../CLAUDE.md` for the original spec.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | Fastify entry. Registers `@fastify/cookie`, `@fastify/rate-limit` (`global: false`) and `@fastify/multipart` (POST /bugs only), attaches the pg pool's `'error'` listener, sets the app error handler (see "Errors"), decorates `req.user`, runs the session-loading `preHandler`, mounts `authRoutes` / `armiesRoutes` / `stateRoutes` / `imagesRoutes` / `adminRoutes` / `bugsRoutes`, exposes `/healthz`. Calls `waitForDb()` then `migrate()`, then starts two timers — the session prune (24 h) and the pending-signup notice sweep (5 min) — before `app.listen`. SIGINT/SIGTERM close the server and the pg pool. |
| `db.js` | `pg.Pool` (max 10), `query()`, `waitForDb()` (30 retries × 1s), `migrate()`. Holds the `SCHEMA` DDL constant. |
| `sessions.js` | Cookie name + TTL constants. `createSession`, `loadSession`, `touchSession`, `pruneSessions`, `deleteSession`, `deleteAllUserSessions`, `cookieOpts`, `clearCookieOpts`. |
| `auth.js` | All `/auth/*` routes. argon2id hashing, recovery-code generation, per-route 5/min rate limit on register/login/recover (per IP) and change-password (per user), the 25-pending registration cap. |
| `limits.js` | `perUserLimit(max, window, message?)` route options (per-user key, IP fallback, `hook: 'preHandler'`), `userOrIpKey`, `publicError(status, error)`. |
| `signup-notify.js` | `notifyPendingSignups()` / `kickSignupNotice()`: the operator's "new pending account" mail, coalesced to at most one an hour through the `notify_state` table. |
| `armies.js` | All `/armies/*` routes. Client-id regex `ID_RE`, LWW upsert via `INSERT … ON CONFLICT … CASE`. |
| `state.js` | `GET /state` and `PUT /state`. Single KV bag per user, same LWW pattern as armies. |
| `images.js` | All `/images*` routes — per-user card-back image library for Cards mode. Route-level `bodyLimit: 10_000_000`; advisory-lock-protected count→insert for the 30-image cap. |
| `admin.js` | All `/admin/*` routes — site-operator panel: approve/revoke users, list+delete any user's image, manage bug reports, lightweight pending-approval counter. Every handler runs through `requireAdmin()` (401 unauth, 403 non-admin). |
| `attachments.js` | Bug-report attachment storage: MIME allowlist (raster images + video, never SVG), streams to `BUG_ATTACH_DIR` (`/data/bug-attachments`, bind-mounted from `../data/bug-attachments` — under `data/` so `backup.sh` skips it), removal on delete or failed insert. |
| `bugs.js` | `POST /bugs` only — any signed-in user can submit a bug report, within the abuse limits listed under "Bugs". Admin browsing/management lives in `admin.js` under `/admin/bugs`. |
| `Dockerfile` | Two-stage `node:22-bookworm-slim` build (build stage installs argon2 native deps and runs `npm ci --omit=dev` from the lockfile; runtime stage runs as `node`). `EXPOSE 3000`, `CMD ["node", "server.js"]`. |
| `package.json` | ESM (`"type": "module"`), Node ≥22. Deps: `fastify@^5`, `@fastify/cookie@^11`, `@fastify/rate-limit@^10`, `@fastify/multipart@^9`, `pg@^8`, `argon2@^0.41`. |
| `package-lock.json` | Pins the whole tree (committed 2026-10-30, generated from the then-live image's `node_modules`, so it changed no versions: fastify 5.12.7, @fastify/multipart 9.4.0, @fastify/rate-limit 10.3.0, @fastify/cookie 11.1.3, pg 8.23.1, argon2 0.41.1). See "Dependencies". |
| `.dockerignore` | Excludes `node_modules`, `.git`, `.env*`, `npm-debug.log`. |

## Endpoints

All routes return JSON unless noted. Bodies are `application/json` (POST /bugs also takes multipart). Cookie `yaab_sid` carries the session — set on login and recover (**not** on register: the account waits for approval), cleared on logout.

### Rate limits

`@fastify/rate-limit` is registered with `global: false`, so only these routes are limited. Counters live in process memory and reset on every restart.

| Route | Limit | Keyed on | Over the limit |
|---|---|---|---|
| `POST /auth/register`, `/auth/login`, `/auth/recover` | 5 / minute | client IP | plugin default `429 { statusCode, error: "Too Many Requests", message }` |
| `POST /auth/change-password` | 5 / minute | user id (IP if anonymous) | same default shape |
| `POST /bugs` | 5 / hour | user id (IP if anonymous) | `429 { error: "Too many reports sent. Try again in …" }` |
| `POST /images` | 30 / hour | user id (IP if anonymous) | `429 { error: "Too many image uploads. Try again in …" }` |

The per-user limits use `limits.js:perUserLimit()`, which sets `hook: 'preHandler'` — **required**, because the plugin's default `onRequest` hook runs before `server.js` loads the session, so `req.user` would be null and every key would silently become the IP. The cost is that a JSON body is parsed before the limit is checked (multipart is not: `/bugs` reads its parts inside the handler). IPs come from `X-Forwarded-For` (`trustProxy: true`); Caddy overwrites that header, so WAN clients cannot pick their own key, but a container on the `web` network that reaches `yaab-api:3000` directly could.

### Errors

`server.js`'s `setErrorHandler`: any thrown error with status ≥ 500 (or none — e.g. a Postgres error) is logged at `error` with its stack and answers **`{ error: "internal" }`**, so no Postgres message, SQLSTATE or constraint name reaches a client. A thrown 4xx carrying `publicBody` (`limits.js:publicError`) sends that body; every other 4xx (invalid JSON, body too large, the auth routes' 429) goes to Fastify's default handler and keeps its usual `{ statusCode, code?, error, message }` shape. Handlers that `reply.code(n).send(...)` directly are unaffected.

### Health

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/healthz` | — | `200 { ok: true }` |

### Auth

`register`, `login` and `recover` are capped at **5/min/IP**, `change-password` at **5/min per user** (see "Rate limits").

| Method | Path | Auth | RL | Body | Success | Errors |
|---|---|---|---|---|---|---|
| POST | `/auth/register` | — | 5/min | `{ username, password }` | `200 { username, recoveryCode, pending: true }`; **does NOT set a cookie** — admin must approve first | `400` bad input, `409` username taken (also when a concurrent registration of the same name wins the race), `503` sign-ups paused (25 accounts already pending) |
| POST | `/auth/login` | — | 5/min | `{ username, password }` | `200 { username, is_admin }` + sets cookie | `400` missing fields or a username that fails the format regex, `401` invalid creds, `403 { error: "pending_approval" }`, `403 { error: "revoked" }` |
| POST | `/auth/logout` | — | — | — | `204` + clears cookie | — |
| GET | `/auth/me` | session | — | — | `200 { username, is_admin }` | `401` not signed in (revoked users are treated as not-signed-in by the preHandler) |
| POST | `/auth/recover` | — | 5/min | `{ username, recoveryCode, newPassword }` | `200 { username, recoveryCode }` (NEW code) + sets cookie; **invalidates all other sessions** | `400` bad input (incl. a malformed username), `401` invalid code, `403 pending_approval`, `403 revoked` |
| POST | `/auth/change-password` | session | 5/min/user | `{ oldPassword, newPassword }` | `200 { ok: true }`; invalidates all sessions except current | `400` bad input, `401` not signed in / wrong old pw, `429` |

`username` regex: `/^[A-Za-z0-9_.-]{3,32}$/` — enforced on register, and on login/recover before the value reaches Postgres (a NUL byte used to come back as a raw 500 with SQLSTATE `22021`; the format is public, so the 400 leaks nothing). Usernames are unique **case-sensitively**. `password`: 8–256 chars, no complexity rules. Login does an argon2 verify against a dummy hash when the user is missing to flatten timing (measured 202 ms vs 206 ms; do not remove). Register's `409` does reveal that a name exists — only login is existence-blind.

**Registration brakes.** Register needs no login, so: (1) it is refused with `503` once **25** accounts are pending (`approved = FALSE AND revoked = FALSE`), checked before the argon2 work; nothing prunes pending rows, so an admin approving or revoking is what reopens sign-ups. (2) The operator mail is **coalesced to at most one an hour** (`signup-notify.js`): the first registration in a quiet hour mails at once (`[yaab] Access request: <name>`), later ones are batched and the 5-minute sweep in `server.js` sends `[yaab] N new accounts awaiting approval` once the hour is up. Accounts approved or revoked in the meantime are not counted. State is the `notify_state` row, so restarts neither re-send nor forget. Reason: the mailer is the host-wide Gmail relay (~500/day) that backup, restore-drill and login-watch alerts also use; per-registration mail at 5/min/IP could exhaust it in under two hours. Known gaps: a mail the mailer fails to deliver still uses the slot, and an INSERT that commits after a concurrent claim can be skipped by the watermark — the admin pending banner always shows the true count.

### Armies

All require a session. Body limit is the global Fastify `bodyLimit: 2_000_000`. Per-field limits below.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/armies` | — | `200 [{ id, name, updated_at }]` ordered by `updated_at DESC` | `401` |
| GET | `/armies/:id` | — | `200 { id, name, payload, updated_at }` | `400` bad id, `401`, `404` |
| PUT | `/armies/:id` | `{ name, payload, updated_at }` | `200 { id, updated_at, applied }` (server-canonical ts; LWW — see below) | `400` bad id/name/payload, `401`, `403` id belongs to another user |
| DELETE | `/armies/:id` | — | `204` | `400` bad id, `401` |

Field caps: `name ≤ 200`, `payload ≤ 1_000_000`, `id` matches `/^[A-Za-z0-9_-]{1,128}$/`. `updated_at` is parsed with `Date.parse`; if missing/invalid the server uses `new Date()`. Either way it is clamped to the DB clock (`LEAST(ts, now())`) before it is compared or stored — a client may be early but never in the future. `applied` is `true` when this write landed and `false` when the row kept a newer write.

### State (KV bag)

Single per-user opaque blob. Same LWW behavior as armies.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/state` | — | `200 { payload, updated_at }`, or `200 null` if none | `401` |
| PUT | `/state` | `{ payload, updated_at }` | `200 { updated_at, applied }` | `400` bad payload, `401` |

`payload ≤ 1_000_000` chars. `updated_at` parsing, clamping and `applied` identical to armies.

### Images (card-back library)

Per-user library of card-back images for Cards mode (frontend module: `app/js/ui/cards-mode.js`, `ImageStore`). Anon users keep their library in browser IndexedDB; signed-in users hit these endpoints so the library follows them across devices. Full client contract is in `app/docs/CARDS_IMAGES_API.md`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/images` | — | `200 [{ id, name, dataUrl, addedAt }]` newest first | `401` |
| POST | `/images` | `{ name, dataUrl }` | `200 { id, name, dataUrl, addedAt }` | `400` bad input, `401`, `409 { error:"limit", limit, count }` over cap, `413` per-image too large |
| DELETE | `/images/:id` | — | `204` | `401`, `404` (also returned when the row exists but belongs to another user — never leak existence) |

`POST /images` is limited to **30 per hour per user** (`429`, see "Rate limits"). Numeric `:id` params here and under `/admin/*` match `/^[0-9]{1,18}$/` — 18 digits always fits a BIGINT, so a longer id is a `404` rather than a Postgres out-of-range 500.

Caps + validation: `name` 1-200 chars (trimmed); `dataUrl` ≤ 7_000_000 chars (≈ 5 MB binary); MIME allowlist `image/png|jpeg|webp|gif|svg+xml` enforced via `DATA_URL_RE` prefix; per-user library cap **30** images. POST has a route-level `bodyLimit: 10_000_000` so a single upload can hold a 5 MB binary plus base64 + JSON envelope without raising the global 2 MB Fastify limit. The cap check + insert run inside one transaction with a `pg_advisory_xact_lock(user_id)` so concurrent POSTs from the same user can't race past the limit. `id` is returned as a JS Number (BIGSERIAL cast in `rowToRecord`); the client treats it opaquely. `addedAt` is ms-epoch.

### Admin (site-operator panel)

All routes require `req.user.is_admin === true` — `requireAdmin()` returns 401 unauthenticated, 403 authenticated-but-not-admin. Full client contract: `app/docs/ADMIN_API.md`.

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/admin/users` | — | `200 [{ username, approved, revoked, is_admin, created_at, approved_at, approved_by, image_count }]` newest first; all timestamps are ms-epoch | `401`, `403` |
| POST | `/admin/users/:username/approve` | — | `200 { ok: true }`; sets `approved=TRUE, revoked=FALSE, revoked_at=NULL, approved_at=now(), approved_by=<admin>` | `401`, `403`, `404` |
| POST | `/admin/users/:username/revoke` | — | `200 { ok: true }`; sets `revoked=TRUE, revoked_at=now()`, **then deletes every session row for that user** so active cookies stop working immediately | `401`, `403`, `404`, `403 cannot revoke admin` |
| GET | `/admin/images` | — | `200 [{ id, owner, name, dataUrl, addedAt }]` newest first across all users | `401`, `403` |
| DELETE | `/admin/images/:id` | — | `204` | `401`, `403`, `404` |
| GET | `/admin/users/pending-count` | — | `200 { count }` — count of `approved=FALSE AND revoked=FALSE`. Optional optimisation; client falls back to counting `/admin/users` itself | `401`, `403` |
| GET | `/admin/bugs` | — | `200 [{ id, username, title, description, diagnostics, fixed, fixed_at, fixed_by, fixed_note, created_at, kind, attachment_url, attachment_mime, attachment_size }]` newest first; ts ms-epoch | `401`, `403` |
| GET | `/admin/bugs/:id/attachment` | — | the report's file, streamed with its MIME, `nosniff` and a `sandbox` CSP (Caddy sets the same CSP for this path — its site-wide `header` would otherwise replace ours) | `401`, `403`, `404` |
| POST | `/admin/bugs/:id/fix` | optional `{ note }` | `200 <updated record>`; sets `fixed=TRUE, fixed_at=now(), fixed_by=<admin>, fixed_note=note??NULL` | `400` note too long, `401`, `403`, `404` |
| POST | `/admin/bugs/:id/unfix` | — | `200 <updated record>`; clears all `fixed_*` columns | `401`, `403`, `404` |
| DELETE | `/admin/bugs/:id` | — | `204` | `401`, `403`, `404` |

`approve` doubles as "reinstate after revoke". `revoke` refuses to act on `is_admin=TRUE` targets — admin demotion has to happen via the DB so a compromised admin account can't hand the keys out through the API.

### Bugs (user-submitted reports)

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/bugs` | session | JSON `{ kind?, title, description, diagnostics?, email? }`, **or** `multipart/form-data` with the same text fields + one optional `attachment` file part (image/video only, ≤50 MB) | `200 { id }` | `400` empty/oversized/malformed field, `401`, `413` file too large or the user's attachment quota full, `415` not an image/video (SVG is refused on purpose), `429` rate limit or open-report cap, `507` attachment refused because the disk is low |

Caps: `title` ≤ 200, `description` ≤ 4000, `email` ≤ 254 chars. `diagnostics` longer than 16_000 chars is **truncated** to 16_000 (ending `…(truncated by server)…`), not refused — the client's own trim ran 14 chars over the old hard cap and got every long report refused. The multipart `fieldSize` is 64 KiB (it is in bytes), so 16_000 chars of 4-byte UTF-8 survive the multipart path whole and both paths truncate the same way.

**Abuse limits** (api#2 — each report can write a 50 MB file to the host's root filesystem and queues work for the hourly `bug-fixer.py`):

| Limit | Value | Answer |
|---|---|---|
| Reports per user | 5 / hour (route rate limit) | `429 { error }` |
| Open (`fixed = FALSE`) reports per user | 10 | `429 { error }` |
| Attachment bytes per user | 200 MB, summed over every row that still has a file (fixed or not — the file stays until an admin deletes the report) | `413 { error }` |
| Free space on `BUG_ATTACH_DIR` (`fs.statfs`, multipart requests only) | refuse below 2 GB | `507 { error }`; JSON reports still go through |

The open-count, quota and disk checks run once before any of the upload is read, and the count and quota run again inside the INSERT's transaction under `pg_advisory_xact_lock(7301, hashtext(username))`, so concurrent submissions cannot slip past them (the two-int lock form is a different key space from the images cap's one-bigint lock). An attachment that would cross the quota is unlinked before the `413`. If `statfs` fails the floor is skipped with a `warn` log rather than blocking reports. Limits are keyed on the `username` snapshot, since `bug_reports` has no user FK. `username` is stored as a snapshot string (not a FK to `users.username`), so reports survive revoke or future user-deletion.

`email` is optional and used for exactly one thing: telling the reporter their report was resolved. A malformed address is **rejected** rather than dropped — silently discarding it means the reporter waits for a note that never arrives. This route deliberately sends **no** mail on submission; `~/sites/base/bug-fixer.py` (hourly) mails either "fixed" or "needs a human" and is the only sender of reporter notifications, including for reports an admin fixes by hand via `/admin/bugs/:id/fix`.

Columns the hourly fixer owns — the API only ever writes `email`: `fix_mode` (`'auto'` → verified and applied unattended, `'intervention'` → a human finished it), `fix_report` (the full JSON verdict), `escalated_at` (parked awaiting a human; stops the hourly retry), `attempts`, `notified_at` (reporter has been told).

## Auth + sessions

- Hashing: **argon2id**, default params (`argon2.hash(value, { type: argon2.argon2id })`). Same for password and recovery-code hashes.
- Session id: 32 random bytes, `base64url`-encoded (`crypto.randomBytes(32).toString('base64url')`).
- TTL: **365 days, sliding** (`SESSION_TTL_MS` in `sessions.js`; was a hard 30 days from login until 2026-10-25). Stored in `sessions` table; `loadSession` filters `expires_at > now()`.
- Renewal: in the `preHandler`, when a session loads for a non-revoked user and `expires_at - now() < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS` (24 h, i.e. the row was last extended more than a day ago), `touchSession(sid)` sets `expires_at = now() + 365 days` and the handler re-sends the `yaab_sid` cookie so the browser's `Max-Age` moves with it. Skipped for `/auth/logout`; a touch failure is logged (`warn`) and never fails the request. Old 30-day rows extend on their next request — no migration.
- Prune: `pruneSessions()` (`DELETE FROM sessions WHERE expires_at < now()`) runs once after `migrate()` and every 24 h (`setInterval(...).unref()`); the row count is logged at `info`.
- Cookie: name **`yaab_sid`**, attrs `{ path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: <ttl-seconds> }`. Clear-cookie uses the same attrs with `maxAge: 0`. `@fastify/cookie` is registered with `secret: process.env.SESSION_SECRET`, but **no `setCookie` passes `signed: true`, so the secret is inert**: the cookie is the bare session id, which is safe because it is 256 random bits looked up server-side.
- Recovery code: generated at register with `randomBytes(18).toString('base64url')`, returned **once** in the register response, stored only as an argon2 hash. `/auth/recover` rotates it (returns a fresh one) and **deletes all sessions for that user** before issuing a new one. `/auth/change-password` keeps the current session but deletes all others.
- `req.user`: populated by the `preHandler` hook in `server.js` — reads `req.cookies.yaab_sid`, calls `loadSession`, attaches `{ user_id: Number(...), username, is_admin, session_id }` (note: `user_id` is coerced from BIGINT-as-string to JS number here; downstream code that compares against a `row.user_id` from a fresh query must do the same — see armies.js's `Number(row.user_id) !== u.user_id`). The preHandler also leaves `req.user` null when the loaded session belongs to a `revoked = TRUE` user, so a revoked user's still-valid cookie behaves like signed-out (the session row gets wiped on revoke too — belt-and-braces).
- **Approval gating**: register doesn't issue a cookie. Login + recover both bounce `revoked=TRUE` users with `403 { error: "revoked" }` and unapproved users with `403 { error: "pending_approval" }`. The bounce is **after** credential verification so existence isn't leaked via timing or status code on bad creds. New admins are made by setting `is_admin=TRUE` directly in the DB — there is intentionally no `/admin/users/:username/promote` endpoint.

## Schema

All seven tables live in the default schema. Created by `migrate()` on every startup via `CREATE TABLE IF NOT EXISTS` so it's safe to re-run. `users` and `bug_reports` also pick up columns from later migrations (two one-shot `DO $$` blocks and an `ADD COLUMN IF NOT EXISTS`) — the DDL below shows the end state.

```sql
CREATE TABLE users (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  password            TEXT NOT NULL,           -- argon2id hash
  recovery_code_hash  TEXT NOT NULL,           -- argon2id hash of one-time recovery code
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Added by the approval-gating DO-block (see below):
  approved            BOOLEAN     NOT NULL DEFAULT FALSE,
  approved_at         TIMESTAMPTZ NULL,
  approved_by         TEXT        NULL,
  revoked             BOOLEAN     NOT NULL DEFAULT FALSE,
  revoked_at          TIMESTAMPTZ NULL,
  is_admin            BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE TABLE sessions (
  session_id  TEXT PRIMARY KEY,                -- 32 bytes base64url
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE armies (
  id          TEXT PRIMARY KEY,                -- client-generated; see "ID format"
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  payload     TEXT NOT NULL,                   -- opaque YAAB1: blob
  updated_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX armies_user_idx ON armies (user_id);

CREATE TABLE state_bags (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE card_back_images (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data_url    TEXT NOT NULL,                   -- data:image/...;base64,...
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX card_back_images_user_idx
  ON card_back_images (user_id, added_at DESC);

CREATE TABLE bug_reports (
  id               BIGSERIAL PRIMARY KEY,
  username         TEXT        NOT NULL,        -- submitter snapshot; NOT a FK by design
  title            TEXT        NOT NULL,
  description      TEXT        NOT NULL,
  diagnostics      TEXT        NULL,
  fixed            BOOLEAN     NOT NULL DEFAULT FALSE,
  fixed_at         TIMESTAMPTZ NULL,
  fixed_by         TEXT        NULL,
  fixed_note       TEXT        NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Added by the bug-fixer DO-block (guarded on bug_reports.email):
  email            TEXT        NULL,            -- reporter's optional address (API writes this)
  fix_mode         TEXT        NULL,            -- 'auto' | 'intervention' (bug-fixer.py owns these five)
  fix_report       TEXT        NULL,
  escalated_at     TIMESTAMPTZ NULL,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  notified_at      TIMESTAMPTZ NULL,
  -- Added by ALTER TABLE … ADD COLUMN IF NOT EXISTS:
  kind             TEXT        NOT NULL DEFAULT 'bug',   -- 'bug' | 'feature'
  attachment_file  TEXT        NULL,            -- server-generated filename under BUG_ATTACH_DIR
  attachment_mime  TEXT        NULL,
  attachment_size  BIGINT      NULL
);
CREATE INDEX bug_reports_created_at_desc ON bug_reports (created_at DESC);
CREATE INDEX bug_reports_open            ON bug_reports (fixed) WHERE fixed = FALSE;
CREATE INDEX bug_reports_actionable      ON bug_reports (created_at)
  WHERE fixed = FALSE AND escalated_at IS NULL;   -- the hourly fixer's work queue

-- Coalescing state for operator mails (signup-notify.js). Seeded by migrate():
-- ('signup', '-infinity', <now() on the boot that created it>).
CREATE TABLE notify_state (
  kind              TEXT        PRIMARY KEY,
  sent_at           TIMESTAMPTZ NOT NULL,       -- last mail sent ('-infinity' = never)
  notified_through  TIMESTAMPTZ NOT NULL        -- created_at of the newest account that mail covered
);
```

The bug-fixer DO-block, when it first ran, also stamped `notified_at = now()` on every already-fixed report so the hourly job did not mail the backlog. The `ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS …` runs on every boot and takes an ACCESS EXCLUSIVE lock even as a no-op, so a long transaction on `bug_reports` (e.g. the bug-fixer) can delay boot.

### In-place UUID→TEXT migration

Earlier deploys created `armies.id` as `UUID` (per the original spec). The client emits short base36-ish ids, so `db.js` runs an idempotent `DO $$ … $$` block on every startup: if `information_schema.columns` reports `armies.id` as `uuid`, it does `ALTER TABLE armies ALTER COLUMN id TYPE TEXT USING id::text`. Safe to run forever — the conditional makes it a no-op once converted.

### Approval-gating migration

Adds the six approval/admin columns to `users`, then backfills + bootstraps. Wrapped in a `IF NOT EXISTS users.approved` guard so the backfill (every existing user → `approved=TRUE`) only runs once — subsequent boots are a no-op:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'approved'
  ) THEN
    ALTER TABLE users
      ADD COLUMN approved     BOOLEAN     NOT NULL DEFAULT FALSE,
      ADD COLUMN approved_at  TIMESTAMPTZ NULL,
      ADD COLUMN approved_by  TEXT        NULL,
      ADD COLUMN revoked      BOOLEAN     NOT NULL DEFAULT FALSE,
      ADD COLUMN revoked_at   TIMESTAMPTZ NULL,
      ADD COLUMN is_admin     BOOLEAN     NOT NULL DEFAULT FALSE;
    UPDATE users
       SET approved = TRUE, approved_at = COALESCE(created_at, now());
    UPDATE users SET is_admin = TRUE WHERE username = 'stopsign002';
  END IF;
END $$;
```

**On a fresh database this block bootstraps nobody.** On the very first boot `users` is empty, so the backfill and the `is_admin` UPDATE match no rows — whatever username is written there — and the guard then makes the block a no-op forever. A fresh install therefore has **no admin**, and the operator's own registration sits pending like any other, so they cannot sign in. The only way in is psql, after registering through the app:

```
docker exec -i postgres psql -U postgres -d yaab_db -c \
  "UPDATE users SET approved = TRUE, approved_at = now(), is_admin = TRUE WHERE username = '<you>';"
```

The `'stopsign002'` bootstrap only ever worked on the existing production DB, where the users predated the migration.

## Last-write-wins

Both `PUT /armies/:id` and `PUT /state` use a single-statement `INSERT … ON CONFLICT … DO UPDATE` where each updatable column is wrapped in a `CASE` that compares `EXCLUDED.updated_at >= existing.updated_at`. If the incoming ts is older, the existing row is preserved and the `RETURNING updated_at` echoes the **stored** ts back to the client. The response also carries `applied` (stored ts equals the clamped incoming ts), because the upsert always "updates" the row — `rowCount` is 1 either way — and the echo alone cannot tell a lost write from a clamped clock. The incoming ts is clamped with `LEAST($n::timestamptz, now())` in the same statement: a device with a fast clock used to write a future-dated row and silently lock every other device out of that army until wall-clock time caught up (api#1).

```sql
-- armies upsert (abbrev.)
INSERT INTO armies (id, user_id, name, payload, updated_at)
     VALUES ($1, $2, $3, $4, LEAST($5::timestamptz, now()))
ON CONFLICT (id) DO UPDATE
       SET name       = CASE WHEN armies.user_id = EXCLUDED.user_id
                              AND EXCLUDED.updated_at >= armies.updated_at
                          THEN EXCLUDED.name       ELSE armies.name       END,
           payload    = CASE WHEN armies.user_id = EXCLUDED.user_id
                              AND EXCLUDED.updated_at >= armies.updated_at
                          THEN EXCLUDED.payload    ELSE armies.payload    END,
           updated_at = CASE WHEN armies.user_id = EXCLUDED.user_id
                              AND EXCLUDED.updated_at >= armies.updated_at
                          THEN EXCLUDED.updated_at ELSE armies.updated_at END
 RETURNING user_id, updated_at,
           (updated_at = LEAST($5::timestamptz, now())) AS applied;
```

A tighter timestamp comparison (e.g. epoch-ms `BIGINT` instead of `TIMESTAMPTZ`) was considered and dropped — Postgres `TIMESTAMPTZ` already compares at microsecond resolution, the client clock is the source of truth (clamped to the server's, never ahead of it), and ties (`>=` vs `>`) deterministically prefer the incoming write, which matches the frontend's "I just saved, my ts is canonical" expectation.

**Cross-user PUT.** The `armies` `ON CONFLICT (id)` matches by primary key only, so a user PUT'ing an id that already belongs to a different user would otherwise hit the `CASE WHEN armies.user_id = EXCLUDED.user_id …` guard, which evaluates false and leaves the row untouched. The handler then checks `Number(row.user_id) !== u.user_id` against the `RETURNING user_id` and returns `403 { error: 'Army belongs to another user.' }` **without writing**. Don't remove the `Number(...)` cast — `pg` returns `BIGINT` as a string and `'1' !== 1` would always 403.

## ID format

Armies use **client-generated** short ids — base36-ish, e.g. `mohlj4wwwwz84`. Validated with:

```js
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
```

The 128-char ceiling is intentional headroom in case the client switches to UUIDs or longer ids later. **Historical bug:** the original spec called for `UUID` ids and the route used a strict UUID regex, which rejected every real client id with `400 Bad army id.` Both the regex and the column type have been loosened (see UUID→TEXT migration above). If you ever tighten this regex, coordinate with the client's id generator.

## Operations

### Deploy

From the project root (`~/sites/sites/yetanotherarmybuilder/`):

```
docker compose up -d --build
```

The compose file builds `./api/` into the `yaab-api` container, joins external network `web`, and reads env from `.env` at the project root. No host ports are published — Caddy reaches the container as `yaab-api:3000` on the shared network.

### Migrations

Run automatically on every container start by `server.js`:

```
await waitForDb();   // 30 × 1s SELECT 1 retries
await migrate();     // pool.query(SCHEMA) — see below
await app.listen({ host: '0.0.0.0', port: PORT });
```

`SCHEMA` is, in order: the `CREATE TABLE/INDEX IF NOT EXISTS` statements, the UUID→TEXT `DO` block, the approval-gating `DO` block (guarded on `users.approved`), the bug-fixer `DO` block (guarded on `bug_reports.email`), the `ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS kind, attachment_*`, the `bug_reports_actionable` index, and the `notify_state` table plus its `INSERT … ON CONFLICT DO NOTHING` seed. It is sent as one multi-statement simple query, which Postgres runs as a single implicit transaction — a failed migration leaves nothing half-applied. Keep it one `pool.query` call.

There's no separate migration tool. Edit `SCHEMA` in `db.js` only with statements that are safe to run on an already-migrated DB.

### Dependencies

`package-lock.json` is committed and the Dockerfile runs `npm ci --omit=dev`, so a rebuild installs exactly the locked tree and fails loudly if the lock and `package.json` disagree. The base image is still the `node:22-bookworm-slim` tag (not a digest). The host has no node; to change a dependency, edit `package.json` and regenerate the lock in a scratch copy:

```
docker run --rm --user $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/w -w /w \
  node:22-bookworm-slim npm install --package-lock-only --ignore-scripts
```

then commit both files and `docker compose up -d --build`.

### Logs

```
docker logs yaab-api          # one-shot
docker logs -f yaab-api       # tail
```

Fastify writes structured JSON (pino) to stdout at `info` (override with `LOG_LEVEL` env) — two lines per request, `incoming request` and `request completed`. 5xx errors are logged at `error` with the stack by the app error handler; an idle Postgres connection dropped under the pool (a postgres restart, `pg_terminate_backend`) logs `idle pg client error` at `warn` and the process carries on — before the listener existed, that event crashed the API. The pending-signup notice logs `pending-signup notice sent` with a count.

### Inspect data

Postgres lives in the `base` compose stack on the same `web` network. Connect via the host's psql shell:

```
docker exec -i postgres psql -U postgres -d yaab_db
```

The site's per-user creds (`yaab_user` / `yaab_db`) are set in the project root `.env`'s `DATABASE_URL`. `yaab-api` connects to host `postgres` (the container DNS name on the `web` network), **not** `localhost`.

### Health check

```
curl https://yaab.thewheeliebois.com/api/healthz
# → {"ok":true}
```

It does not touch the database, so it answers `ok` while Postgres is unreachable — it proves the process is up, nothing more.

## Secrets

`.env` lives at the **project root**, not inside `api/`:

```
~/sites/sites/yetanotherarmybuilder/.env
```

Standard keys:

| Key | Notes |
|---|---|
| `DATABASE_URL` | `postgres://yaab_user:<pw>@postgres:5432/yaab_db` |
| `SESSION_SECRET` | Passed to `@fastify/cookie` but **inert**: no cookie is set with `signed: true` (see "Auth + sessions"). Keep it set; rotating it does nothing. |
| `NODE_ENV` | `production` in deploys. |
| `PORT` | `3000`. Listen host is hardcoded `0.0.0.0`. |
| `MAILER_URL` | Shared mailer endpoint (`http://mailer:3000/send`). Unset → operator mails are silently skipped (`mail.js`). |
| `MAILER_TOKEN` | Bearer token for the mailer. Same skip rule. |
| `BUG_ATTACH_DIR` | Attachment directory inside the container; default `/data/bug-attachments` (the compose bind mount). The disk floor is measured here. |
| `LOG_LEVEL` | Pino level, default `info`. |

Standard caveats: `chmod 600 .env`, never echo to chat output, never commit. `.dockerignore` excludes `.env*` from the build context.

## Don't break

- **Cookie name `yaab_sid`.** The frontend's `js/app/auth.js` (and the sync layer) assume this exact name. Renaming requires a coordinated frontend change and silent-logs-everyone-out at deploy.
- **Response shapes** — the frontend's `js/app/sync.js` reads these literal keys:
  - `PUT /armies/:id` → `{ id, updated_at, applied }`. `applied` is what runOp reads to know whether its write landed; on older builds without it the client falls back to comparing `updated_at` against the ts it sent.
  - `PUT /state` → `{ updated_at, applied }` (same meaning as on armies).
  - `GET /armies` → array of `{ id, name, updated_at }` (summary, no `payload`).
  - `GET /armies/:id` → full `{ id, name, payload, updated_at }`.
  - `GET /state` → `{ payload, updated_at }` or literal `null` when no row exists.
  - `GET /images` → array of `{ id, name, dataUrl, addedAt }` newest first.
  - `POST /images` → single `{ id, name, dataUrl, addedAt }`. On cap exceed, body must be `{ error: "limit", limit, count }` with status 409 (or 413 for per-image too large).
  - `DELETE /images/:id` → 204 on success, 404 when the row doesn't exist *or* belongs to another user (don't leak).
  - `POST /auth/register` → must include `pending: true` (the client UI gates auto-sign-in on this exact field).
  - `POST /auth/login` and `GET /auth/me` → must include `is_admin` (the client `App.Auth.isAdmin()` reads it; without it the Admin menu entry never lights up).
  - `GET /admin/users` / `GET /admin/images` → exact field names per the table above. The client's `app/js/app/admin.js` reads them positionally for table rendering and image grids.
  - `GET /admin/users/pending-count` → `{ count }` (just the integer). Polled every 60 s by the admin banner — keep it cheap.
  - `GET /admin/bugs` / `POST /admin/bugs/:id/{fix,unfix}` → exact field names; `fix`/`unfix` return the **updated** record (the client merges in the response, falling back to a local patch only if the response is `{ ok: true }`).
  - `POST /bugs` → `{ id }` (number). The client uses this to know the report landed.
  Don't add fields that overlap existing names; don't drop any of these.
- **LWW echo behavior on PUT.** Frontend `runOp` has a fallback that, when the server's returned `updated_at` differs from the ts the client sent, pulls the cloud copy and reconciles. If you change PUT to silently take the newer of the two without echoing the stored ts on a lost write, the client will think its push won and the conflict gets papered over. `applied` is the explicit signal (since 2026-09-12); `applied: true` with a different `updated_at` means the client's clock was clamped, and the client pins its local ts to the echo rather than pulling.
- **`Number(row.user_id)` cast in `armies.js`.** `pg`'s default BIGINT-as-string means `row.user_id === u.user_id` is always false. The cross-user 403 check requires the explicit cast. Same applies anywhere else you read a BIGINT column and compare it to `req.user.user_id`.
- **`ID_RE` in `armies.js`.** Don't tighten it back to UUID-only — the client emits short ids. If you tighten it at all, coordinate with the client id generator first.
- **Idempotent migrations.** `migrate()` runs on every boot. Any new DDL added to `SCHEMA` must be safe to re-run (use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ … IF NOT EXISTS … $$` blocks for ALTERs).
- **Rate-limit config object shape.** `authLimit = { config: { rateLimit: { max, timeWindow } } }` is the route-level override format `@fastify/rate-limit` expects; `perUserLimit()` adds `hook: 'preHandler'` and `keyGenerator`. Don't drop that `hook` — at the default `onRequest` stage `req.user` is not loaded yet and every per-user limit silently becomes per-IP. If you bump the plugin major version, re-check the override key path and the per-route `hook` option.
- **The app error handler.** 5xx must keep answering `{ error: "internal" }` (no driver messages to clients). Set it before registering route plugins, or child contexts keep Fastify's default.
- **`pool.on('error')` in `server.js`.** Without it an idle-client error from pg-pool is an uncaught EventEmitter error and kills the process.
- **The login timing equaliser, the LWW upserts, the single-query `migrate()`, the advisory-lock image cap, and the attachment handling** (server-generated names, `attachmentPath` regex gate, MIME allowlist without SVG, `wx`/`0640` streaming, unlink on every failure path) were all reviewed on 2026-10-30 and are correct as they stand.
- **`/api` prefix is stripped by Caddy.** Don't register routes as `/api/auth/login` — they'd 404 because the proxy already removed the prefix.
