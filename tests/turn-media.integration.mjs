import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

test('actual backend issuer and browser audio through TURN UDP, TCP and TLS after restart', { timeout: 300000 }, () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'pigeon-media-'));
  const certificates = resolve(temporary, 'certificates');
  mkdirSync(certificates, { mode: 0o755 });
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: `pigeon-media-${randomBytes(5).toString('hex')}`,
    COMPOSE_FILE: ['docker-compose.yml', 'docker-compose.turn-tls.yml', 'tests/compose.turn-media-test.yml'].map(file => resolve(file)).join(':'),
    COMPOSE_ENV_FILES: '/dev/null',
    CALLS_TURN_SHARED_SECRET: randomBytes(32).toString('hex'),
    CALLS_TURN_TLS_CERTS_DIR: certificates,
    CALLS_TURN_TLS_SERVER_NAME: 'relay.test',
    CALLS_TURN_TLS_PORT: '5349',
    CALLS_TURN_URLS: 'turn:relay.test:4101?transport=udp,turn:relay.test:4101?transport=tcp,turns:relay.test:5349?transport=tcp',
    CALLS_TURN_USER_QUOTA: '16',
    CALLS_TURN_TOTAL_QUOTA: '128',
    CALLS_TURN_ALLOWED_PEER_IPS: '',
    CALLS_TURN_EXTERNAL_IP: '',
  };
  const run = (command, args, options = {}) => spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000, ...options });
  const compose = (...args) => {
    const result = run('docker', ['compose', ...args]);
    assert.equal(result.status, 0, `docker compose ${args[0]} failed (configuration output withheld)`);
    return result.stdout;
  };
  try {
    const generated = run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=relay.test', '-addext', 'subjectAltName=DNS:relay.test', '-keyout', resolve(certificates, 'privkey.pem'), '-out', resolve(certificates, 'fullchain.pem')]);
    assert.equal(generated.status, 0, 'Temporary certificate generation failed');
    chmodSync(resolve(certificates, 'privkey.pem'), 0o644);
    const cert = new X509Certificate(readFileSync(resolve(certificates, 'fullchain.pem')));
    const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    compose('up', '-d', '--wait', '--wait-timeout', '90', 'app');
    const image = run('docker', ['image', 'inspect', env.PIGEON_TEST_IMAGE || 'ghcr.io/haskou/pigeon-swarm:latest', '--format', '{{index .RepoDigests 0}}']);
    assert.equal(image.status, 0, 'Application image digest must be available');
    assert.match(image.stdout.trim(), /^ghcr\.io\/haskou\/pigeon-swarm@sha256:[a-f0-9]{64}$/);
    console.log(`Application image: ${image.stdout.trim()}`);
    const ip = compose('exec', '-T', 'app', 'node', '-e', "console.log(Object.values(require('node:os').networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address)").trim();
    env.CALLS_TURN_EXTERNAL_IP = ip;
    env.CALLS_TURN_ALLOWED_PEER_IPS = ip;
    const setup = run('docker', ['compose', 'exec', '-T', 'app', 'node', '--input-type=module'], { input: `
      const result = await fetch('http://127.0.0.1:8080/api/node/relay-configuration/', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicHost: ${JSON.stringify(ip)}, callsRelay: { port: 4101 },
          privateRelay: { enabled: true, portStart: 4102, portEnd: 4133, publicationEnabled: false, discoveryEnabled: false },
          publicNetwork: { enabled: false }, manualRelayMultiaddrs: [] }),
      });
      if (result.status !== 200) throw new Error('Fixture relay configuration failed: status ' + result.status);
    ` });
    assert.equal(setup.status, 0, setup.stderr);
    compose('up', '-d', '--wait', '--wait-timeout', '45', 'turn', 'browser');
    for (let cycle = 0; cycle < 2; cycle += 1) {
      if (cycle) compose('restart', 'turn');
      // Wait for the actual backend's persisted runtime settings to reach coturn.
      const health = run('docker', ['compose', 'exec', '-T', 'turn', 'sh', '-c', 'for i in $(seq 1 20); do pidof turnserver >/dev/null && /opt/pigeon/check-turn-runtime.sh && exit 0; sleep 1; done; exit 1']);
      assert.equal(health.status, 0, 'TURN did not load the backend runtime configuration');
      for (const transport of ['udp', 'tcp', 'tls']) {
        const result = run('docker', ['compose', 'exec', '-T', '-e', `PIGEON_MEDIA_TRANSPORT=${transport}`, '-e', `PIGEON_TEST_TLS_SPKI=${spki}`, '-e', `PIGEON_TEST_RELAY_IP=${ip}`, 'browser', 'node', '/opt/pigeon/tests/turn-browser-probe.mjs']);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, new RegExp(`PASS ${transport}:`));
        console.log(`Cycle ${cycle + 1}: ${result.stdout.trim()}`);
      }
    }
  } finally {
    compose('down', '--volumes', '--remove-orphans');
    rmSync(temporary, { recursive: true, force: true });
  }
});
