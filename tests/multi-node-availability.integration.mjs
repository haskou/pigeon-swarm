import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { createTwoNodeFixture, startTwoNodeNetwork } from "./two-node-fixture.mjs";

// Two real nodes and the real independent client in Chromium. The client must
// be built with both test gateways as mailbox availability servers; see
// docs/MULTI_NODE_AVAILABILITY_VALIDATION.md for the build and what this
// proves. The browser half is tests/multi-node-availability-browser.mjs.
test(
  "a direct inbox stays readable through its availability server when the home node dies, and not by a revoked device",
  { timeout: 600000 },
  async () => {
    assert.match(
      process.env.PIGEON_TEST_IMAGE || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
      "Set PIGEON_TEST_IMAGE to an immutable published digest or local image ID",
    );
    const clientDist = process.env.PIGEON_AVAILABILITY_CLIENT_DIST || "";
    assert.ok(
      isAbsolute(clientDist) && existsSync(join(clientDist, "index.html")),
      "Set PIGEON_AVAILABILITY_CLIENT_DIST to the absolute path of a client build with mailbox availability servers",
    );
    console.log(`Application image: ${process.env.PIGEON_TEST_IMAGE}`);
    const fixture = createTwoNodeFixture({
      composeFiles: [resolve("tests/compose.two-node-call.yml")],
      projectPrefix: "pigeon-availability",
      deadlineMs: 540000,
      extraEnv: { PIGEON_INDEPENDENT_CLIENT: "true", PIGEON_CLIENT_DIST: clientDist },
    });
    let failure;
    try {
      const { network } = await startTwoNodeNetwork(fixture);
      let killing;
      const result = await fixture.run(
        [
          "exec",
          "-T",
          "-e",
          `PIGEON_TEST_NETWORK_ID=${network.id}`,
          "browser",
          "node",
          "/opt/pigeon/tests/multi-node-availability-browser.mjs",
        ],
        {
          timeout: 420000,
          progress: true,
          keepStdin: true,
          // The browser script prints the marker once every device is set up
          // and waits on stdin; node A, Alice's home, is then killed outright.
          onStdout: (stdout, child) => {
            if (killing || !stdout.includes("STOP-HOME-NODE")) return;
            killing = fixture.run(["kill", "app-a"]).then(async (kill) => {
              const state = await fixture.run(["ps", "--all", "--format", "{{.State}}", "app-a"]);
              const killed = kill.status === 0 && state.stdout.trim() === "exited";
              child.stdin.end(killed ? "killed\n" : "kill failed\n");
              return killed;
            });
          },
        },
      );
      assert.equal(result.status, 0, result.stderr.slice(-3000));
      assert.ok(killing && (await killing), "Node A was not killed during the run");
      assert.match(result.stdout, /PASS multi-node availability/);
    } catch (error) {
      failure = error;
    }
    await fixture.remove(failure);
  },
);
