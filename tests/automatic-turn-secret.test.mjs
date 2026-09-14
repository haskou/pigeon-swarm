import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { readIssuerSecret } from '../scripts/turn-allocation-probe.mjs';

const run = (stored, runtime, override = '') => new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/prepare-turn-secret.cjs', stored, runtime], {
    env: { ...process.env, CALLS_TURN_SHARED_SECRET: override },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('close', status => resolve({ status, output }));
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pigeon-turn-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { stored: join(dir, 'persisted'), runtime: join(dir, 'runtime') };
}

test('generates distinct private secrets and retains them across restarts', async t => {
  const a = await fixture(t), b = await fixture(t);
  assert.equal((await run(a.stored, a.runtime)).status, 0);
  assert.equal((await run(b.stored, b.runtime)).status, 0);
  const first = await readFile(a.stored, 'utf8');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, await readFile(b.stored, 'utf8'));
  assert.equal(await readFile(a.runtime, 'utf8'), first);
  const repeat = await run(a.stored, a.runtime);
  assert.equal(repeat.status, 0);
  assert.equal(await readFile(a.stored, 'utf8'), first);
  assert.equal(repeat.output, '');
  for (const path of [a.stored, a.runtime]) assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('concurrent first starts agree on the persisted secret', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({length: 8}, () => run(f.stored, f.runtime)));
  assert.ok(results.every(result => result.status === 0));
  assert.equal(await readFile(f.stored, 'utf8'), await readFile(f.runtime, 'utf8'));
});

test('explicit override is persisted without printing it', async t => {
  const f = await fixture(t);
  const secret = 'a'.repeat(64);
  assert.equal((await run(f.stored, f.runtime, secret)).status, 0);
  const result = await run(f.stored, f.runtime);
  assert.equal(result.status, 0);
  assert.equal(result.output, '');
  assert.equal(await readFile(f.runtime, 'utf8'), secret);
});

for (const value of ['short', 'x'.repeat(257), 'x'.repeat(64) + '\nno-auth', 'Kestrel7-Quartz9-Pigeon4-Nebula8-Harbor2-Cipher6-Orbit5-Velvet3']) {
  test('rejects an invalid explicit secret without disclosure', async t => {
    const f = await fixture(t);
    const result = await run(f.stored, f.runtime, value);
    assert.notEqual(result.status, 0);
    assert.ok(!result.output.includes(value));
  });
}

test('fails closed for corrupt or symbolic-link persistent secrets', async t => {
  const f = await fixture(t);
  await writeFile(f.stored, 'corrupt', {mode: 0o600});
  assert.notEqual((await run(f.stored, f.runtime)).status, 0);
  assert.equal(await readFile(f.stored, 'utf8'), 'corrupt');
  await rm(f.stored);
  await symlink(f.runtime, f.stored);
  assert.notEqual((await run(f.stored, f.runtime)).status, 0);
});

test('diagnostic reads the private file but preserves an explicit mismatch override', async t => {
  const f = await fixture(t);
  const saved = {...process.env};
  t.after(() => { process.env = saved; });
  process.env.CALLS_TURN_SECRET_FILE = f.runtime;
  delete process.env.CALLS_TURN_SHARED_SECRET;
  await run(f.stored, f.runtime);
  assert.ok(readIssuerSecret() === await readFile(f.runtime, 'utf8'));
  process.env.CALLS_TURN_SHARED_SECRET = 'b'.repeat(64);
  assert.ok(readIssuerSecret() === 'b'.repeat(64));
  assert.equal(process.env.CALLS_TURN_SHARED_SECRET, undefined);
});

test('diagnostic rejects unsafe or symbolic-link secret files', async t => {
  const f = await fixture(t);
  const saved = {...process.env};
  t.after(() => { process.env = saved; });
  delete process.env.CALLS_TURN_SHARED_SECRET;
  process.env.CALLS_TURN_SECRET_FILE = f.runtime;
  await writeFile(f.runtime, 'a'.repeat(64), {mode: 0o644});
  assert.throws(() => readIssuerSecret(), /unsafe permissions or format/);
  await rm(f.runtime);
  await writeFile(f.stored, 'a'.repeat(64), {mode: 0o600});
  await symlink(f.stored, f.runtime);
  assert.throws(() => readIssuerSecret());
});
