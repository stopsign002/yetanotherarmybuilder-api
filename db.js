import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function waitForDb({ retries = 30, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  username            TEXT NOT NULL UNIQUE,
  password            TEXT NOT NULL,
  recovery_code_hash  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS armies (
  id          TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS armies_user_idx ON armies (user_id);

-- Older deployments created armies.id as UUID; the client uses short
-- base36-ish ids (e.g. "mohlesafo09b6") so we keep it as TEXT now.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'armies'
      AND column_name  = 'id'
      AND data_type    = 'uuid'
  ) THEN
    ALTER TABLE armies ALTER COLUMN id TYPE TEXT USING id::text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS state_bags (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_back_images (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data_url    TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_back_images_user_idx
  ON card_back_images (user_id, added_at DESC);

CREATE TABLE IF NOT EXISTS bug_reports (
  id           BIGSERIAL PRIMARY KEY,
  username     TEXT        NOT NULL,            -- submitter snapshot; intentionally NOT a FK
  title        TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  diagnostics  TEXT        NULL,
  fixed        BOOLEAN     NOT NULL DEFAULT FALSE,
  fixed_at     TIMESTAMPTZ NULL,
  fixed_by     TEXT        NULL,
  fixed_note   TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bug_reports_created_at_desc
  ON bug_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS bug_reports_open
  ON bug_reports (fixed) WHERE fixed = FALSE;

-- Approval gating + admin bit on users. The whole block is wrapped in a
-- "have we run this yet" guard so the existing-user backfill (everyone
-- on the system before this migration is treated as already-approved)
-- only ever runs once. Subsequent boots are a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'users'
      AND column_name  = 'approved'
  ) THEN
    ALTER TABLE users
      ADD COLUMN approved     BOOLEAN     NOT NULL DEFAULT FALSE,
      ADD COLUMN approved_at  TIMESTAMPTZ NULL,
      ADD COLUMN approved_by  TEXT        NULL,
      ADD COLUMN revoked      BOOLEAN     NOT NULL DEFAULT FALSE,
      ADD COLUMN revoked_at   TIMESTAMPTZ NULL,
      ADD COLUMN is_admin     BOOLEAN     NOT NULL DEFAULT FALSE;

    -- Existing users predate approval gating — auto-approve them.
    UPDATE users
       SET approved    = TRUE,
           approved_at = COALESCE(created_at, now());

    -- Bootstrap the site operator as the first admin.
    UPDATE users SET is_admin = TRUE WHERE username = 'stopsign002';
  END IF;
END $$;

-- Automated bug triage (bug-fixer.sh, hourly). The reporter may leave an
-- optional email to be told when their report is resolved; everything else
-- here is state for the hourly job so it can be interrupted and resumed:
--   escalated_at  the run that gave up and asked the operator for help. Set
--                 once, so a bug awaiting a human isn't re-attempted every
--                 hour and doesn't re-send the same email 24 times a day.
--   notified_at   the reporter has been told. Separate from fixed_at because
--                 a bug fixed BY HAND in the admin panel still owes its
--                 reporter a note, and the hourly job is the only sender.
--   fix_mode      'auto' (verified and applied unattended) or 'intervention'
--                 (a human finished it) — the reporter's email says which.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'bug_reports'
      AND column_name  = 'email'
  ) THEN
    ALTER TABLE bug_reports
      ADD COLUMN email        TEXT        NULL,
      ADD COLUMN fix_mode     TEXT        NULL,
      ADD COLUMN fix_report   TEXT        NULL,
      ADD COLUMN escalated_at TIMESTAMPTZ NULL,
      ADD COLUMN attempts     INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN notified_at  TIMESTAMPTZ NULL;

    -- Reports that predate this feature are already dealt with; don't let the
    -- first run of the hourly job treat the whole backlog as fresh work.
    UPDATE bug_reports SET notified_at = now() WHERE fixed = TRUE;
  END IF;
END $$;

-- Work queue for the hourly fixer: open and not yet escalated to a human.
CREATE INDEX IF NOT EXISTS bug_reports_actionable
  ON bug_reports (created_at) WHERE fixed = FALSE AND escalated_at IS NULL;
`;

export async function migrate() {
  await pool.query(SCHEMA);
}
