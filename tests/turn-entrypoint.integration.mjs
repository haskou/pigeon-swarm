import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('bundled entrypoint drops privileges and exports the persisted private secret', { timeout: 60000 }, () => {
  const image = process.env.PIGEON_TEST_IMAGE;
  assert.ok(image, 'Set PIGEON_TEST_IMAGE to the bundled application image');
  const volume = `pigeon-turn-entrypoint-${randomBytes(5).toString('hex')}`;
  const run = args => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 25000 });
    assert.equal(result.status, 0, `Docker ${args[0]} failed; output withheld`);
    return result.stdout.trim();
  };
  run(['volume', 'create', volume]);
  try {
    const args = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETGID', '--cap-add', 'SETUID',
      '-v', `${volume}:/data/local_storage`,
      '-v', `${resolve('docker-entrypoint.sh')}:/usr/local/bin/docker-entrypoint.sh:ro`,
      '-v', `${resolve('scripts/prepare-turn-secret.cjs')}:/usr/local/lib/pigeon/prepare-turn-secret.cjs:ro`,
      image, 'node', '-e', `
        const fs = require('node:fs'), crypto = require('node:crypto');
        if (process.getuid() !== 1000) process.exit(1);
        const stored = fs.readFileSync('/data/local_storage/turn-shared-secret', 'utf8');
        if (!/^[a-f0-9]{64}$/.test(stored) || stored !== process.env.CALLS_TURN_SHARED_SECRET) process.exit(1);
        if (stored !== fs.readFileSync('/run/pigeon/turn-shared-secret', 'utf8')) process.exit(1);
        if ((fs.statSync('/data/local_storage/turn-shared-secret').mode & 0o777) !== 0o600) process.exit(1);
        console.log(crypto.createHash('sha256').update(stored).digest('hex'));
      `];
    const first = run(args);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(run(args), first, 'Replacing the app container must preserve its secret');
  } finally {
    run(['volume', 'rm', volume]);
  }
});

for (const [label, options] of [
  ['native profiling', ['--perf-basic-prof', '--interpreted-frames-native-stack']],
  ['CPU profile directory', ['--cpu-prof', '--cpu-prof-dir', '/app/logs']],
  ['heap profile directory', ['--heap-prof', '--heap-prof-dir', '/app/logs']],
  ['memory limit', ['--max-old-space-size=256']],
]) {
  test(`Node ${label} options retain supervision of the bundled TURN process`, { timeout: 20000 }, () => {
    const image = process.env.PIGEON_TEST_IMAGE;
    assert.ok(image, 'Set PIGEON_TEST_IMAGE to the bundled application image');
    const accepted = spawnSync('docker', ['run', '--rm', '--network', 'none',
      '--entrypoint', 'node', image, ...options, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(accepted.status, 0, `The bundled Node runtime must accept ${label} options: ${accepted.stderr}`);
    const name = `pigeon-profiled-entrypoint-${randomBytes(5).toString('hex')}`;
    try {
      const started = spawnSync('docker', ['run', '-d', '--name', name, '--network', 'none',
        '-e', 'CALLS_TURN_USER_QUOTA=0', image, 'node', ...options, 'dist/index.js'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(started.status, 0, 'The image must accept Node profiling options');
      const stopped = spawnSync('docker', ['wait', name], { encoding: 'utf8', timeout: 8000 });
      assert.equal(stopped.status, 0, 'Invalid TURN configuration must stop the profiled backend, not leave it running without TURN');
      assert.equal(stopped.stdout.trim(), '1');
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 5000 });
      assert.equal(logs.status, 0);
      assert.ok(logs.stderr.includes('TURN allocation quotas must be integers'), 'The TURN validation must have run');
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 5000 });
    }
});
}
