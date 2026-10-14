#!/usr/bin/env node
// Moves the node and UI pins in every file that records them. Run it on the one
// open pin-bump branch, as described in docs/DOCKER_IMAGE.md (Pin bumps).
//
//   node scripts/bump-pins.mjs [--node <branch|sha>] [--ui <branch|sha>]
//
// Both default to main. A full 40-character SHA is used as given; a branch name
// is resolved with git ls-remote. Nothing is written unless every file records
// the current workflow pin.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = ".github/workflows/validate.yml";
const pinFiles = [workflowPath, "docs/RELEASE_VERIFICATION.md"];
const sources = [
  { option: "node", variable: "PIGEON_SWARM_NODE_SHA", repository: "https://github.com/haskou/pigeon-swarm-node" },
  { option: "ui", variable: "PIGEON_SWARM_UI_SHA", repository: "https://github.com/haskou/pigeon-swarm-ui" },
];
const fullSha = /^[0-9a-f]{40}$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const resolveCommit = (repository, ref) => {
  if (fullSha.test(ref)) return ref;
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    fail(`${ref} looks like an abbreviated commit; pass the full 40-character commit SHA`);
  }
  let listing;
  try {
    listing = execFileSync("git", ["ls-remote", "--exit-code", `${repository}.git`, `refs/heads/${ref}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail(`cannot resolve branch ${ref} in ${repository}`);
  }
  const commit = listing.split("\t")[0];
  if (!fullSha.test(commit)) fail(`unexpected git ls-remote output for ${ref} in ${repository}`);
  return commit;
};

const { values } = parseArgs({
  options: {
    node: { type: "string", default: "main" },
    ui: { type: "string", default: "main" },
  },
});

const contents = new Map(pinFiles.map((path) => [path, readFileSync(resolve(root, path), "utf8")]));
const changed = new Set();
const report = [];

for (const { option, variable, repository } of sources) {
  const target = resolveCommit(repository, values[option]);
  const current = contents.get(workflowPath).match(new RegExp(`^ {2}${variable}: ([0-9a-f]{40})$`, "m"))?.[1];
  if (!current) fail(`${workflowPath} does not define ${variable}`);
  if (current === target) {
    report.push(`${variable} ${current} unchanged`);
    continue;
  }
  for (const path of pinFiles) {
    const content = contents.get(path);
    if (!content.includes(current)) fail(`${path} does not record ${variable} ${current}; fix that drift first`);
    contents.set(path, content.replaceAll(current, target));
    changed.add(path);
  }
  report.push(`${variable} ${current} -> ${target}: ${repository}/compare/${current}...${target}`);
}

for (const path of changed) writeFileSync(resolve(root, path), contents.get(path));
console.log(report.join("\n"));
