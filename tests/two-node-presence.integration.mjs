import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { createTwoNodeFixture, startTwoNodeNetwork } from "./two-node-fixture.mjs";

// Two real nodes and the real independent client in Chromium: a contact whose
// home is another node sees the shared status. See
// docs/TWO_NODE_PRESENCE_VALIDATION.md for what this proves. The browser half
// is tests/two-node-presence-browser.mjs.
test(
  "contacts on different nodes see each other's shared status, and an invisible contact as offline",
  { timeout: 900000 },
  async () => {
    assert.match(
      process.env.PIGEON_TEST_IMAGE || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
      "Set PIGEON_TEST_IMAGE to an immutable published digest or local image ID",
    );
    const clientDist = process.env.PIGEON_CLIENT_DIST || "";
    assert.ok(
      isAbsolute(clientDist) && existsSync(join(clientDist, "index.html")),
      "Set PIGEON_CLIENT_DIST to the absolute path of an independent client build",
    );
    console.log(`Application image: ${process.env.PIGEON_TEST_IMAGE}`);
    const fixture = createTwoNodeFixture({
      composeFiles: [resolve("tests/compose.two-node-call.yml")],
      projectPrefix: "pigeon-presence",
      deadlineMs: 840000,
      extraEnv: { PIGEON_INDEPENDENT_CLIENT: "true", PIGEON_CLIENT_DIST: clientDist },
    });
    let failure;
    try {
      const { network } = await startTwoNodeNetwork(fixture);
      const result = await fixture.run(
        [
          "exec",
          "-T",
          "-e",
          `PIGEON_TEST_NETWORK_ID=${network.id}`,
          "browser",
          "node",
          "/opt/pigeon/tests/two-node-presence-browser.mjs",
        ],
        { timeout: 720000, progress: true },
      );
      assert.equal(result.status, 0, result.stderr.slice(-3000));
      assert.match(result.stdout, /PASS two-node contact presence/);
    } catch (error) {
      failure = error;
    }
    await fixture.remove(failure);
  },
);
