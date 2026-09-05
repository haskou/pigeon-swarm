import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { attribute, message, errorCode, openTransport } from '../scripts/turn-allocation-probe.mjs';

const secret = process.env.CALLS_TURN_SHARED_SECRET;
delete process.env.CALLS_TURN_SHARED_SECRET;
const sessions = [];
const requestedTransport = attribute(0x0019, [17, 0, 0, 0]);

function peerAddress(ip, port) {
  const value = Buffer.alloc(8);
  value[1] = 1;
  value.writeUInt16BE(port ^ 0x2112, 2);
  const address = Buffer.from(ip.split('.').map(Number));
  value.writeUInt32BE((address.readUInt32BE() ^ 0x2112a442) >>> 0, 4);
  return attribute(0x0012, value);
}

async function allocate(identity, expectedCode, expiryOffset = 0) {
  const connection = await openTransport('tcp', 4101);
  const session = { connection, allocated: false };
  sessions.push(session);
  const challenge = await connection.exchange(message(0x0003, [requestedTransport]));
  assert.equal(errorCode(challenge), 401);
  const realm = challenge.attributes.get(0x0014);
  const nonce = challenge.attributes.get(0x0015);
  const username = `${Math.floor(Date.now() / 1000) + 120 + expiryOffset}:${identity}`;
  const password = createHmac('sha1', secret).update(username).digest('base64');
  const key = createHash('md5').update(`${username}:${realm.toString()}:${password}`).digest();
  const auth = [attribute(0x0006, username), attribute(0x0014, realm), attribute(0x0015, nonce)];
  session.request = (type, attrs) => connection.exchange(message(type, [...attrs, ...auth], key), key);
  const result = await session.request(0x0003, [requestedTransport]);
  assert.equal(result.integrityValid, true, 'Allocation result must be authenticated');
  if (expectedCode) {
    assert.equal(errorCode(result), expectedCode, 'Allocation quota must reject excess requests');
  } else {
    assert.equal(result.type, 0x0103, 'Allocation within quota must succeed');
    assert.equal(result.integrityValid, true);
    session.allocated = true;
  }
  session.release = async () => {
    if (!session.allocated) return;
    const result = await session.request(0x0004, [attribute(0x000d, Buffer.alloc(4))]);
    assert.equal(result.type, 0x0104);
    session.allocated = false;
    await delay(1100);
  };
  return session;
}

try {
  const first = await allocate('quota-a');
  await allocate('quota-a', undefined, 1);
  await allocate('quota-a', undefined, 2);
  await allocate('quota-a', 486, 3);
  await allocate('quota-b');
  await allocate('quota-b', undefined, 1);
  await allocate('quota-c', 486);
  await first.release();
  const active = await allocate('quota-a', undefined, 4);
  console.log('PASS quotas: per-user limit survives credential renewal; global limit enforced; released capacity reusable.');

  // 127.0.0.1 is the fixture's advertised relay and is translated to its actual
  // interface by coturn. Use another loopback address to test the blocked range.
  for (const blockedIp of ['0.0.0.1', '10.0.0.1', '100.64.0.1', '127.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1']) {
    const ip = blockedIp === process.env.TEST_ALLOWED_PEER_IP ? blockedIp.replace(/\.1$/, '.2') : blockedIp;
    const permission = await active.request(0x0008, [peerAddress(ip, 40000)]);
    assert.equal(permission.integrityValid, true);
    assert.equal(errorCode(permission), 403, `Private/special peer ${ip} must be denied (exception: ${process.env.TEST_ALLOWED_PEER_IP || 'none'})`);
    const channel = await active.request(0x0009, [attribute(0x000c, [0x40, 0, 0, 0]), peerAddress(ip, 40000)]);
    assert.equal(channel.integrityValid, true);
    assert.equal(errorCode(channel), 403, 'ChannelBind must not bypass denied peer permissions');
  }
  const publicPermission = await active.request(0x0008, [peerAddress('203.0.113.5', 40000)]);
  assert.equal(publicPermission.type, 0x0108, 'Public peer permissions must remain available');
  console.log('PASS destinations: private/special CreatePermission and ChannelBind rejected; public permission accepted.');

  const allowedIp = process.env.TEST_ALLOWED_PEER_IP;
  if (allowedIp) {
    const receiver = createSocket('udp4');
    try {
      receiver.bind(0, allowedIp);
      await once(receiver, 'listening');
      const address = peerAddress(allowedIp, receiver.address().port);
      assert.equal((await active.request(0x0008, [address])).type, 0x0108);
      const payload = Buffer.from('pigeon-private-relay-regression');
      const received = once(receiver, 'message', { signal: AbortSignal.timeout(5000) });
      active.connection.send(message(0x0016, [address, attribute(0x0013, payload)]));
      assert.deepEqual((await received)[0], payload);
      console.log('PASS trusted private peer: explicit host exception relays UDP payload.');
    } finally { receiver.close(); }
  }
} finally {
  for (const session of sessions) {
    try { await session.release?.(); } finally { session.connection.close(); }
  }
}
