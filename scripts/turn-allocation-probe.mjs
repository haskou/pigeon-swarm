// Local diagnostic: RFC 8489 STUN framing/integrity and RFC 8656 Allocate.
// This exercises TURN REST authentication, not WebRTC media or NAT traversal.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';

const cookie = 0x2112a442;

function attribute(type, value) {
  const bytes = Buffer.from(value);
  const result = Buffer.alloc(4 + Math.ceil(bytes.length / 4) * 4);
  result.writeUInt16BE(type);
  result.writeUInt16BE(bytes.length, 2);
  bytes.copy(result, 4);
  return result;
}

function message(type, attributes, key) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type);
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  header.writeUInt32BE(cookie, 4);
  randomBytes(12).copy(header, 8);
  const prefix = Buffer.concat([header, body]);
  return key
    ? Buffer.concat([prefix, attribute(0x0008, createHmac('sha1', key).update(prefix).digest())])
    : prefix;
}

function parse(bytes, request, key) {
  if (bytes.length < 20 || bytes.readUInt32BE(4) !== cookie ||
      bytes.readUInt16BE(2) % 4 || bytes.length !== 20 + bytes.readUInt16BE(2) ||
      !bytes.subarray(8, 20).equals(request.subarray(8, 20))) {
    throw new Error('Invalid TURN response framing or transaction.');
  }
  const attributes = new Map();
  let integrityValid = false;
  for (let offset = 20; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error('Truncated TURN attribute.');
    const type = bytes.readUInt16BE(offset);
    const length = bytes.readUInt16BE(offset + 2);
    if (offset + 4 + length > bytes.length || attributes.has(type)) throw new Error('Invalid TURN attribute.');
    const value = bytes.subarray(offset + 4, offset + 4 + length);
    // Attributes following MESSAGE-INTEGRITY are not authenticated.
    if (!integrityValid) attributes.set(type, value);
    if (type === 0x0008 && key) {
      const prefix = Buffer.from(bytes.subarray(0, offset));
      prefix.writeUInt16BE(offset + 24 - 20, 2);
      const expected = createHmac('sha1', key).update(prefix).digest();
      if (length !== expected.length || !timingSafeEqual(expected, value)) throw new Error('TURN response integrity check failed.');
      integrityValid = true;
    }
    offset += 4 + Math.ceil(length / 4) * 4;
  }
  return { type: bytes.readUInt16BE(0), attributes, integrityValid };
}

function errorCode(response) {
  const value = response.attributes.get(0x0009);
  return value?.length >= 4 ? (value[2] & 7) * 100 + value[3] : undefined;
}

async function openTransport(transport, port) {
  const socket = transport === 'udp' ? createSocket('udp4') : transport === 'tls'
    ? connectTls({ host: '127.0.0.1', port, servername: process.env.CALLS_TURN_TLS_SERVER_NAME, rejectUnauthorized: true, minVersion: 'TLSv1.2' })
    : createConnection({ host: '127.0.0.1', port });
  let socketError;
  socket.on('error', (error) => { socketError = error; });
  if (transport === 'udp') socket.connect(port, '127.0.0.1');
  try {
    await once(socket, transport === 'tls' ? 'secureConnect' : 'connect', { signal: AbortSignal.timeout(5000) });
  } catch {
    if (transport === 'udp') socket.close();
    else socket.destroy();
    throw new Error(transport === 'tls' ? 'TURN TLS connection or certificate validation failed.' : 'Cannot connect to the local TURN listener.');
  }
  return {
    close: () => transport === 'udp' ? socket.close() : socket.destroy(),
    exchange: (request, key) => new Promise((resolve, reject) => {
      if (socketError) return reject(new Error('TURN socket unavailable.'));
      let pending = Buffer.alloc(0);
      const event = transport === 'udp' ? 'message' : 'data';
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.off(event, receive);
        socket.off('error', fail);
        socket.off('close', closed);
        error ? reject(error) : resolve(value);
      };
      const fail = () => finish(new Error('TURN network request failed.'));
      const closed = () => finish(new Error('TURN connection closed before a response.'));
      const receive = (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        if (transport !== 'udp' && (pending.length < 20 || pending.length < 20 + pending.readUInt16BE(2))) return;
        try { finish(null, parse(pending, request, key)); } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('TURN response timed out.')), 5000);
      socket.on(event, receive);
      socket.once('error', fail);
      socket.once('close', closed);
      if (transport === 'udp') socket.send(request, (error) => { if (error) fail(); });
      else socket.write(request);
    }),
  };
}

