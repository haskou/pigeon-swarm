import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const publicFallback = 'Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3';
const secretError = 'CALLS_TURN_SHARED_SECRET must be a private deployment secret';

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
