import { reject, requireUser } from './http.js';
import { perUserLimit } from './limits.js';

// POST /export/tts: proxy a Tabletop Simulator roster (.regiztry bytes) to
// yellowscribe, which answers { code } for the TTS importer. No DB. The body
// is forwarded unchanged and never logged: it can contain the user's roster.
const BODY_MAX = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const NAME_MAX = 64;
const EXT = '.regiztry';

function safeName(raw) {
  let n = String(Array.isArray(raw) ? raw[0] : raw ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  if (n.toLowerCase().endsWith(EXT)) n = n.slice(0, -EXT.length);
  n = n.slice(0, NAME_MAX - EXT.length);
  return n ? n + EXT : 'yaab' + EXT;
}

export async function exportRoutes(app) {
  // Scoped to this plugin: no other route sees an octet-stream parser.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: BODY_MAX },
    (req, body, done) => done(null, body));

  app.post('/export/tts', perUserLimit(6, '1 minute'), async (req, reply) => {
    if (!requireUser(req, reply)) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reject(reply, 400, 'empty_body');
    }
    const base = process.env.YELLOWSCRIBE_URL || 'https://yellowscribe.link';
    const url = `${base}/makeArmyAndReturnCode?filename=${encodeURIComponent(safeName(req.headers['x-roster-name']))}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: req.body,
        headers: {
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'yaab (yaab.thewheeliebois.com)',
        },
        signal: ctl.signal,
      });
      if (!res.ok) {
        app.log.warn({ status: res.status }, 'yellowscribe upstream error');
        return reject(reply, 502, 'yellowscribe_unavailable');
      }
      let data = null;
      try { data = await res.json(); } catch { /* handled below */ }
      const code = data && data.code;
      if (typeof code !== 'string' && typeof code !== 'number') {
        app.log.warn({ status: res.status }, 'yellowscribe reply had no code');
        return reject(reply, 502, 'yellowscribe_unavailable');
      }
      return { code };
    } catch (err) {
      app.log.warn({ err: err.name === 'AbortError' ? 'timeout' : err.message }, 'yellowscribe request failed');
      return reject(reply, 502, 'yellowscribe_unavailable');
    } finally {
      clearTimeout(timer);
    }
  });
}
