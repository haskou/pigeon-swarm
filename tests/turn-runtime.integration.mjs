import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

for (const tls of [false, true]) {
test(`real coturn validates issuer credentials, restart and secret handling (TLS ${tls ? 'enabled' : 'disabled'})`, { timeout: 240000 }, () => {
  const secret = randomBytes(32).toString('hex');
  const temporary = mkdtempSync(resolve(tmpdir(), 'pigeon-turn-tls-'));
  const certificates = resolve(temporary, 'certificates');
  if (tls) {
    mkdirSync(certificates, { mode: 0o755 });
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=relay.test', '-addext', 'subjectAltName=DNS:relay.test',
      '-keyout', resolve(certificates, 'privkey.pem'), '-out', resolve(certificates, 'fullchain.pem')], { encoding: 'utf8' });
    assert.equal(generated.status, 0, 'Temporary test certificate generation failed');

  }
  const files = ['docker-compose.yml', ...(tls ? ['docker-compose.turn-tls.yml'] : []), 'tests/compose.turn-test.yml', ...(tls ? ['tests/compose.turn-tls-test.yml'] : [])];
  const env = {
    ...process.env, PIGEON_TURN_SERVICE: 'turn',
    CALLS_TURN_SHARED_SECRET: secret,
    COMPOSE_PROJECT_NAME: `pigeon-turn-test-${randomBytes(5).toString('hex')}`,
    COMPOSE_FILE: files.map((file) => resolve(file)).join(':'),
    COMPOSE_ENV_FILES: '/dev/null',
    CALLS_TURN_TLS_CERTS_DIR: certificates,
    CALLS_TURN_TLS_SERVER_NAME: 'relay.test',
    CALLS_TURN_TLS_PORT: '5349',
    CALLS_TURN_URLS: 'turns:relay.test:5349?transport=tcp',
    CALLS_TURN_EXTERNAL_IP: tls ? '192.0.2.42/127.0.0.1' : '',
    CALLS_TURN_USER_QUOTA: '3',
    CALLS_TURN_TOTAL_QUOTA: '5',
    CALLS_TURN_ALLOWED_PEER_IPS: '',
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
    compose('up', '-d', '--wait', '--wait-timeout', '45', 'app');
    if (tls) {
      const provisioned = run('docker', ['compose', 'exec', '-T', 'app', 'node', '-e', `
        const fs = require('node:fs');
        const files = JSON.parse(fs.readFileSync(0, 'utf8'));
        for (const [name, content] of Object.entries(files)) {
          const path = '/run/pigeon-test-tls/' + name;
          fs.writeFileSync(path, content, {mode: 0o600});
          fs.chownSync(path, 1000, 1000);
        }
      `], {input: JSON.stringify(Object.fromEntries(['fullchain.pem', 'privkey.pem'].map(name => [name, readFileSync(resolve(certificates, name), 'utf8')])))});
      assert.equal(provisioned.status, 0, 'Private TLS fixture provisioning failed');
    }
    compose('up', '-d', '--wait', '--wait-timeout', '45', 'turn');
    if (tls) {
      assert.equal(compose('exec', '-T', 'turn', 'sh', '-c', 'test -r /run/pigeon-turn-tls/privkey.pem && stat -c "%u:%g:%a" /run/pigeon-turn-tls/privkey.pem').trim(), '1000:1000:600');
    }
    compose('exec', '-T', '--user', '1000:1000', 'app', 'sh', '-c', 'printf "version=1\nenabled=true\nlistening_port=4101\nrelay_port_start=4102\nrelay_port_end=4121\n" > /run/pigeon/calls-turn-runtime.conf');
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle) compose('restart', 'turn');
      const verified = run('sh', ['scripts/verify-turn.sh']);
      assert.equal(verified.status, 0, verified.stdout + verified.stderr);
      assert.match(verified.stdout, /PASS udp:/);
      assert.match(verified.stdout, /PASS tcp:/);
      if (tls) assert.match(verified.stdout, /PASS tls:/);
      assert.ok(!`${verified.stdout}${verified.stderr}`.includes(secret));
    }
    const mismatch = run('docker', ['compose', 'exec', '-T', '-e', 'CALLS_TURN_SHARED_SECRET', 'app', 'node', '--input-type=module'], {
      input: probe,
      env: { ...env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex') },
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /backend and coturn use the same secret/);
    if (tls) {
      for (const override of ['CALLS_TURN_TLS_SERVER_NAME=wrong.test', 'NODE_EXTRA_CA_CERTS=']) {
        const rejected = run('docker', ['compose', 'exec', '-T', '-e', override, 'app', 'node', '--input-type=module'], { input: probe });
        assert.equal(rejected.status, 1);
        assert.match(rejected.stderr, /TLS connection or certificate validation failed/);
      }
      const wrongMapping = run('docker', ['compose', 'exec', '-T', '-e', 'CALLS_TURN_EXTERNAL_IP=192.0.2.99', 'app', 'node', '--input-type=module'], { input: probe });
      assert.equal(wrongMapping.status, 1);
      assert.match(wrongMapping.stderr, /unexpected advertised IPv4 address/);
      for (const port of ['4101', '4103', '70000']) {
        const invalidPort = run('docker', ['compose', 'run', '--rm', '-T', '--no-deps', '-e', `CALLS_TURN_TLS_PORT=${port}`, 'turn']);
        assert.equal(invalidPort.status, 1);
        assert.ok(invalidPort.stderr.includes('TURN TLS port must be valid and outside the plain listener and relay range.'), 'TLS port conflicts must fail before coturn starts');
      }
    }
    const logs = compose('logs', '--no-color', 'turn');
    assert.ok(!logs.includes(secret), 'TURN logs must not contain the shared secret');
    const policies = run('docker', ['compose', 'exec', '-T', 'app', 'node', '/opt/pigeon/tests/turn-policy-probe.mjs']);
    assert.equal(policies.status, 0, policies.stdout + policies.stderr);
    assert.match(policies.stdout, /PASS quotas:/);
    assert.match(policies.stdout, /PASS destinations:/);
    const privateIp = compose('exec', '-T', 'app', 'node', '-e', "console.log(Object.values(require('node:os').networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address)").trim();
    env.CALLS_TURN_ALLOWED_PEER_IPS = privateIp;
    compose('up', '-d', '--no-deps', '--force-recreate', 'turn');
    const ready = run('sh', ['scripts/verify-turn.sh']);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    const exception = run('docker', ['compose', 'exec', '-T', '-e', `TEST_ALLOWED_PEER_IP=${privateIp}`, 'app', 'node', '/opt/pigeon/tests/turn-policy-probe.mjs']);
    assert.equal(exception.status, 0, exception.stdout + exception.stderr);
    assert.match(exception.stdout, /PASS trusted private peer:/);
  } finally {
    // Only this test's randomly named Compose project and its ephemeral volume.
    compose('down', '--volumes', '--remove-orphans');
    rmSync(temporary, { recursive: true, force: true });
  }
});
}


