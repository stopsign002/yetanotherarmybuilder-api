import { createWriteStream } from 'node:fs';
import { mkdir, statfs, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Bug-report attachments: one screenshot or screen recording per report,
// stored on disk (BUG_ATTACH_DIR, a bind mount) and served back to admins
// only — see GET /admin/bugs/:id/attachment in admin.js.
const ATTACH_DIR = process.env.BUG_ATTACH_DIR || '/data/bug-attachments';
export const ATTACH_MAX = 50 * 1024 * 1024;   // matches the client's 50 MB cap; server.js's multipart fileSize

// Raster images and video only. SVG is deliberately excluded: it is an image
// MIME that can carry script, and these files are served from the site's own
// origin (with a sandbox CSP as a second layer, but the first is not storing it).
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/3gpp': '3gp', 'video/ogg': 'ogv',
};

export function extForMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase().split(';')[0].trim()] || null;
}

// Stream one multipart file part to disk. Resolves { file, mime, size };
// throws { statusCode: 415 | 413 } on a bad type or an oversize file, and
// never leaves a partial file behind.
export async function saveAttachment(part) {
  const mime = String(part.mimetype || '').toLowerCase().split(';')[0].trim();
  const ext = extForMime(mime);
  if (!ext) {
    part.file.resume();                         // drain so the request completes
    throw Object.assign(new Error('attachment must be an image or video'), { statusCode: 415 });
  }
  await mkdir(ATTACH_DIR, { recursive: true });
  const file = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.${ext}`;
  const full = path.join(ATTACH_DIR, file);
  let size = 0;
  part.file.on('data', (c) => { size += c.length; });
  try {
    await pipeline(part.file, createWriteStream(full, { flags: 'wx', mode: 0o640 }));
  } catch (err) {
    await unlink(full).catch(() => {});
    throw err;
  }
  if (part.file.truncated) {
    await unlink(full).catch(() => {});
    throw Object.assign(new Error('attachment too large'), { statusCode: 413 });
  }
  return { file, mime, size };
}

// Bytes available to an unprivileged writer on the attachment volume. It is a
// bind mount on the host's root filesystem, which Postgres, Caddy's logs and
// every other site share, so POST /bugs refuses attachments below a floor.
export async function attachDirFreeBytes() {
  await mkdir(ATTACH_DIR, { recursive: true });
  const s = await statfs(ATTACH_DIR);
  return Number(s.bavail) * Number(s.bsize);
}

export function attachmentPath(file) {
  // Filenames are server-generated, but never trust a DB value as a path.
  if (!/^[a-z0-9]+-[0-9a-f]{16}\.[a-z0-9]{2,5}$/.test(String(file || ''))) return null;
  return path.join(ATTACH_DIR, file);
}

export async function removeAttachment(file) {
  const p = attachmentPath(file);
  if (p) await unlink(p).catch(() => {});
}
