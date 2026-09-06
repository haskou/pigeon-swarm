import assert from 'node:assert/strict';

const budgets = {
  writes: { metric: 'p95Ms', maximumMs: 250 },
  reads: { metric: 'p95Ms', maximumMs: 100 },
  pages: { metric: 'p95Ms', maximumMs: 100 },
  expiry: { metric: 'totalMs', maximumMs: 1000 },
};

export function assertWithinBudgets(measurements) {
  for (const engine of ['level', 'mongodb']) {
    for (const [operation, { metric, maximumMs }] of Object.entries(budgets)) {
      const measuredMs = measurements[engine]?.[operation]?.[metric];
      assert.ok(
        Number.isFinite(measuredMs) && measuredMs >= 0,
        `${engine} ${operation} ${metric} is invalid: ${measuredMs}`,
      );
      assert.ok(
        measuredMs <= maximumMs,
        `${engine} ${operation} ${metric} ${measuredMs} ms exceeds ${maximumMs} ms budget`,
      );
    }
  }
}
