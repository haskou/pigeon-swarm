import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Byte forms under which a synthetic canary may be stored or logged. A match is
// reported by form name only; the canary itself is never printed.
export function canaryForms(canary) {
  const text = Buffer.from(canary, "utf8");
  const utf16le = Buffer.from(canary, "utf16le");
  const forms = new Map([
    ["raw", text],
    ["hex", Buffer.from(text.toString("hex"))],
    ["hex-upper", Buffer.from(text.toString("hex").toUpperCase())],
    [
      "json-escaped",
      Buffer.from(
        [...canary].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
      ),
    ],
    ["utf16le", utf16le],
    ["utf16be", Buffer.from(utf16le).swap16()],
  ]);
  // A base64 copy embedded in a larger encoded stream starts at one of three
  // byte offsets, so each offset contributes its own whole-group needle.
  for (const alphabet of ["base64", "base64url"]) {
    for (let offset = 0; offset < 3; offset++) {
      const length = 3 * Math.floor((text.length - offset) / 3);
      forms.set(
        `${alphabet}+${offset}`,
        Buffer.from(text.subarray(offset, offset + length).toString(alphabet)),
      );
    }
  }
  return forms;
}

export function matchedForms(bytes, forms) {
  return [...forms].filter(([, needle]) => bytes.includes(needle)).map(([name]) => name);
}

// Symbolic links are skipped so that a scan never follows them out of the volume.
export function scanTree(root, forms) {
  const scan = { files: 0, matchingFiles: 0, forms: new Set() };
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (!stat.isFile()) return;
    scan.files++;
    const matched = matchedForms(readFileSync(path), forms);
    if (matched.length > 0) scan.matchingFiles++;
    for (const name of matched) scan.forms.add(name);
  };
  walk(root);
  return { files: scan.files, matchingFiles: scan.matchingFiles, forms: [...scan.forms].sort() };
}

// Plants one control file per form and requires every form to be detected, so a
// scanner that misses an encoding fails before it can report a clean volume.
export function scanVolume(dataRoot, canary) {
  const forms = canaryForms(canary);
  const control = mkdtempSync(join(tmpdir(), "canary-control-"));
  try {
    for (const [name, needle] of forms) writeFileSync(join(control, name), needle);
    return { control: scanTree(control, forms), data: scanTree(dataRoot, forms) };
  } finally {
    rmSync(control, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(scanVolume(process.argv[2], process.env.PIGEON_TEST_CANARY)));
}
