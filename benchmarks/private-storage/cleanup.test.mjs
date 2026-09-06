import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finishBenchmark } from "./cleanup.mjs";

test("database cleanup failures do not leak files or replace the original error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigeon-cleanup-test-"));
  const original = new Error("benchmark connection lost");
  const closeFailure = new Error("level close failed");
  const dropFailure = new Error("mongodb drop failed");
  let mongoClosed = false;
  await writeFile(join(root, "level.data"), "synthetic data");
  try {
    await assert.rejects(
      finishBenchmark(
        [
          async () => {
            throw closeFailure;
          },
          async () => {
            throw dropFailure;
          },
          async () => {
            mongoClosed = true;
          },
          () => rm(root, { recursive: true, force: true }),
        ],
        [original],
      ),
      (error) => {
        assert.equal(error.cause, original);
        assert.deepEqual(error.errors, [original, closeFailure, dropFailure]);
        return true;
      },
    );
    assert.equal(mongoClosed, true);
    await assert.rejects(stat(root), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a benchmark failure when cleanup succeeds", async () => {
  const original = new Error("budget exceeded");
  await assert.rejects(
    finishBenchmark([async () => {}], [original]),
    (error) => error === original,
  );
});

test("a cleanup-only failure prevents successful completion", async () => {
  const failure = new Error("filesystem cleanup failed");
  await assert.rejects(
    finishBenchmark([
      async () => {
        throw failure;
      },
    ]),
    (error) => error === failure,
  );
  await assert.doesNotReject(finishBenchmark([async () => {}]));
});
