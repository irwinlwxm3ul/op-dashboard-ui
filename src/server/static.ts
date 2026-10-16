// Production static file serving for the built client (dist/): correct content types, SPA
// fallback to index.html, path traversal protection, ETag revalidation and long-lived caching for
// content-hashed build assets.

import { createReadStream, promises as fsp, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Vite emits build assets as `assets/<name>-<8 char hash>.<ext>`. Those never change content under
 * the same URL and can be cached forever. Public files (e.g. assets/sounds/*.ogg) are not hashed;
 * requiring a digit or uppercase letter in the hash avoids treating names like "-concrete" as one.
 */
export function isHashedAsset(urlPath: string): boolean {
  const m = /^\/assets\/[^/]+-([A-Za-z0-9_-]{8})\.[A-Za-z0-9]+$/.exec(urlPath);
  return m !== null && /[0-9A-Z]/.test(m[1]);
}

function cacheControlFor(urlPath: string, file: string): string {
  if (path.basename(file) === 'index.html') return 'no-cache';
  if (isHashedAsset(urlPath)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

/**
 * Resolve a request path to a file inside `root`, or null when it escapes the root or is malformed.
 */
export function resolveStaticPath(root: string, rawUrl: string): { urlPath: string; file: string } | null {
  const q = rawUrl.indexOf('?');
  const h = rawUrl.indexOf('#');
  let end = rawUrl.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawUrl.slice(0, end));
  } catch {
    return null;
  }
  if (!urlPath.startsWith('/') || urlPath.includes('\0') || urlPath.includes('\\')) return null;
  const normalized = path.posix.normalize(urlPath);
  const rootAbs = path.resolve(root);
  const file = path.resolve(rootAbs, '.' + normalized);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return null;
  return { urlPath: normalized, file };
}

async function statFile(file: string): Promise<Stats | null> {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function sendStatus(res: ServerResponse, status: number, extra?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(status === 404 ? 'Not found' : status === 400 ? 'Bad request' : status === 405 ? 'Method not allowed' : '');
}

/** Serve a GET/HEAD request from `root`. Always responds. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendStatus(res, 405, { Allow: 'GET, HEAD' });
    return;
  }
  const resolved = resolveStaticPath(root, req.url ?? '/');
  if (!resolved) {
    sendStatus(res, 400);
    return;
  }
  let { file } = resolved;
  const { urlPath } = resolved;
  let st = urlPath.endsWith('/') ? null : await statFile(file);
  if (!st && urlPath.endsWith('/')) {
    file = path.join(file, 'index.html');
    st = await statFile(file);
  }
  if (!st) {
    // SPA fallback: extension-less routes get the app shell; missing assets are a real 404.
    if (path.posix.extname(urlPath) !== '') {
      sendStatus(res, 404);
      return;
    }
    file = path.join(path.resolve(root), 'index.html');
    st = await statFile(file);
    if (!st) {
      sendStatus(res, 404);
      return;
    }
  }

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(file),
    'Cache-Control': cacheControlFor(urlPath, file),
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
