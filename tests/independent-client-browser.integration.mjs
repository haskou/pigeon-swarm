import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClientServer } from '../client/server.mjs';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fakeNode(t, contract, tls) {
  const requests = [];
  const handle = (req, res) => {
    requests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.url === '/malicious.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end('globalThis.backendCodeExecuted = true;');
    }
    const body = req.url === '/api/client-contract' ? contract
      : req.url === '/api/node/networks/' ? { networks: [] }
        : req.url === '/api/node/' ? { id: 'fake-node', name: 'Negative-test fixture', owner: null }
          : req.url === '/api/peers/' ? { peers: [], ipfsPeers: [], networkSynchronization: null }
            : {};
    res.end(JSON.stringify(body));
  };
  const origin = await listen(tls ? createTlsServer(tls, handle) : createServer(handle), t);
  return { requests, origin: tls ? origin.replace('http:', 'https:') : origin };
}

test('independent built client browser contract with explicitly fake backend fixtures', {
  skip: !process.env.PIGEON_CLIENT_DIST && 'Set PIGEON_CLIENT_DIST to an independently built UI dist',
  timeout: 90000,
}, async (t) => {
  const modulePath = process.env.PIGEON_PLAYWRIGHT_MODULE;
  const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
  const directory = await mkdtemp(join(tmpdir(), 'pigeon-browser-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'public');
  await cp(resolve(process.env.PIGEON_CLIENT_DIST), root, { recursive: true });
  await writeFile(join(root, 'probe-worker.js'), 'postMessage({ready: true, scope: new URL(location.href).hash});');
  await writeFile(join(root, 'probe.webmanifest'), JSON.stringify({ name: 'Client CSP probe', start_url: '/', display: 'standalone' }));
  const clientRequests = [];
  const clientServer = await createClientServer({ root });
  clientServer.on('request', (request) => clientRequests.push(request.url));
  const origin = await listen(clientServer, t);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PIGEON_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());

  async function pageFor(subtest) {
    const context = await browser.newContext({ locale: 'en-US' });
    context.setDefaultTimeout(12000);
    subtest.after(() => context.close());
    await context.addInitScript(() => {
      globalThis.documentId = crypto.randomUUID();
      globalThis.storageReads = [];
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        globalThis.storageReads.push(key);
        return getItem.call(this, key);
      };
    });
    return context.newPage();
  }

  async function choose(page, address) {
    await page.getByLabel('Node address').fill(address);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  }

  await t.test('fresh gate sends no backend traffic before choice and rejects a wrong contract', async (subtest) => {
    const node = await fakeNode(subtest, { protocol: 'pigeon-swarm', apiVersion: 999 });
    const page = await pageFor(subtest);
    const offOrigin = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== origin) offOrigin.push(request.url());
    });
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Connect to a node' }).waitFor();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    assert.deepEqual(offOrigin, []);
    assert.deepEqual(node.requests, []);
    await choose(page, `${node.origin}/api`);
    await page.getByRole('alert').filter({ hasText: 'not compatible' }).waitFor();
    assert.deepEqual(node.requests, ['/api/client-contract']);
    assert.equal(await page.getByRole('link', { name: 'Change node' }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('pigeon-swarm-client-node-v1')), null);
  });

  await t.test('valid loopback contract boots real UI and ignores backend scriptURL; node switch reloads and scopes credential reads', async (subtest) => {
    const contract = { protocol: 'pigeon-swarm', apiVersion: 1 };
    const first = await fakeNode(subtest, contract);
    contract.scriptURL = `${first.origin}/malicious.js`;
    const second = await fakeNode(subtest, { protocol: 'pigeon-swarm', apiVersion: 1 });
    const page = await pageFor(subtest);
    await page.goto(origin);
    const gateDocument = await page.evaluate(() => globalThis.documentId);
    const firstBootstrap = page.waitForResponse(`${first.origin}/api/node/networks/`);
    await choose(page, `${first.origin}/api`);
    await firstBootstrap;
    await page.getByRole('link', { name: 'Change node' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.app-screen'));
    assert.notEqual(await page.evaluate(() => globalThis.documentId), gateDocument);
    assert.ok(first.requests.includes('/api/node/networks/'));
    assert.equal(first.requests.includes('/malicious.js'), false);
    assert.equal(await page.evaluate(() => globalThis.backendCodeExecuted), undefined);
    const firstScope = createHash('sha256').update(`${first.origin}/api`).digest('hex');
    const secondScope = createHash('sha256').update(`${second.origin}/api`).digest('hex');
    await page.evaluate((scope) => localStorage.setItem(`pigeon-swarm-credentials:${scope}`, JSON.stringify({ identityId: 'synthetic-node-A-identity' })), firstScope);
    const otherTab = await page.context().newPage();
    await otherTab.goto(origin);
    await otherTab.getByRole('link', { name: 'Change node' }).waitFor();
    const otherDocument = await otherTab.evaluate(() => globalThis.documentId);
    await page.getByRole('link', { name: 'Change node' }).click();
    await page.getByLabel('Node address').waitFor();
    const choosingDocument = await page.evaluate(() => globalThis.documentId);
    const secondBootstrap = page.waitForResponse(`${second.origin}/api/node/networks/`);
    await choose(page, `${second.origin}/api`);
    await secondBootstrap;
    await page.getByRole('link', { name: 'Change node' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.app-screen'));
    assert.notEqual(await page.evaluate(() => globalThis.documentId), choosingDocument);
    await otherTab.waitForURL(origin + '/connect');
    await otherTab.getByRole('heading', { name: 'Connect to a node' }).waitFor();
    assert.notEqual(await otherTab.evaluate(() => globalThis.documentId), otherDocument);
    assert.equal(await otherTab.getByRole('link', { name: 'Change node' }).count(), 0);
    const reads = await page.evaluate(() => globalThis.storageReads);
    assert.ok(reads.includes(`pigeon-swarm-credentials:${secondScope}`));
    assert.equal(reads.includes(`pigeon-swarm-credentials:${firstScope}`), false);
    assert.equal(reads.includes('pigeon-swarm-credentials'), false);
    assert.ok(second.requests.includes('/api/node/networks/'));
    assert.equal(new URL(page.url()).origin, origin);
  });

  await t.test('browser enforces remote-script CSP while same-origin worker and manifest succeed', async (subtest) => {
    const remote = await fakeNode(subtest, {});
    const page = await pageFor(subtest);
    await page.goto(origin);
    await page.getByLabel('Node address').waitFor();
    const violation = await page.evaluate((url) => new Promise((done) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        if (event.blockedURI === url) done(event.effectiveDirective);
      });
      const script = document.createElement('script');
      script.src = url;
      document.head.append(script);
    }), `${remote.origin}/malicious.js`);
    assert.equal(violation, 'script-src-elem');
    assert.deepEqual(remote.requests, []);
    assert.equal(await page.evaluate(() => globalThis.backendCodeExecuted), undefined);
    assert.deepEqual(await page.evaluate(() => new Promise((done, reject) => {
      const worker = new Worker('/probe-worker.js#pigeonNodeScope=opaque-partition', {type: 'module'});
      worker.onmessage = (event) => { worker.terminate(); done(event.data); };
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
    })), {ready: true, scope: '#pigeonNodeScope=opaque-partition'});
    assert.ok(clientRequests.includes('/probe-worker.js'));
    assert.equal(clientRequests.some((url) => url.includes('opaque-partition')), false);
    await page.evaluate(() => {
      document.querySelectorAll('link[rel="manifest"]').forEach((link) => link.remove());
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = '/probe.webmanifest';
      document.head.append(link);
    });
    const session = await page.context().newCDPSession(page);
    const manifest = await session.send('Page.getAppManifest');
    assert.equal(JSON.parse(manifest.data).name, 'Client CSP probe');
    assert.deepEqual(manifest.errors, []);
  });

  await t.test('invalid self-signed TLS remains blocked without certificate overrides', async (subtest) => {
    const key = join(directory, 'fixture.key');
    const cert = join(directory, 'fixture.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const node = await fakeNode(subtest, { protocol: 'pigeon-swarm', apiVersion: 1 }, { key: await readFile(key), cert: await readFile(cert) });
    const page = await pageFor(subtest);
    const failures = [];
    page.on('requestfailed', (request) => failures.push(request.failure()?.errorText));
    await page.goto(origin);
    await choose(page, `${node.origin}/api`);
    await page.getByRole('alert').filter({ hasText: 'Could not connect securely' }).waitFor();
    assert.ok(failures.some((error) => error?.includes('ERR_CERT_AUTHORITY_INVALID')));
    assert.deepEqual(node.requests, []);
    assert.equal(await page.evaluate(() => localStorage.getItem('pigeon-swarm-client-node-v1')), null);
  });

  await t.test('same-origin update and rollback fixtures remain fresh under actual independent service worker', async (subtest) => {
    const page = await pageFor(subtest);
    await page.goto(origin);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true);
    const originalIndex = await readFile(join(root, 'index.html'));
    subtest.after(() => writeFile(join(root, 'index.html'), originalIndex));
    for (const [version, hash] of [['A', 'aaaaaaaa'], ['B', 'bbbbbbbb'], ['A', 'aaaaaaaa']]) {
      await writeFile(join(root, `assets/release-${hash}.js`), `document.querySelector('#version').textContent = '${version}';`);
      await writeFile(join(root, 'index.html'), `<!doctype html><title>Release fixture</title><p id="version"></p><script src="/assets/release-${hash}.js"></script>`);
      const response = await page.reload();
      assert.equal(response.headers()['cache-control'], 'no-store');
      await page.waitForFunction((expected) => document.querySelector('#version')?.textContent === expected, version);
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true);
    }
  });
});
