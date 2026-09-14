import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { attribute, message, errorCode, openTransport, readIssuerSecret } from '../scripts/turn-allocation-probe.mjs';

const secret = readIssuerSecret();
const settings = new Map(readFileSync('/run/pigeon/calls-turn-runtime.conf', 'utf8').trim().split('\n').map(line => line.split('=')));
const listener = Number(settings.get('listening_port'));
const poolSize = Number(settings.get('relay_port_end')) - Number(settings.get('relay_port_start')) + 1;
assert.ok(poolSize > 2 && poolSize <= 64, 'Use an isolated small relay pool');
const privateIp = Object.values(networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address;
const publicIp = process.env.CALLS_TURN_EXTERNAL_IP;
assert.equal(publicIp, '192.0.2.42', 'Use the isolated public mapping fixture');
const sessions = [];
const victims = [];
let flood;

function peerAddress(ip, port) {
  const value = Buffer.alloc(8);
  value[1] = 1;
  value.writeUInt16BE(port ^ 0x2112, 2);
  value.writeUInt32BE((Buffer.from(ip.split('.').map(Number)).readUInt32BE() ^ 0x2112a442) >>> 0, 4);
  return attribute(0x0012, value);
}

async function allocate(transport = 17) {
  const connection = await openTransport('tcp', listener);
  const session = { connection, allocated: false };
  sessions.push(session);
  const requested = attribute(0x0019, [transport, 0, 0, 0]);
  const challenge = await connection.exchange(message(0x0003, [requested]));
  assert.equal(errorCode(challenge), 401);
  const realm = challenge.attributes.get(0x0014);
  const username = `${Math.floor(Date.now() / 1000) + 120}:${randomBytes(12).toString('hex')}`;
  const password = createHmac('sha1', secret).update(username).digest('base64');
  const key = createHash('md5').update(`${username}:${realm.toString()}:${password}`).digest();
  const auth = [attribute(0x0006, username), attribute(0x0014, realm), attribute(0x0015, challenge.attributes.get(0x0015))];
  session.request = (type, attributes) => connection.exchange(message(type, [...attributes, ...auth], key), key);
  const result = await session.request(0x0003, [requested]);
  assert.equal(result.integrityValid, true);
  session.code = errorCode(result);
  if (!session.code) {
    assert.equal(result.type, 0x0103);
    const address = result.attributes.get(0x0016);
    assert.equal(address[1], 1);
    session.port = address.readUInt16BE(2) ^ 0x2112;
    session.allocated = true;
  }
  session.release = async () => {
    if (!session.allocated) return;
    assert.equal((await session.request(0x0004, [attribute(0x000d, Buffer.alloc(4))])).type, 0x0104);
    session.allocated = false;
    await delay(1100);
  };
  return session;
}

async function receiver(port = 0) {
  const socket = createSocket('udp4');
  victims.push(socket);
  socket.bind(port, privateIp);
  await once(socket, 'listening');
  const arrived = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
  socket.send('receiver sanity check', socket.address().port, privateIp);
  assert.equal((await arrived)[0].toString(), 'receiver sanity check');
  let received = 0;
  socket.on('message', () => { received += 1; });
  return { port: socket.address().port, count: () => received };
}

const payload = Buffer.from('private-service-access-must-be-blocked');
function channelData(channel) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(channel);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload, Buffer.alloc((4 - payload.length % 4) % 4)]);
}

async function bind(session, port, channel) {
  const number = Buffer.alloc(4);
  number.writeUInt16BE(channel);
  assert.equal((await session.request(0x0009, [attribute(0x000c, number), peerAddress(publicIp, port)])).type, 0x0109);
}

function sendBoth(session, port, channel) {
  for (const ip of [publicIp, privateIp]) {
    session.connection.send(message(0x0016, [peerAddress(ip, port), attribute(0x0013, payload)]));
  }
  session.connection.send(channelData(channel));
}

async function assertBlocked(session, victim, channel) {
  for (let count = 0; count < 8; count += 1) sendBoth(session, victim.port, channel);
  assert.equal((await session.request(0x0008, [peerAddress(publicIp, 0)])).type, 0x0108);
  await delay(150);
  assert.equal(victim.count(), 0, 'TURN must not deliver data to an unrelated UDP service on its own IP');
}

try {
  const source = await allocate();
  const target = await allocate();
  assert.equal(source.code, undefined);
  assert.equal(target.code, undefined);
  assert.equal((await source.request(0x0008, [peerAddress(publicIp, 0)])).type, 0x0108);
  await bind(source, target.port, 0x4000);
  await target.release();
  const reused = await receiver(target.port);
  await assertBlocked(source, reused, 0x4000);
  console.log('PASS self relay: retained permissions and channels cannot reach a non-TURN service reusing a released relay port.');

  const unrelated = await receiver();
  await bind(source, unrelated.port, 0x4001);
  await assertBlocked(source, unrelated, 0x4001);
  console.log('PASS self relay: Send indications and ChannelData cannot reach another UDP port through public or private addressing.');

  for (const ip of ['10.0.0.1', '127.0.0.2', '172.16.255.254', '192.168.0.1', '169.254.169.254']) {
    assert.notEqual(ip, privateIp);
    assert.equal(errorCode(await source.request(0x0008, [peerAddress(ip, 40000)])), 403);
  }
  assert.equal((await allocate(6)).code, 442, 'TCP relay allocations must remain disabled');

  flood = setInterval(() => sendBoth(source, reused.port, 0x4000), 2);
  const pressure = await Promise.all(Array.from({ length: poolSize }, () => allocate()));
  clearInterval(flood);
  flood = undefined;
  assert.ok(pressure.some(session => session.code === 508), 'Allocation pressure must exhaust available bound relay ports');
  assert.ok(pressure.every(session => session.code === undefined || session.code === 508));
  await assertBlocked(source, reused, 0x4000);
  console.log('PASS self relay: concurrent allocation attempts cannot expose a service occupying a relay-range port; private destinations and TCP relay remain denied.');
} finally {
  clearInterval(flood);
  await Promise.all(sessions.map(async session => {
    try { await session.release?.(); } finally { session.connection.close(); }
  }));
  for (const socket of victims) socket.close();
}
