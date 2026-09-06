export async function finishBenchmark(steps, failures = []) {
  const errors = [...failures];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Benchmark and resource cleanup failed", {
      cause: errors[0],
    });
  }
}
