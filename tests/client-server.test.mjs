import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClientServer } from '../client/server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pigeon-client-'));
  const root = join(directory, 'public');
  await mkdir(join(root, 'assets'), { recursive: true });
  for (const [name, content] of Object.entries({
    'index.html': '<!doctype html><title>Trusted client</title>',
    'assets/app-Ab12_C34.js': 'export const trusted = true;',
    'call-incoming.mp3': 'sound',
    'assets/app.js': 'export const plain = true;',
    'assets/theme-A1234567.css': 'body { color: black; }',
    'assets/audio-A1234567.wasm': 'wasm',
    'sw.js': 'self.addEventListener("fetch", () => {});',
    'client-release.json': '{"sourceCommit":"test","contractVersion":1}',
  })) await writeFile(join(root, name), content);
  await writeFile(join(directory, 'secret.txt'), 'outside-root');
  await symlink(join(directory, 'secret.txt'), join(root, 'escape.txt'));
  const server = await createClientServer({ root });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves explicit resource types and never disguises missing scripts as HTML', async (t) => {
  const get = await fixture(t);
  for (const [path, type] of [
    ['/assets/app-Ab12_C34.js', 'text/javascript; charset=utf-8'],
    ['/assets/theme-A1234567.css', 'text/css; charset=utf-8'],
    ['/assets/audio-A1234567.wasm', 'application/wasm'],
    ['/client-release.json', 'application/json; charset=utf-8'],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], type);
  }
  const missing = await get('/assets/missing.js', { headers: { accept: 'text/html' } });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.body, /Trusted client/);
});

test('SPA fallback requires document navigation and never implements an API proxy', async (t) => {
  const get = await fixture(t);
  assert.match((await get('/')).body, /Trusted client/);
  assert.match((await get('/rooms/123', { headers: { accept: 'text/html' } })).body, /Trusted client/);
  assert.equal((await get('/rooms/123')).status, 404);
  assert.equal((await get('/rooms/123', { headers: { accept: 'text/html', 'sec-fetch-dest': 'script' } })).status, 404);
  assert.equal((await get('/api/users', { headers: { accept: 'application/json' } })).status, 404);
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await get('/', { method: 'POST' })).status, 405);
});

test('rejects traversal, malformed paths and symlink escapes', async (t) => {
  const get = await fixture(t);
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt', '/escape.txt', '/%00', '/%ZZ']) {
    const response = await get(path, { headers: { accept: 'text/html' } });
    assert.ok(response.status >= 400, path);
    assert.doesNotMatch(response.body, /outside-root|Trusted client/);
  }
});

test('caches only hashed assets immutably and always refreshes bootstrap metadata', async (t) => {
  const get = await fixture(t);
  for (const path of ['/', '/index.html', '/sw.js', '/client-release.json']) {
    assert.equal((await get(path)).headers['cache-control'], 'no-store');
  }
  assert.equal((await get('/assets/app-Ab12_C34.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await get('/call-incoming.mp3')).headers['cache-control'], 'no-cache');
  assert.equal((await get('/assets/app.js')).headers['cache-control'], 'no-cache');
  assert.equal((await get('/missing.js')).headers['cache-control'], 'no-store');
});

test('all responses restrict script origins and preserve local media permissions', async (t) => {
  const get = await fixture(t);
  for (const path of ['/', '/missing.js']) {
    const { headers } = await get(path);
    const directives = Object.fromEntries(headers['content-security-policy'].split(';').map((entry) => {
      const [key, ...values] = entry.trim().split(/\s+/);
      return [key, values.join(' ')];
    }));
    assert.equal(directives['manifest-src'], "'self'");
    assert.equal(directives['default-src'], "'none'");
    assert.equal(directives['script-src'], "'self' 'wasm-unsafe-eval'");
    assert.equal(directives['worker-src'], "'self' blob:");
    assert.equal(directives['style-src'], "'self' 'unsafe-inline'");
    assert.equal(directives['frame-ancestors'], "'none'");
    assert.equal(directives['connect-src'], 'https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*');
    assert.equal(headers['permissions-policy'], 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
  }
});

test('TLS configuration requires a certificate and key together', async () => {
  await assert.rejects(createClientServer({ tlsCertFile: '/missing.pem' }), /together/);
  await assert.rejects(createClientServer({ tlsKeyFile: '/missing.pem' }), /together/);
});
