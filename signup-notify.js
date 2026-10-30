import { query } from './db.js';
import { notify } from './mail.js';

// Operator notification for new pending accounts, coalesced to at most one
// mail per hour.
//
// Why: /auth/register needs no login, and it used to mail the operator on
// every call. The mailer is the host-wide Gmail relay with a ~500/day cap that
// backup.sh, restore-test.sh and login-watch also depend on, so a script
// registering at the 5/min/IP limit could use the whole day's cap and silence
// every alert on the box.
//
// How: one row in `notify_state` (kind = 'signup'):
//   sent_at           when the last mail went out ('-infinity' = never)
//   notified_through  created_at of the newest account that mail covered
// A mail is due when some pending account is newer than notified_through AND
// sent_at is at least an hour old. The UPDATE that claims the slot carries
// both conditions, so two concurrent callers cannot both send: the second
// blocks on the row lock, re-checks sent_at against the first one's write and
// matches nothing. State lives in Postgres, so a restart neither re-sends nor
// forgets. Accounts that arrive inside the hour are not lost: the sweep in
// server.js re-runs this every few minutes and mails "N new accounts" once
// the hour is up. Accounts an admin approved or revoked in the meantime are
// not counted.
//
// The row is seeded by migrate() with notified_through = the first boot's
// now(), so accounts that were already mailed one by one under the old code
// are not mailed again.
//
// Known gaps, both accepted: a mail the mailer then fails to deliver still
// consumes the slot (notify() is fire-and-forget), and an account whose INSERT
// commits after a concurrent claim with a newer created_at is skipped by that
// watermark. The admin panel's pending banner shows the true count regardless.

const NAMES_IN_MAIL = 20;
const ADMIN_URL = 'https://yaab.thewheeliebois.com (Admin → Users)';

export async function notifyPendingSignups(log) {
  const { rows } = await query(
    `WITH st AS (
       SELECT notified_through FROM notify_state WHERE kind = 'signup'
     ),
     fresh AS (
       SELECT count(*)::int AS n,
              max(u.created_at) AS newest,
              (array_agg(u.username ORDER BY u.created_at))[1:${NAMES_IN_MAIL}] AS names
         FROM users u, st
        WHERE u.approved = FALSE AND u.revoked = FALSE
          AND u.created_at > st.notified_through
     ),
     claim AS (
       UPDATE notify_state s
          SET sent_at = now(), notified_through = fresh.newest
         FROM fresh
        WHERE s.kind = 'signup'
          AND fresh.n > 0
          AND s.sent_at <= now() - interval '1 hour'
       RETURNING 1
     )
     SELECT n, names, EXISTS (SELECT 1 FROM claim) AS claimed FROM fresh`
  );
  const r = rows[0];
  if (!r || !r.claimed) return false;

  const names = r.names || [];
  const more = r.n - names.length;
  if (r.n === 1) {
    notify(
      `[yaab] Access request: ${names[0]}`,
      `New user "${names[0]}" registered on yaab and is awaiting approval.\n\nApprove/revoke: ${ADMIN_URL}`
    );
  } else {
    notify(
      `[yaab] ${r.n} new accounts awaiting approval`,
      `${r.n} new accounts registered on yaab since the last notice and are awaiting approval:\n\n`
        + names.map(n => `  ${n}`).join('\n')
        + (more > 0 ? `\n  …and ${more} more` : '')
        + `\n\nApprove/revoke: ${ADMIN_URL}\n\n(Notices are batched: at most one mail per hour.)`
    );
  }
  log?.info({ count: r.n }, 'pending-signup notice sent');
  return true;
}

// Fire-and-forget wrapper for callers that must not wait or fail on it.
export function kickSignupNotice(log) {
  notifyPendingSignups(log).catch(err => log?.warn({ err }, 'pending-signup notice failed'));
}
