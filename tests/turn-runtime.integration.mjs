import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

test('real coturn validates issuer credentials and keeps the shared secret out of process arguments and logs', { timeout: 240000 }, () => {
  const secret = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    CALLS_TURN_SHARED_SECRET: secret,
    COMPOSE_PROJECT_NAME: `pigeon-turn-test-${randomBytes(5).toString('hex')}`,
    COMPOSE_FILE: `${resolve('docker-compose.yml')}:${resolve('tests/compose.turn-test.yml')}`,
    COMPOSE_ENV_FILES: '/dev/null',
  };
  const run = (command, args, options = {}) => spawnSync(command, args, {
    env, encoding: 'utf8', timeout: 120000, ...options,
  });
  const compose = (...args) => {
    const result = run('docker', ['compose', ...args]);
    // Docker errors can contain resolved configuration. Do not dump it.
    assert.equal(result.status, 0, `docker compose ${args[0]} failed (output withheld to protect configuration)`);
    return result.stdout;
  };
  const probe = readFileSync('scripts/turn-allocation-probe.mjs', 'utf8');
  try {
    compose('up', '-d', '--wait', '--wait-timeout', '45', 'app', 'turn');
    compose('exec', '-T', 'app', 'sh', '-c', 'printf "version=1\nenabled=true\nlistening_port=4101\nrelay_port_start=4102\nrelay_port_end=4105\n" > /run/pigeon/calls-turn-runtime.conf');
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle) compose('restart', 'turn');
      const verified = run('sh', ['scripts/verify-turn.sh']);
      assert.equal(verified.status, 0, verified.stdout + verified.stderr);
      assert.match(verified.stdout, /PASS udp:/);
      assert.match(verified.stdout, /PASS tcp:/);
      assert.ok(!`${verified.stdout}${verified.stderr}`.includes(secret));
    }
    const mismatch = run('docker', ['compose', 'exec', '-T', '-e', 'CALLS_TURN_SHARED_SECRET', 'app', 'node', '--input-type=module'], {
      input: probe,
      env: { ...env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex') },
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /backend and coturn use the same secret/);
    const logs = compose('logs', '--no-color', 'turn');
    assert.ok(!logs.includes(secret), 'TURN logs must not contain the shared secret');
  } finally {
    // Only this test's randomly named Compose project and its ephemeral volume.
    compose('down', '--volumes', '--remove-orphans');
  }
});
