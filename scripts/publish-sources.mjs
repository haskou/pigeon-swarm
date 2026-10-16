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
  const values = [...workflow.matchAll(new RegExp(`^ {2}${variable}: (\\S+)$`, "gm"))].map((match) => match[1]);
  if (values.length !== 1) fail(`validate.yml must declare ${variable} exactly once`);
  if (!fullSha.test(values[0])) fail(`validate.yml ${variable} must be a full 40-character commit SHA`);
  return values[0];
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
