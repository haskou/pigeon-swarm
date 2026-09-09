import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const moduleUrl = new URL('../scripts/supervise-runtime.cjs', import.meta.url).href;

for (const failed of ['backend', 'turn']) {
  test(`a ${failed} exit stops its sibling and fails the container`, { timeout: 10000 }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { supervise } from ${JSON.stringify(moduleUrl)};
      const idle = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
      const fail = [process.execPath, '-e', 'setTimeout(() => process.exit(0), 200)'];
      supervise({backend: ${failed === 'backend' ? 'fail' : 'idle'}, turn: ${failed === 'turn' ? 'fail' : 'idle'}});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', data => output += data);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output, new RegExp(`${failed} stopped unexpectedly`));
  });
}

test('termination stops both real child processes', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { supervise } from ${JSON.stringify(moduleUrl)};
    const command = [process.execPath, '-e', 'console.log(process.pid); setInterval(() => {}, 1000)'];
    supervise({ backend: command, turn: command });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => output += data);
  const exited = once(child, 'exit');
  try {
    for (let i = 0; i < 100 && output.trim().split('\n').length < 2; i++) await delay(20);
    const pids = output.trim().split('\n').map(Number);
    assert.equal(pids.length, 2, 'both services must start');
    child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    child.kill('SIGKILL');
  }
});

test('shutdown is bounded when services ignore termination', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { supervise } from ${JSON.stringify(moduleUrl)};
    const command = [process.execPath, '-e', "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000)"];
    supervise({ backend: command, turn: command });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => output += data);
  const exited = once(child, 'exit');
  try {
    for (let i = 0; i < 100 && output.trim().split('\n').length < 2; i++) await delay(20);
    const pids = output.trim().split('\n').map(Number);
    assert.equal(pids.length, 2);
    child.kill('SIGTERM');
    assert.equal((await exited)[0], 1);
    await delay(100);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    child.kill('SIGKILL');
  }
});
