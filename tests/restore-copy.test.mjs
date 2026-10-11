import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "restore-copy.sh");
const secret = "restore-test-secret-value";

const withTree = (callback) => {
  const root = mkdtempSync(join(tmpdir(), "restore-copy-"));
  try {
    const source = join(root, "local_storage");
    mkdirSync(join(source, "db"), { recursive: true });
    chmodSync(source, 0o700);
    writeFileSync(join(source, "turn-shared-secret"), `${secret}\n`, { mode: 0o600 });
    writeFileSync(join(source, "db", "000001.ldb"), "record", { mode: 0o640 });
    const target = join(root, "restored");
    mkdirSync(target, { mode: 0o700 });
    callback({ root, source, target });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const run = (...args) => spawnSync("/bin/sh", [script, ...args], { encoding: "utf8" });
const mode = (path) => statSync(path).mode & 0o777;

test("copies nested files with contents and permissions preserved", () => {
  withTree(({ source, target }) => {
    const result = run(source, target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(target, "turn-shared-secret"), "utf8"), `${secret}\n`);
    assert.equal(readFileSync(join(target, "db", "000001.ldb"), "utf8"), "record");
    assert.equal(mode(join(target, "turn-shared-secret")), 0o600);
    assert.equal(mode(join(target, "db", "000001.ldb")), 0o640);
    assert.equal(mode(join(target, "db")), mode(join(source, "db")));
    assert.deepEqual(readdirSync(target).sort(), readdirSync(source).sort());
  });
});

test("never prints file contents", () => {
  withTree(({ source, target }) => {
    const result = run(source, target);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  });
});

test("refuses a non-empty target and leaves it unchanged", () => {
  withTree(({ source, target }) => {
    writeFileSync(join(target, "existing"), "keep", { mode: 0o600 });
    const result = run(source, target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target must be empty/);
    assert.deepEqual(readdirSync(target), ["existing"]);
    assert.equal(readFileSync(join(target, "existing"), "utf8"), "keep");
  });
});

test("refuses a target inside the source", () => {
  withTree(({ source }) => {
    const nested = join(source, "backup");
    mkdirSync(nested);
    const result = run(source, nested);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /target must not be inside source/);
    assert.deepEqual(readdirSync(source).sort(), ["backup", "db", "turn-shared-secret"]);
  });
});

test("refuses a missing source or missing target without creating either", () => {
  withTree(({ root, source, target }) => {
    const missing = join(root, "missing");
    const missingSource = run(missing, target);
    assert.equal(missingSource.status, 1);
    assert.match(missingSource.stderr, /source is not a directory/);
    const missingTarget = run(source, missing);
    assert.equal(missingTarget.status, 1);
    assert.match(missingTarget.stderr, /target must be an existing directory/);
    assert.equal(statSync(source).isDirectory(), true);
    assert.throws(() => statSync(missing));
  });
});

test("requires exactly two arguments", () => {
  const result = run("only-one");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: restore-copy.sh/);
});

test("fails without success output when the copy is incomplete", () => {
  withTree(({ root, source, target }) => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const realCp = spawnSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).stdout.trim();
    const dropped = join(target, "turn-shared-secret");
    writeFileSync(join(bin, "cp"), `#!/bin/sh\n"${realCp}" "$@" || exit $?\nrm -f "${dropped}"\n`, { mode: 0o755 });
    const result = spawnSync("/bin/sh", [script, source, target], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("copied and verified"));
    assert.match(`${result.stdout}${result.stderr}`, /turn-shared-secret/);
  });
});
