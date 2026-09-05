import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const publicFallback = 'Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3';
const secretError = 'CALLS_TURN_SHARED_SECRET must be a private deployment secret';

for (const overrides of [
  { CALLS_TURN_USER_QUOTA: '0' },
  { CALLS_TURN_TOTAL_QUOTA: '-1' },
  { CALLS_TURN_USER_QUOTA: '999999999999999999999' },
  { CALLS_TURN_TOTAL_QUOTA: '4\nno-auth' },
  { CALLS_TURN_USER_QUOTA: '5', CALLS_TURN_TOTAL_QUOTA: '4' },
]) {
  test('TURN rejects invalid allocation quotas before startup', () => {
    const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
      encoding: 'utf8', timeout: 2000,
      env: { ...process.env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'), ...overrides },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TURN allocation quotas must be integers/);
  });
}

for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.0/8', '10.0.0.1\nno-auth', '10.0.0.1,', '10.0.0.999', '10.0.0.1-10.0.0.255']) {
  test('TURN refuses broad or unsafe private peer exceptions', () => {
    const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
      encoding: 'utf8', timeout: 2000,
      env: { ...process.env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'), CALLS_TURN_ALLOWED_PEER_IPS: address },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CALLS_TURN_ALLOWED_PEER_IPS must contain only/);
  });
}

for (const [name, secret] of [
  ['missing', undefined],
  ['empty', ''],
  ['public fallback', publicFallback],
  ['too short', 'short-secret'],
  ['configuration injection', `${randomBytes(32).toString('hex')}\nno-auth`],
  ['oversized', 'a'.repeat(257)],
]) {
  test(`TURN refuses a ${name} secret before reading runtime configuration`, () => {
    const env = { ...process.env };
    delete env.CALLS_TURN_SHARED_SECRET;
    if (secret !== undefined) env.CALLS_TURN_SHARED_SECRET = secret;
    const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
      encoding: 'utf8', env, timeout: 2000,
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(secretError), result.stderr);
    if (secret) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  });
}

test('Compose rejects a missing secret without rendering configuration', () => {
  const env = { ...process.env };
  delete env.CALLS_TURN_SHARED_SECRET;
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', 'config', '--quiet'], {
    encoding: 'utf8', env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CALLS_TURN_SHARED_SECRET/);
});

test('Compose accepts an explicitly supplied deployment secret', () => {
  const secret = randomBytes(32).toString('hex');
  const result = spawnSync('docker', ['compose', '--env-file', '/dev/null', 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, CALLS_TURN_SHARED_SECRET: secret },
  });
  assert.equal(result.status, 0, 'Compose must accept a private deployment secret');
  const config = JSON.parse(result.stdout);
  assert.ok(config.services.app.environment.CALLS_TURN_SHARED_SECRET === secret, 'Backend must receive the deployment secret');
  assert.ok(config.services.turn.environment.CALLS_TURN_SHARED_SECRET === secret, 'Coturn must receive the same deployment secret');
});

for (const externalIp of ['relay.example.com', '192.0.2.999', '192.0.2.1/10.0.0.1/10.0.0.2', '192.0.2.1\nno-auth']) {
  test('TURN rejects invalid explicit IPv4 mapping', () => {
    const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
      encoding: 'utf8', timeout: 2000,
      env: { ...process.env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'), CALLS_TURN_EXTERNAL_IP: externalIp },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CALLS_TURN_EXTERNAL_IP must be an IPv4 address or public\/private IPv4 mapping/);
  });
}

test('explicit TLS refuses missing certificate files', () => {
  const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
    encoding: 'utf8', timeout: 2000,
    env: { ...process.env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'), CALLS_TURN_TLS_ENABLED: 'true' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TURN TLS requires readable fullchain.pem and privkey.pem/);
});

for (const [tlsPort, webPort] of [['8080', '9000'], ['9000', '9000']]) {
  test('TLS refuses collisions with the internal or published web listener', () => {
    const result = spawnSync('sh', ['scripts/run-turn-from-runtime-config.sh'], {
      encoding: 'utf8', timeout: 2000,
      env: { ...process.env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'),
        CALLS_TURN_TLS_ENABLED: 'true', CALLS_TURN_TLS_PORT: tlsPort, PIGEON_WEB_HOST_PORT: webPort },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TURN TLS port conflicts with the internal or published web listener/);
  });
}
