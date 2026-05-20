// Fire-and-forget notification helper. POSTs to the shared `mailer` service
// on the `web` network. Never throws and never blocks the caller — a mail
// hiccup must not break a registration or bug report. Configured via
// MAILER_URL + MAILER_TOKEN (see project-root .env); if either is missing,
// notifications are silently skipped.
const MAILER_URL = process.env.MAILER_URL || '';
const MAILER_TOKEN = process.env.MAILER_TOKEN || '';

export function notify(subject, text) {
  if (!MAILER_URL || !MAILER_TOKEN) return;
  fetch(MAILER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MAILER_TOKEN}`,
    },
    body: JSON.stringify({ subject, text }),
    signal: AbortSignal.timeout(10000),
  })
    .then(async (r) => {
      if (!r.ok) console.error('[notify] mailer', r.status, await r.text().catch(() => ''));
    })
    .catch((e) => console.error('[notify] failed:', e.message));
}
