import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attribute, message } from '../scripts/turn-allocation-probe.mjs';

const realm = Buffer.from('pigeon-swarm');
const nonce = Buffer.from('fixture-nonce');

function errorAttribute(code) {
  return attribute(0x0009, Buffer.from([0, 0, Math.floor(code / 100), code % 100]));
}

function parseRequest(bytes) {
  const attributes = new Map();
  for (let offset = 20; offset + 4 <= bytes.length;) {
    const length = bytes.readUInt16BE(offset + 2);
    attributes.set(bytes.readUInt16BE(offset), { offset, value: bytes.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  return { type: bytes.readUInt16BE(0), transaction: bytes.subarray(8, 20), attributes };
}

// Local TURN responder for the probe's own requests. Like coturn, it keeps one
// session per client transport address and binds the first authenticated
// username to it; an Allocate with another username gets 437. `staleUdpClients`
// pre-binds an expired username to new UDP client addresses, as coturn does for
// up to 60 seconds after an earlier probe's rejected credential check.
async function turnFixture(t, { secret, staleUdpClients = 0, allocationError } = {}) {
  const sessions = new Map();
  const mismatchedUdpPorts = [];
  let staleRemaining = staleUdpClients;

  const respond = (bytes, client) => {
    const request = parseRequest(bytes);
    let session = sessions.get(client.id);
    if (!session) {
      session = { username: client.transport === 'udp' && staleRemaining > 0 ? '1:deployment-probe' : undefined };
      if (session.username) staleRemaining -= 1;
      sessions.set(client.id, session);
    }
    const integrity = request.attributes.get(0x0008);
    if (!integrity) return message(0x0113, [errorAttribute(401), attribute(0x0014, realm), attribute(0x0015, nonce)], undefined, request.transaction);
    const username = request.attributes.get(0x0006).value.toString();
    if (request.type === 0x0003 && session.username && session.username !== username) {
      if (client.transport === 'udp') mismatchedUdpPorts.push(client.port);
      return message(0x0113, [errorAttribute(437)], undefined, request.transaction);
    }
    session.username = username;
    const password = createHmac('sha1', secret).update(username).digest('base64');
    const key = createHash('md5').update(`${username}:${realm}:${password}`).digest();
    const expected = createHmac('sha1', key).update(bytes.subarray(0, integrity.offset)).digest();
    if (Number(username.split(':')[0]) <= Date.now() / 1000 || !expected.equals(integrity.value)) {
      return message(0x0113, [errorAttribute(401), attribute(0x0014, realm), attribute(0x0015, nonce)], undefined, request.transaction);
    }
    if (request.type === 0x0004) return message(0x0104, [attribute(0x000d, Buffer.alloc(4))], key, request.transaction);
    if (allocationError) return message(0x0113, [errorAttribute(allocationError)], key, request.transaction);
    const relayed = Buffer.alloc(8);
    relayed[1] = 1;
    relayed.writeUInt16BE(50000 ^ 0x2112, 2);
    relayed.writeUInt32BE((0x7f000001 ^ 0x2112a442) >>> 0, 4);
    return message(0x0103, [attribute(0x0016, relayed)], key, request.transaction);
  };

  const tcp = createServer((socket) => {
    const client = { id: `tcp:${socket.remotePort}`, transport: 'tcp', port: socket.remotePort };
    let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 20 && pending.length >= 20 + pending.readUInt16BE(2)) {
        const length = 20 + pending.readUInt16BE(2);
        socket.write(respond(pending.subarray(0, length), client));
        pending = pending.subarray(length);
      }
    });
  });
  tcp.listen(0, '127.0.0.1');
  await once(tcp, 'listening');
  const port = tcp.address().port;
  const udp = createSocket('udp4');
  udp.on('message', (bytes, remote) => {
    udp.send(respond(bytes, { id: `udp:${remote.port}`, transport: 'udp', port: remote.port }), remote.port, remote.address);
  });
  udp.bind(port, '127.0.0.1');
  await once(udp, 'listening');
  t.after(() => { tcp.close(); udp.close(); });
  return { port, mismatchedUdpPorts };
}

async function runProbe(t, port, secret) {
  const directory = await mkdtemp(join(tmpdir(), 'pigeon-turn-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'calls-turn-runtime.conf');
  await writeFile(config, `version=1\nenabled=true\nlistening_port=${port}\n`);
  const { CALLS_TURN_TLS_PORT, CALLS_TURN_EXTERNAL_IP, ...environment } = process.env;
  const child = spawn(process.execPath, ['scripts/turn-allocation-probe.mjs'], {
    env: { ...environment, CALLS_TURN_SHARED_SECRET: secret, PIGEON_TURN_RUNTIME_CONFIG_PATH: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  assert.ok(!`${stdout}${stderr}`.includes(secret), 'The probe must not print the shared secret');
  return { status, stdout, stderr };
}

test('a stale server session on the client address is retried from a new address (RFC 8656 437)', async (t) => {
  const secret = randomBytes(32).toString('hex');
  const fixture = await turnFixture(t, { secret, staleUdpClients: 1 });
  const result = await runProbe(t, fixture.port, secret);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS udp:/);
  assert.match(result.stdout, /PASS tcp:/);
  assert.equal(fixture.mismatchedUdpPorts.length, 1);
});

test('gives up after three distinct client addresses report an allocation mismatch', async (t) => {
  const secret = randomBytes(32).toString('hex');
  const fixture = await turnFixture(t, { secret, staleUdpClients: Infinity });
  const result = await runProbe(t, fixture.port, secret);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allocation mismatch \(437\) from three client addresses/);
  assert.equal(fixture.mismatchedUdpPorts.length, 3);
  assert.equal(new Set(fixture.mismatchedUdpPorts).size, 3, 'Each retry must use a different client address');
});

test('reports the STUN error code and blames the secret only for 401', async (t) => {
  const secret = randomBytes(32).toString('hex');
  const quota = await runProbe(t, (await turnFixture(t, { secret, allocationError: 486 })).port, secret);
  assert.equal(quota.status, 1);
  assert.match(quota.stderr, /Authenticated allocation failed \(STUN type 0x113, error code 486\)\./);
  assert.doesNotMatch(quota.stderr, /same secret/);

  const mismatch = await runProbe(t, (await turnFixture(t, { secret })).port, randomBytes(32).toString('hex'));
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /error code 401\); check that backend and coturn use the same secret/);
});
