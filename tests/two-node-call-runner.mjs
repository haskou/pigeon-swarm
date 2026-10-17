import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { createCallTestCredentials } from "./call-test-https-proxy.mjs";
import { verifyNatTraffic } from "./call-test-nat-network.mjs";
import { canaryForms, matchedForms } from "./canary-scan.mjs";
import { createTwoNodeFixture, restartNode, startTwoNodeNetwork } from "./two-node-fixture.mjs";

export function testTwoNodeCalls({ nat = false } = {}) {
  test(
    nat ? "two NAT-separated nodes preserve UI messaging, voice and sessions" : "two application nodes preserve messaging, voice, session and restored-copy workflows",
    { timeout: 600000 },
    async () => {
      assert.match(
        process.env.PIGEON_TEST_IMAGE || "",
        /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
        "Set PIGEON_TEST_IMAGE to an immutable published digest or local image ID",
      );
      console.log(`Application image: ${process.env.PIGEON_TEST_IMAGE}`);
      const canary = `pigeon-canary-${randomBytes(16).toString("hex")}`;
      const forms = canaryForms(canary);
      const canaryScanner = resolve("tests/canary-scan.mjs");
      const gatewayCredentials = nat ? createCallTestCredentials() : undefined;
      const fixture = createTwoNodeFixture({
        composeFiles: [resolve("tests/compose.two-node-call.yml"), ...(nat ? [resolve("tests/compose.two-node-nat-call.yml")] : [])],
        projectPrefix: "pigeon-call",
        deadlineMs: 540000,
        nat,
        extraEnv: gatewayCredentials
          ? {
              PIGEON_TEST_TLS_KEY: gatewayCredentials.key.toString(),
              PIGEON_TEST_TLS_CERT: gatewayCredentials.cert.toString(),
            }
          : {},
      });
      const { env, run, compose, startedPeerId } = fixture;
      const caller = "caller-1";
      const identitySnapshot = async (service) => {
        const result = await run(["exec", "-T", service, "node", "--input-type=module"], {
          input: `
            const get = async (path) => {
              const response = await fetch('http://127.0.0.1:8080/api/' + path, { signal: AbortSignal.timeout(5000) });
              if (!response.ok) throw new Error('Snapshot request failed with status ' + response.status);
              return response.json();
            };
            const identity = await get('identities/${caller}');
            const { networks } = await get('node/networks');
            console.log(JSON.stringify({
              identity: { id: identity.id, handle: identity.profile?.handle, networks: [...identity.networks].sort() },
              nodeNetworks: networks.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
            }));
          `,
        });
        assert.equal(result.status, 0, `Identity snapshot failed for ${service}`);
        return JSON.parse(result.stdout.trim());
      };
      let failure;
      try {
        if (nat) {
          assert.notEqual(env.PIGEON_INDEPENDENT_CLIENT, "true", "NAT suite currently exercises the bundled client");
          await compose("build", "router-a", "router-b");
          await compose("up", "-d", "--wait", "router-a", "router-b");
        }
        const { network, peers } = await startTwoNodeNetwork(fixture, { companions: ["turn-a", "turn-b"] });
        if (nat) await compose("up", "-d", "--wait", "--wait-timeout", "60", "browser-a", "browser-b");
        let restarting;
        const result = await run(
          [
            "exec",
            "-T",
            "-e",
            `PIGEON_TEST_NAT=${nat}`,
            "-e",
            `TEST_IP_A=${env.TEST_IP_A}`,
            "-e",
            `TEST_IP_B=${env.TEST_IP_B}`,
            "-e",
            `PIGEON_TEST_CANARY=${canary}`,
            "-e",
            `PIGEON_TEST_NETWORK_ID=${network.id}`,
            "browser",
            "node",
            "/opt/pigeon/tests/two-node-call-browser.mjs",
          ],
          {
            timeout: 360000,
            progress: true,
            keepStdin: true,
            // During the direct call the browser script prints the marker and
            // waits on stdin; the callee's node is then restarted for real.
            onStdout: (stdout, child) => {
              if (restarting || !stdout.includes("RESTART-CALLEE-NODE")) return;
              restarting = restartNode(fixture, "b", { network, peers }).then(
                () => {
                  child.stdin.write("restarted\n");
                },
                (error) => {
                  child.stdin.write("restart failed\n");
                  return error;
                },
              );
            },
          },
        );
        const restartError = await restarting;
        if (restartError) throw restartError;
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /PASS two-node call/);
        if (!nat) assert.ok(restarting, "The callee's node was not restarted during the call");
        if (nat) await verifyNatTraffic(compose);
        const before = nat ? undefined : await identitySnapshot("app-a");
        if (!nat) {
          assert.equal(before.identity.handle, caller);
          assert.ok(before.identity.id, "Caller identity must have an ID before the copy");
          assert.ok(
            before.nodeNetworks.some((entry) => entry.id === network.id),
            "Node must list the private network before the copy",
          );
        }
        await compose("stop", "app-a", "app-b");
        const services = nat ? ["app-a", "app-b"] : ["app-a", "app-b", "app-restored"];
        if (!nat) {
          await compose("run", "-T", "--rm", "--no-deps", "restore-copy");
          await compose("up", "-d", "--wait", "--wait-timeout", "90", "app-restored");
          assert.deepEqual(await identitySnapshot("app-restored"), before, "Restored node must keep the caller identity and node networks");
          assert.equal(await startedPeerId("app-restored"), peers[0].id, "Restored node must keep its private network peer ID");
          await compose("restart", "app-restored");
          await compose("up", "-d", "--wait", "--wait-timeout", "90", "app-restored");
          assert.deepEqual(await identitySnapshot("app-restored"), before, "Restored node must keep the caller identity and node networks after restart");
          assert.equal(await startedPeerId("app-restored"), peers[0].id, "Restored node must keep its private network peer ID after restart");
          await compose("stop", "app-restored");
        }
        for (const service of services) {
          const id = await compose("ps", "-a", "-q", service);
          const scan = await run(
            [
              "run",
              "--rm",
              "--entrypoint",
              "node",
              "-e",
              `PIGEON_TEST_CANARY=${canary}`,
              "-v",
              `${canaryScanner}:/tmp/canary-scan.mjs:ro`,
              "--volumes-from",
              id,
              process.env.PIGEON_TEST_IMAGE,
              "/tmp/canary-scan.mjs",
              "/data",
            ],
            { raw: true },
          );
          assert.equal(scan.status, 0, `Canary storage scan failed for ${service}: ${scan.stderr.trim().split("\n").slice(-6).join(" | ").slice(0, 800)}`);
          const counts = JSON.parse(scan.stdout.trim().split("\n").at(-1));
          assert.equal(counts.control.files, forms.size, `Negative controls were not all planted for ${service}`);
          assert.equal(counts.control.matchingFiles, forms.size, `Planted control detected for only ${counts.control.forms.length} of ${forms.size} encodings in ${service}`);
          assert.ok(counts.data.files > 0, `No application data was scanned for ${service}`);
          assert.equal(counts.data.matchingFiles, 0, `Plaintext canary found in ${service} application data as ${counts.data.forms.join(", ")}`);
          const logs = await run(["logs", "--no-color", service]);
          const logLeaks = matchedForms(Buffer.from(logs.stdout + logs.stderr), forms);
          assert.deepEqual(logLeaks, [], `Plaintext canary found in ${service} logs as ${logLeaks.join(", ")}`);
        }
      } catch (error) {
        failure = error;
      }
      await fixture.remove(failure, ["restore"]);
    },
  );
}
