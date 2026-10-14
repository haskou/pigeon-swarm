import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs scripts/bump-pins.mjs on a copy of the repository files it edits. Every
// case passes full commit SHAs, so no case needs the network.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(".github", "workflows", "validate.yml");
const docPath = join("docs", "RELEASE_VERIFICATION.md");

const oldNode = "1".repeat(40);
const oldUi = "2".repeat(40);
const newNode = "3".repeat(40);
const newUi = "4".repeat(40);

const fixtureWorkflow = `env:
  PIGEON_SWARM_NODE_SHA: ${oldNode}
  PIGEON_SWARM_UI_SHA: ${oldUi}
`;
const fixtureDoc = `| \`PIGEON_SWARM_NODE_SHA\` | \`${oldNode}\` |
| \`PIGEON_SWARM_UI_SHA\` | \`${oldUi}\` |

  --build-arg PIGEON_SWARM_NODE_SHA=${oldNode} \\
  --build-arg PIGEON_SWARM_UI_SHA=${oldUi} \\
`;

const withCopy = (files, callback) => {
  const root = mkdtempSync(join(tmpdir(), "bump-pins-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "docs"));
    copyFileSync(join(repository, "scripts", "bump-pins.mjs"), join(root, "scripts", "bump-pins.mjs"));
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    const read = (path) => readFileSync(join(root, path), "utf8");
    const run = (...args) =>
      spawnSync(process.execPath, [join(root, "scripts", "bump-pins.mjs"), ...args], {
        encoding: "utf8",
      });
    callback({ read, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const withFixture = (callback) =>
  withCopy({ [workflowPath]: fixtureWorkflow, [docPath]: fixtureDoc }, callback);

test("moves both pins in the workflow, the pin table and the reproduction command", () => {
  withFixture(({ read, run }) => {
    const result = run("--node", newNode, "--ui", newUi);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(workflowPath), fixtureWorkflow.replaceAll(oldNode, newNode).replaceAll(oldUi, newUi));
    assert.equal(read(docPath), fixtureDoc.replaceAll(oldNode, newNode).replaceAll(oldUi, newUi));
    assert.match(
      result.stdout,
      new RegExp(`https://github\\.com/haskou/pigeon-swarm-node/compare/${oldNode}\\.\\.\\.${newNode}`),
    );
    assert.match(
      result.stdout,
      new RegExp(`https://github\\.com/haskou/pigeon-swarm-ui/compare/${oldUi}\\.\\.\\.${newUi}`),
    );
  });
});

test("leaves a pin that is already current unchanged", () => {
  withFixture(({ read, run }) => {
    const result = run("--node", oldNode, "--ui", newUi);
    assert.equal(result.status, 0, result.stderr);
    assert.match(read(workflowPath), new RegExp(`PIGEON_SWARM_NODE_SHA: ${oldNode}`));
    assert.match(read(workflowPath), new RegExp(`PIGEON_SWARM_UI_SHA: ${newUi}`));
    assert.match(result.stdout, new RegExp(`PIGEON_SWARM_NODE_SHA ${oldNode} unchanged`));
  });
});

test("refuses an abbreviated commit without changing any file", () => {
  withFixture(({ read, run }) => {
    const result = run("--node", newNode.slice(0, 8), "--ui", newUi);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /full 40-character commit/);
    assert.equal(read(workflowPath), fixtureWorkflow);
    assert.equal(read(docPath), fixtureDoc);
  });
});

test("refuses a file that does not record the current pin without changing any file", () => {
  const driftedDoc = fixtureDoc.replaceAll(oldUi, "5".repeat(40));
  withCopy({ [workflowPath]: fixtureWorkflow, [docPath]: driftedDoc }, ({ read, run }) => {
    const result = run("--node", newNode, "--ui", newUi);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not record PIGEON_SWARM_UI_SHA/);
    assert.equal(read(workflowPath), fixtureWorkflow);
    assert.equal(read(docPath), driftedDoc);
  });
});

test("moves every recorded pin in the repository files", () => {
  const workflow = readFileSync(join(repository, workflowPath), "utf8");
  const doc = readFileSync(join(repository, docPath), "utf8");
  const pin = (name) => workflow.match(new RegExp(`^ {2}${name}: ([0-9a-f]{40})$`, "m"))[1];
  const currentNode = pin("PIGEON_SWARM_NODE_SHA");
  const currentUi = pin("PIGEON_SWARM_UI_SHA");
  withCopy({ [workflowPath]: workflow, [docPath]: doc }, ({ read, run }) => {
    const result = run("--node", newNode, "--ui", newUi);
    assert.equal(result.status, 0, result.stderr);
    for (const path of [workflowPath, docPath]) {
      const content = read(path);
      assert.ok(!content.includes(currentNode), `${path} still records the node pin`);
      assert.ok(!content.includes(currentUi), `${path} still records the UI pin`);
    }
    assert.match(read(docPath), new RegExp(`\`PIGEON_SWARM_NODE_SHA\` \\| \`${newNode}\``));
    assert.match(read(docPath), new RegExp(`--build-arg PIGEON_SWARM_UI_SHA=${newUi}`));
  });
});
