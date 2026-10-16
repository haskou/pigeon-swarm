#!/usr/bin/env node
// Prints the sources the publish workflow builds, as KEY=value lines for
// $GITHUB_ENV: the node and UI pins in validate.yml at the checked-out wrapper
// commit, and that commit. Only this pair was validated, so nothing else may be
// published (docs/DOCKER_IMAGE.md, Publishing).
//
//   node scripts/publish-sources.mjs --wrapper <full wrapper commit SHA>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fullSha = /^[0-9a-f]{40}$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const { values } = parseArgs({ options: { wrapper: { type: "string" } } });
if (!fullSha.test(values.wrapper ?? "")) fail("--wrapper must be a full 40-character commit SHA");

const workflow = readFileSync(resolve(root, ".github/workflows/validate.yml"), "utf8");
const pin = (variable) => {
  // Any declaration counts, so a job-level override in validate.yml cannot make
  // validation test a different pair than the one published.
  const declaration = new RegExp(`^([ \\t-]*)["']?${variable}["']?[ \\t]*:[ \\t]*(\\S*)`, "gm");
  const declarations = [...workflow.matchAll(declaration)];
  if (declarations.length !== 1 || declarations[0][1] !== "  ") {
    fail(`validate.yml must declare ${variable} exactly once, in the top-level env`);
  }
  const value = declarations[0][2];
  if (!fullSha.test(value)) fail(`validate.yml ${variable} must be a full 40-character commit SHA`);
  return value;
};

const node = pin("PIGEON_SWARM_NODE_SHA");
const ui = pin("PIGEON_SWARM_UI_SHA");

process.stdout.write(
  [
    `PIGEON_SWARM_NODE_SHA=${node}`,
    `PIGEON_SWARM_UI_SHA=${ui}`,
    `WRAPPER_SHA=${values.wrapper}`,
    `WRAPPER_SHORT_SHA=${values.wrapper.slice(0, 7)}`,
  ].join("\n") + "\n",
);