test('automatic secret persists and coturn reloads a rotated private runtime file', {timeout: 180000}, () => {
  const env = {...process.env, PIGEON_TURN_SERVICE: 'turn', CALLS_TURN_SHARED_SECRET: '', CALLS_TURN_EXTERNAL_IP: '',
    COMPOSE_PROJECT_NAME: `pigeon-turn-auto-${randomBytes(5).toString('hex')}`,
    COMPOSE_FILE: ['docker-compose.yml', 'tests/compose.turn-test.yml'].map(file => resolve(file)).join(':'),
    COMPOSE_ENV_FILES: '/dev/null'};
  const run = (args, options = {}) => spawnSync('docker', ['compose', ...args], {env, encoding: 'utf8', timeout: 90000, ...options});
  const compose = (...args) => {
    const result = run(args);
    assert.equal(result.status, 0, `Compose ${args[0]} failed (configuration withheld)`);
    return result.stdout.trim();
  };
  const verify = () => {
    const result = spawnSync('sh', ['scripts/verify-turn.sh'], {env, encoding: 'utf8', timeout: 45000});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS udp:/);
    assert.match(result.stdout, /PASS tcp:/);
  };
  const fingerprint = () => compose('exec', '-T', '--user', '1000:1000', 'app', 'node', '-e', `
    const fs = require('node:fs'), crypto = require('node:crypto');
    const stored = fs.readFileSync('/run/pigeon/persisted-secret');
    const runtime = fs.readFileSync('/run/pigeon/turn-shared-secret');
    if (!stored.equals(runtime) || !/^[a-f0-9]{64}$/.test(stored.toString())) process.exit(1);
    for (const path of ['/run/pigeon/persisted-secret', '/run/pigeon/turn-shared-secret']) {
      if ((fs.statSync(path).mode & 0o777) !== 0o600) process.exit(1);
    }
    console.log(crypto.createHash('sha256').update(stored).digest('hex'));
  `);
  try {
    compose('up', '-d', '--wait', '--wait-timeout', '45', 'app', 'turn');
    compose('exec', '-T', '--user', '1000:1000', 'app', 'sh', '-c', 'printf "version=1\nenabled=true\nlistening_port=4101\nrelay_port_start=4102\nrelay_port_end=4121\n" > /run/pigeon/calls-turn-runtime.conf');
    const original = fingerprint();
    verify();
    compose('restart', 'app', 'turn');
    assert.equal(fingerprint(), original);
    verify();
    compose('exec', '-T', '--user', '1000:1000', 'app', 'cp', '/run/pigeon/turn-shared-secret', '/run/pigeon/previous-secret');
    const override = randomBytes(32).toString('hex');
    const rotation = run(['exec', '-T', '--user', '1000:1000', '-e', 'CALLS_TURN_SHARED_SECRET', 'app', 'sh', '-c',
      'node /opt/pigeon/scripts/prepare-turn-secret.cjs /run/pigeon/persisted-secret /run/pigeon/turn-shared-secret'],
      {env: {...env, CALLS_TURN_SHARED_SECRET: override}});
    assert.equal(rotation.status, 0, 'Rotation failed (output withheld)');
    const rotated = fingerprint();
    assert.notEqual(rotated, original);
    compose('exec', '-T', 'turn', 'sh', '-c', `
      for attempt in $(seq 1 15); do
        if [ "$(sed -n 's/^static-auth-secret=//p' /run/pigeon-turn/turnserver.conf)" = "$(cat /run/pigeon/turn-shared-secret)" ]; then exit 0; fi
        sleep 1
      done
      exit 1
    `);
    verify();
    const mismatch = run(['exec', '-T', '--user', '1000:1000', '-e', 'CALLS_TURN_SHARED_SECRET', 'app', 'node', '--input-type=module'], {
      env: {...env, CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex')},
      input: readFileSync('scripts/turn-allocation-probe.mjs', 'utf8'),
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /backend and coturn use the same secret/);
    const previous = run(['exec', '-T', '--user', '1000:1000', '-e', 'CALLS_TURN_SECRET_FILE=/run/pigeon/previous-secret', 'app', 'node', '--input-type=module'], {
      input: readFileSync('scripts/turn-allocation-probe.mjs', 'utf8'),
    });
    assert.equal(previous.status, 1);
    assert.match(previous.stderr, /backend and coturn use the same secret/);
    compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '45', 'app', 'turn');
    assert.equal(fingerprint(), rotated);
    verify();
    assert.ok(!compose('logs', '--no-color', 'app', 'turn').includes(override), 'Logs exposed the override');
  } finally {
    compose('down', '--volumes', '--remove-orphans');
  }
});
