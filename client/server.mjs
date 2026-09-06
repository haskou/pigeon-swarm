import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
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
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*",
    "media-src 'self' blob: https:",
    "font-src 'self'",
    "manifest-src 'self'",
    'connect-src https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*',
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export async function createClientServer({
  root = process.env.CLIENT_ROOT || '/app/public',
  tlsCertFile = process.env.CLIENT_TLS_CERT_FILE,
  tlsKeyFile = process.env.CLIENT_TLS_KEY_FILE,
} = {}) {
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('CLIENT_TLS_CERT_FILE and CLIENT_TLS_KEY_FILE must be configured together');
  }
  const publicRoot = await realpath(root);
  const tls = tlsCertFile ? { cert: await readFile(tlsCertFile), key: await readFile(tlsKeyFile) } : undefined;

  async function locate(path) {
    const file = await realpath(resolve(publicRoot, `.${path}`));
    const local = relative(publicRoot, file);
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw Object.assign(new Error('Forbidden path'), { code: 'EACCES' });
    }
    if (!(await stat(file)).isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    return file;
  }

  const handler = async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return fail(405, 'Method not allowed');
    }
    let path;
    try {
      path = decodeURIComponent(req.url.split('?')[0]);
      if (!path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').includes('..')) {
        return fail(400, 'Invalid path');
      }
    } catch {
      return fail(400, 'Invalid path');
    }
    try {
      let file;
      try {
        file = await locate(path === '/' ? '/index.html' : path);
      } catch (error) {
        const documentRequest = req.headers.accept?.split(',').some((value) => /^text\/html(?:\s*;|\s*$)/i.test(value.trim()))
          && (!req.headers['sec-fetch-dest'] || req.headers['sec-fetch-dest'] === 'document');
        if (error.code !== 'ENOENT' || extname(path) || !documentRequest) throw error;
        file = await locate('/index.html');
      }
      const body = await readFile(file);
      const name = basename(file);
      const extension = extname(file).toLowerCase();
      const bootstrap = extension === '.html' || name === 'sw.js' || name === 'client-release.json';
      const hashed = /^\/assets\/.+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/i.test(path);
      res.writeHead(200, {
        'Content-Type': contentTypes[extension] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': bootstrap ? 'no-store' : hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      fail(error.code === 'EACCES' ? 403 : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500, 'Resource unavailable');
    }
  };
  return tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.CLIENT_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLIENT_PORT must be an integer from 1 to 65535');
  const server = await createClientServer();
  server.listen(port, '0.0.0.0', () => process.stdout.write(`Independent client listening on port ${port}\n`));
}
