import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Keeps docs/RELEASE_VERIFICATION.md in step with the pins, npm scripts and
// CI test steps it describes. Uses only Node built-ins so it runs before npm ci.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const doc = read("docs/RELEASE_VERIFICATION.md");
const workflow = read(".github/workflows/validate.yml");
const scripts = JSON.parse(read("package.json")).scripts;

const workflowPins = Object.fromEntries(
  [...workflow.matchAll(/^ {2}(PIGEON_SWARM_(?:NODE|UI)_SHA): ([0-9a-f]{40})$/gm)].map(
    (match) => [match[1], match[2]],
  ),
);

const workflowSteps = () => {
  const lines = workflow.split("\n");
  const steps = [];
  for (let index = 0; index < lines.length; index++) {
    const start = lines[index].match(/^ {6}- name: (.+)$/);
    if (!start) continue;
    const body = [];
    for (let next = index + 1; next < lines.length; next++) {
      if (/^ {6}- /.test(lines[next]) || /^ {0,4}\S/.test(lines[next])) break;
      body.push(lines[next]);
    }
    steps.push({ name: start[1].trim(), run: body.join("\n") });
  }
  return steps;
};

const isTestStep = (step) =>
  /node --test |npm run test:/.test(step.run);

const matrixRows = doc
  .split("\n")
  .filter((line) => /^\| M\d{2} \|/.test(line))
  .map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return {
      id: cells[0],
      ciStep: cells[4].replace(/^`|`$/g, ""),
      status: cells[6],
      cellCount: cells.length,
    };
  });

test("documented pins equal the pins the workflow builds", () => {
  const documented = Object.fromEntries(
    [...doc.matchAll(/`(PIGEON_SWARM_(?:NODE|UI)_SHA)` \| `([0-9a-f]{40})`/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  assert.deepEqual(documented, workflowPins);
});

test("every matrix row has seven cells, a known status and a real CI step", () => {
  const steps = new Set(workflowSteps().map((step) => step.name));
  assert.ok(matrixRows.length > 0, "matrix must contain rows");
  for (const row of matrixRows) {
    assert.equal(row.cellCount, 7, `${row.id} must have seven cells`);
    assert.ok(
      ["Automated", "Partial", "Open"].includes(row.status),
      `${row.id} has unknown status ${row.status}`,
    );
    if (row.status === "Open") {
      assert.equal(row.ciStep, "—", `${row.id} is open, so it has no CI step`);
    } else {
      assert.ok(steps.has(row.ciStep), `${row.id} names missing CI step "${row.ciStep}"`);
    }
  }
});

test("every CI test step is documented exactly once in the matrix", () => {
  const counts = new Map();
  for (const row of matrixRows) counts.set(row.ciStep, (counts.get(row.ciStep) ?? 0) + 1);
  for (const step of workflowSteps().filter(isTestStep)) {
    assert.equal(
      counts.get(step.name),
      1,
      `CI test step "${step.name}" must have exactly one matrix row`,
    );
  }
});

test("npm test scripts used by CI exist and are documented", () => {
  const used = new Set(
    [...workflow.matchAll(/npm run (test:[A-Za-z0-9:_-]+)/g)].map((match) => match[1]),
  );
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(scripts[name], `CI runs missing npm script ${name}`);
    assert.ok(doc.includes(`npm run ${name}`), `docs omit npm run ${name}`);
  }
  for (const match of doc.matchAll(/npm run (test:[A-Za-z0-9:_-]+)/g)) {
    assert.ok(scripts[match[1]], `docs reference missing npm script ${match[1]}`);
  }
});

test("every repository path referenced by the matrix exists", () => {
  const paths = [
    ...doc.matchAll(/`((?:tests|docs|benchmarks|scripts|client|\.github)\/[^`\s]+)`/g),
    ...doc.matchAll(/\]\(((?:tests|docs|benchmarks|scripts|client|\.github)\/[^)\s]+)\)/g),
  ].map((match) => match[1].split("#")[0]);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    if (path.includes("*")) {
      const directory = path.slice(0, path.indexOf("*"));
      const parent = directory.slice(0, directory.lastIndexOf("/"));
      assert.ok(existsSync(resolve(root, parent)), `missing directory for ${path}`);
    } else {
      assert.ok(existsSync(resolve(root, path)), `missing path ${path}`);
    }
  }
});
