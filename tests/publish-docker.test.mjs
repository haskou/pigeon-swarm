import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The published image must contain exactly the node and UI pair that the
// wrapper validated: the pins in validate.yml at a wrapper commit whose
// Validate wrapper run on a push to main succeeded with every check.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishWorkflow = readFileSync(join(repository, ".github", "workflows", "publish-docker.yml"), "utf8");
const validatePath = join(".github", "workflows", "validate.yml");
const scriptPath = join("scripts", "publish-sources.mjs");
const classifyPath = join(repository, ".github", "actions", "classify-changes", "classify.sh");

const node = "1".repeat(40);
const ui = "2".repeat(40);
const wrapper = "abcdef0".padEnd(40, "9");

const validateFixture = (body) => `name: Validate wrapper\n\nenv:\n${body}\nconcurrency:\n  group: x\n`;

const runScript = (validateContent, ...args) => {
  const root = mkdtempSync(join(tmpdir(), "publish-sources-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    copyFileSync(join(repository, scriptPath), join(root, scriptPath));
    writeFileSync(join(root, validatePath), validateContent);
    return spawnSync(process.execPath, [join(root, scriptPath), ...args], { encoding: "utf8" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const triggers = publishWorkflow.slice(publishWorkflow.indexOf("\non:"), publishWorkflow.indexOf("\npermissions:"));

test("publishing runs only after Validate wrapper completes on main", () => {
  assert.match(triggers, /^ {2}workflow_run:\n {4}workflows:\n {6}- Validate wrapper\n {4}types:\n {6}- completed\n {4}branches:\n {6}- main\n/m);
  for (const trigger of ["push", "repository_dispatch", "workflow_dispatch", "pull_request"]) {
    assert.doesNotMatch(triggers, new RegExp(`^ {2}${trigger}:`, "m"), `${trigger} must not trigger publishing`);
  }
});

test("publishing refuses a validation run that failed or did not come from a push to this repository", () => {
  const condition = publishWorkflow.match(/^ {4}if: (.+)$/m)?.[1] ?? "";
  assert.match(condition, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(condition, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(condition, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(condition, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  // Dependabot pushes skip the image and browser checks in validate.yml.
  assert.match(condition, /github\.event\.workflow_run\.actor\.login != 'dependabot\[bot\]'/);
});

test("publishing refuses a validated commit that is no longer the tip of main", () => {
  // A tag named main reports head_branch main, and a re-run of an older main
  // run would publish an older pair over latest.
  const tipCheck = publishWorkflow.indexOf('gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha');
  assert.ok(tipCheck > 0, "publish-docker.yml must read the current main tip");
  assert.match(publishWorkflow, /if \[\[ "\$\{main_sha\}" != "\$\{VALIDATED_WRAPPER_SHA\}" \]\]; then\n.*\n {12}exit 1\n/);
  assert.ok(tipCheck < publishWorkflow.indexOf("node scripts/publish-sources.mjs"), "the tip check must run before sources resolve");
  assert.ok(tipCheck < publishWorkflow.indexOf("docker/build-push-action"), "the tip check must run before the image is pushed");
  // An older run must not cancel a newer publish.
  assert.match(publishWorkflow, /^concurrency:\n {2}group: publish-docker\n {2}cancel-in-progress: false$/m);
});

test("publishing builds the validated wrapper commit from its pinned sources only", () => {
  assert.match(publishWorkflow, /^ {10}ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}$/m);
  assert.match(publishWorkflow, /node scripts\/publish-sources\.mjs --wrapper "\$\{VALIDATED_WRAPPER_SHA\}" >> "\$\{GITHUB_ENV\}"/);
  for (const unvalidated of [
    "client_payload",
    "inputs.",
    "vars.PIGEON_SWARM",
    "PIGEON_SWARM_NODE_REF",
    "PIGEON_SWARM_UI_REF",
    "PIGEON_SWARM_NODE_REPOSITORY",
    "PIGEON_SWARM_UI_REPOSITORY",
    "ls-remote",
  ]) {
    assert.ok(!publishWorkflow.includes(unvalidated), `publish-docker.yml must not use ${unvalidated}`);
  }
  assert.match(publishWorkflow, /^ {12}PIGEON_SWARM_NODE_SHA=\$\{\{ env\.PIGEON_SWARM_NODE_SHA \}\}$/m);
  assert.match(publishWorkflow, /^ {12}PIGEON_SWARM_UI_SHA=\$\{\{ env\.PIGEON_SWARM_UI_SHA \}\}$/m);
});

test("published tags and revision label name the validated wrapper commit", () => {
  // type=sha and the default revision label follow the workflow's own commit,
  // which for workflow_run is the default-branch head, not the validated one.
  assert.doesNotMatch(publishWorkflow, /type=sha|type=ref/);
  assert.match(publishWorkflow, /type=raw,value=sha-\$\{\{ env\.WRAPPER_SHORT_SHA \}\}/);
  assert.match(publishWorkflow, /org\.opencontainers\.image\.revision=\$\{\{ env\.WRAPPER_SHA \}\}/);
});

test("publish-sources prints the validate.yml pins and the wrapper commit", () => {
  const result = runScript(
    validateFixture(`  PIGEON_SWARM_NODE_SHA: ${node}\n  PIGEON_SWARM_UI_SHA: ${ui}\n`),
    "--wrapper",
    wrapper,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `PIGEON_SWARM_NODE_SHA=${node}\nPIGEON_SWARM_UI_SHA=${ui}\nWRAPPER_SHA=${wrapper}\nWRAPPER_SHORT_SHA=abcdef0\n`,
  );
});

test("publish-sources refuses pins it cannot trust", () => {
  const cases = {
    "a missing pin": `  PIGEON_SWARM_NODE_SHA: ${node}\n`,
    "an abbreviated pin": `  PIGEON_SWARM_NODE_SHA: ${node}\n  PIGEON_SWARM_UI_SHA: 2222222\n`,
    "a branch name": `  PIGEON_SWARM_NODE_SHA: main\n  PIGEON_SWARM_UI_SHA: ${ui}\n`,
    "a pin declared twice": `  PIGEON_SWARM_NODE_SHA: ${node}\n  PIGEON_SWARM_NODE_SHA: ${"3".repeat(40)}\n  PIGEON_SWARM_UI_SHA: ${ui}\n`,
    "a job-level override": `  PIGEON_SWARM_NODE_SHA: ${node}\n  PIGEON_SWARM_UI_SHA: ${ui}\njobs:\n  validate:\n    env:\n      PIGEON_SWARM_UI_SHA: ${"3".repeat(40)}\n`,
    "a pin outside the top-level env": `  PIGEON_SWARM_NODE_SHA: ${node}\njobs:\n  validate:\n    env:\n      PIGEON_SWARM_UI_SHA: ${ui}\n`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const result = runScript(validateFixture(body), "--wrapper", wrapper);
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, "", name);
    assert.match(result.stderr, /PIGEON_SWARM_(NODE|UI)_SHA/, name);
  }
});

test("publish-sources refuses a wrapper commit that is not a full SHA", () => {
  const body = validateFixture(`  PIGEON_SWARM_NODE_SHA: ${node}\n  PIGEON_SWARM_UI_SHA: ${ui}\n`);
  for (const args of [[], ["--wrapper", "abcdef0"], ["--wrapper", "main"]]) {
    const result = runScript(body, ...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});

test("a documentation-only push to main still runs every check", () => {
  const root = mkdtempSync(join(tmpdir(), "classify-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    writeFileSync(join(root, "README.md"), "one\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "one");
    const before = git("rev-parse", "HEAD");
    writeFileSync(join(root, "README.md"), "two\n");
    git("commit", "-q", "-am", "two");
    const after = git("rev-parse", "HEAD");
    const classify = (ref) => {
      const output = join(root, `output-${ref.replaceAll("/", "-")}`);
      writeFileSync(output, "");
      const result = spawnSync("bash", [classifyPath], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EVENT_NAME: "push", PUSH_REF: ref, PUSH_BEFORE: before, PUSH_AFTER: after, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, "utf8");
    };
    assert.equal(classify("refs/heads/main"), "heavy=true\n");
    assert.equal(classify("refs/heads/docs-change"), "heavy=false\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
