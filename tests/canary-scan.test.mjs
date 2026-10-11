import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canaryForms, matchedForms, scanTree, scanVolume } from "./canary-scan.mjs";

const canary = `pigeon-canary-${randomBytes(16).toString("hex")}`;
const forms = canaryForms(canary);

test("the scanner covers every documented encoding", () => {
  assert.deepEqual(
    [...forms.keys()],
    [
      "raw",
      "hex",
      "hex-upper",
      "json-escaped",
      "utf16le",
      "utf16be",
      "base64+0",
      "base64+1",
      "base64+2",
      "base64url+0",
      "base64url+1",
      "base64url+2",
    ],
  );
});

test("each canary form is detected in a file holding only that form", () => {
  for (const [name, needle] of forms) {
    const file = Buffer.concat([Buffer.from("\n"), needle, Buffer.from("\n")]);
    assert.ok(matchedForms(file, forms).includes(name), `form ${name} was not detected`);
  }
});

test("base64 copies are detected at the byte alignment they have in a larger stream", () => {
  for (let prefixLength = 0; prefixLength < 6; prefixLength++) {
    for (const alphabet of ["base64", "base64url"]) {
      const stream = Buffer.concat([randomBytes(prefixLength), Buffer.from(canary), randomBytes(7)]);
      // The canary's first whole base64 group starts at this offset within the canary.
      const offset = (3 - (prefixLength % 3)) % 3;
      const encoded = Buffer.from(stream.toString(alphabet));
      assert.ok(
        matchedForms(encoded, forms).includes(`${alphabet}+${offset}`),
        `${alphabet} copy after ${prefixLength} prefix bytes was not detected`,
      );
    }
  }
});

test("UTF-16 and JSON-escaped copies are detected", () => {
  const utf16be = Buffer.from(canary, "utf16le").swap16();
  const escaped = Buffer.from(
    [...canary].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  );
  assert.deepEqual(matchedForms(utf16be, forms), ["utf16be"]);
  assert.deepEqual(matchedForms(escaped, forms), ["json-escaped"]);
});

test("unrelated bytes and another canary are not reported", () => {
  const other = canaryForms(`pigeon-canary-${randomBytes(16).toString("hex")}`);
  assert.deepEqual(matchedForms(randomBytes(8192), forms), []);
  for (const [, needle] of other) assert.deepEqual(matchedForms(needle, forms), []);
});

test("scanTree reports matching files and does not follow symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-scan-test-"));
  const outside = mkdtempSync(join(tmpdir(), "canary-outside-test-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "wide.bin"), forms.get("utf16be"));
    writeFileSync(join(root, "clean.bin"), randomBytes(256));
    writeFileSync(join(outside, "secret.bin"), canary);
    symlinkSync(join(outside, "secret.bin"), join(root, "link.bin"));
    assert.deepEqual(scanTree(root, forms), { files: 2, matchingFiles: 1, forms: ["utf16be"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("scanVolume detects every planted control form and scans the data volume", () => {
  const root = mkdtempSync(join(tmpdir(), "canary-volume-test-"));
  try {
    writeFileSync(join(root, "clean.bin"), randomBytes(64));
    const result = scanVolume(root, canary);
    assert.equal(result.control.files, forms.size);
    assert.equal(result.control.matchingFiles, forms.size);
    assert.deepEqual(result.data, { files: 1, matchingFiles: 0, forms: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
