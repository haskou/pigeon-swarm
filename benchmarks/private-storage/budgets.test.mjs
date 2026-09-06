import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { assertWithinBudgets } from './budgets.mjs';

const measurements = () => Object.fromEntries(
  ['level', 'mongodb'].map((engine) => [engine, {
    writes: { p95Ms: 250 },
    reads: { p95Ms: 100 },
    pages: { p95Ms: 100 },
    expiry: { totalMs: 1000 },
  }]),
);

test('accepts both engines at the documented inclusive limits', () => {
  assert.doesNotThrow(() => assertWithinBudgets(measurements()));
});

for (const engine of ['level', 'mongodb']) {
  for (const operation of ['writes', 'reads', 'pages', 'expiry']) {
    test(`rejects an over-budget ${engine} ${operation} measurement`, () => {
      const result = measurements();
      const metric = operation === 'expiry' ? 'totalMs' : 'p95Ms';
      result[engine][operation][metric] += 0.01;
      assert.throws(() => assertWithinBudgets(result), {
        message: new RegExp(`${engine} ${operation}.*exceeds`),
      });
    });
  }
}

for (const invalid of [undefined, NaN, Infinity, -1]) {
  test(`rejects invalid timing ${String(invalid)}`, () => {
    const result = measurements();
    result.level.reads.p95Ms = invalid;
    assert.throws(() => assertWithinBudgets(result), /level reads.*invalid/);
  });
}

test('an over-budget run exits nonzero before reporting PASS', () => {
  const result = measurements();
  result.mongodb.expiry.totalMs = 1001;
  const script = `import { assertWithinBudgets } from './budgets.mjs';
    assertWithinBudgets(${JSON.stringify(result)});
    console.log(JSON.stringify({ assertions: 'PASS' }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /mongodb expiry.*exceeds.*1000/);
  assert.doesNotMatch(child.stdout, /PASS/);
});