async function check(transport, port, secret, expiresIn, expectedAllocation) {
  const connection = await openTransport(transport, port);
  try {
    const requestedTransport = attribute(0x0019, Buffer.from([17, 0, 0, 0]));
    const challenge = await connection.exchange(message(0x0003, [requestedTransport]));
    const realm = challenge.attributes.get(0x0014);
    const nonce = challenge.attributes.get(0x0015);
    if (challenge.type !== 0x0113 || errorCode(challenge) !== 401 || !realm?.length || !nonce?.length) {
      throw new Error('TURN did not require authentication with a realm and nonce.');
    }
    const username = `${Math.floor(Date.now() / 1000) + expiresIn}:deployment-probe`;
    const password = createHmac('sha1', secret).update(username).digest('base64');
    const key = createHash('md5').update(`${username}:${realm.toString()}:${password}`).digest();
    const auth = [attribute(0x0006, username), attribute(0x0014, realm), attribute(0x0015, nonce)];
    const result = await connection.exchange(message(0x0003, [requestedTransport, ...auth], key), key);
    if (!expectedAllocation) {
      if (result.type !== 0x0113 || errorCode(result) !== 401) throw new Error('TURN did not reject invalid credentials with 401.');
      return;
    }
    if (result.type !== 0x0103 || !result.integrityValid || !result.attributes.has(0x0016)) {
      throw new Error('Authenticated allocation failed; check that backend and coturn use the same secret.');
    }
    const expectedIp = process.env.CALLS_TURN_EXTERNAL_IP?.split('/')[0];
    const relayAddress = result.attributes.get(0x0016);
    if (expectedIp) {
      const decoded = Buffer.alloc(4);
      if (relayAddress.length === 8 && relayAddress[1] === 1) {
        decoded.writeUInt32BE((relayAddress.readUInt32BE(4) ^ cookie) >>> 0);
      }
      if (relayAddress.length !== 8 || relayAddress[1] !== 1 || [...decoded].join('.') !== expectedIp) {
        throw new Error('TURN allocated an unexpected advertised IPv4 address.');
      }
    }
    const released = await connection.exchange(message(0x0004, [attribute(0x000d, Buffer.alloc(4)), ...auth], key), key);
    if (released.type !== 0x0104 || !released.integrityValid) throw new Error('TURN allocation cleanup failed.');
  } finally {
    connection.close();
  }
}

try {
  const secret = process.env.CALLS_TURN_SHARED_SECRET;
  delete process.env.CALLS_TURN_SHARED_SECRET;
  if (!secret) throw new Error('Backend TURN secret is missing.');
  const config = readFileSync(process.env.PIGEON_TURN_RUNTIME_CONFIG_PATH || '/run/pigeon/calls-turn-runtime.conf', 'utf8');
  const settings = new Map(config.trim().split('\n').map((line) => line.split('=')));
  const port = Number(settings.get('listening_port'));
  if (settings.get('enabled') !== 'true' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Enable TURN with a valid persisted listener port before running this check.');
  }
  const transports = [['udp', port], ['tcp', port]];
  if (process.env.CALLS_TURN_TLS_PORT) {
    const tlsPort = Number(process.env.CALLS_TURN_TLS_PORT);
    if (!Number.isInteger(tlsPort) || tlsPort < 1 || tlsPort > 65535 || !process.env.CALLS_TURN_TLS_SERVER_NAME) {
      throw new Error('TLS verification requires a valid port and certificate hostname.');
    }
    transports.push(['tls', tlsPort]);
  }
  for (const [transport, targetPort] of transports) {
    await check(transport, targetPort, secret, 60, true);
    await check(transport, targetPort, randomBytes(32).toString('hex'), 60, false);
    await check(transport, targetPort, secret, -60, false);
    console.log(`PASS ${transport}: authenticated allocation; wrong and expired credentials rejected.`);
  }
  console.log('Local allocation checks only. Public reachability and WebRTC media remain unverified.');
} catch (error) {
  // Never print packets, keys, credentials or raw socket errors.
  const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : '';
  console.error(`FAIL: ${error.code ? `Cannot access TURN runtime configuration or transport${code}.` : error.message}`);
  process.exitCode = 1;
}
