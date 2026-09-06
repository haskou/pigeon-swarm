import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

test(
  "two application nodes preserve messaging, voice and session workflows",
  { timeout: 600000 },
  async () => {
    assert.match(
      process.env.PIGEON_TEST_IMAGE || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
      "Set PIGEON_TEST_IMAGE to an immutable published digest or local image ID",
    );
    console.log(`Application image: ${process.env.PIGEON_TEST_IMAGE}`);
    const env = {
      ...Object.fromEntries(
        [
          "PATH",
          "HOME",
          "USER",
          "TMPDIR",
          "DOCKER_HOST",
          "DOCKER_CONTEXT",
          "DOCKER_CONFIG",
          "DOCKER_TLS_VERIFY",
          "DOCKER_CERT_PATH",
          "PIGEON_TEST_IMAGE",
          "PIGEON_INDEPENDENT_CLIENT",
          "PIGEON_CLIENT_DIST",
        ]
          .filter((name) => process.env[name] !== undefined)
          .map((name) => [name, process.env[name]]),
      ),
      COMPOSE_FILE: resolve("tests/compose.two-node-call.yml"),
      COMPOSE_PROJECT_NAME: `pigeon-call-${randomBytes(5).toString("hex")}`,
      COMPOSE_ENV_FILES: "/dev/null",
      CALLS_TURN_SHARED_SECRET: randomBytes(32).toString("hex"),
      TEST_SECRET_A: randomBytes(32).toString("hex"),
      TEST_SECRET_B: randomBytes(32).toString("hex"),
      TEST_IP_A: "",
      TEST_IP_B: "",
      CALLS_TURN_EXTERNAL_IP: "",
      CALLS_TURN_USER_QUOTA: "16",
      CALLS_TURN_TOTAL_QUOTA: "128",
    };
    const deadline = Date.now() + 540000;
    const run = (args, options = {}) =>
      new Promise((resolve) => {
        const child = spawn("docker", ["compose", ...args], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        const timeout = options.cleanup
          ? 45000
          : Math.max(
              1,
              Math.min(options.timeout || 120000, deadline - Date.now()),
            );
        const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (options.progress) process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.stdin.on("error", () => {});
        child.once("error", () => {
          clearTimeout(timer);
          resolve({ status: -1, stdout, stderr: "Docker could not start" });
        });
        child.once("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
        child.stdin.end(options.input);
      });
    const compose = async (...args) => {
      const result = await run(args);
      assert.equal(
        result.status,
        0,
        `Compose ${args[0]} failed; configuration output withheld`,
      );
      return result.stdout.trim();
    };
    let failure;
    try {
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "90",
        "app-a",
        "app-b",
        "browser",
      );
      for (const name of ["a", "b"]) {
        env[`TEST_IP_${name.toUpperCase()}`] = await compose(
          "exec",
          "-T",
          `app-${name}`,
          "node",
          "-e",
          "console.log(Object.values(require('node:os').networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address)",
        );
        assert.ok(
          isIPv4(env[`TEST_IP_${name.toUpperCase()}`]),
          "Fixture requires an IPv4 address for each node",
        );
      }
      assert.notEqual(env.TEST_IP_A, env.TEST_IP_B);
      const network = {
        id: randomUUID(),
        name: "Private call integration",
        key: generateKeyPairSync("ed25519")
          .privateKey.export({ format: "pem", type: "pkcs8" })
          .toString(),
      };
      for (const name of ["a", "b"]) {
        const ip = env[`TEST_IP_${name.toUpperCase()}`];
        const result = await run(
          ["exec", "-T", `app-${name}`, "node", "--input-type=module"],
          {
            input: `
        for (const [path, method, body] of [
          ['node/relay-configuration/', 'PUT', {publicHost: ${JSON.stringify(ip)}, callsRelay: {port:4101}, privateRelay: {enabled:true,portStart:4102,portEnd:4133,publicationEnabled:false,discoveryEnabled:false},publicNetwork:{enabled:false},manualRelayMultiaddrs:[]}],
          ['node/networks/', 'POST', ${JSON.stringify(network)}]
        ]) {
          const response = await fetch('http://127.0.0.1:8080/api/' + path, {method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
          if (!response.ok) throw new Error('Fixture setup failed: ' + path + ' status ' + response.status);
        }
      `,
          },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      const peers = await Promise.all(
        ["a", "b"].map(async (name) => {
          let match, port;
          for (let attempt = 0; attempt < 20; attempt++) {
            const logs = await run(["logs", "--no-color", `app-${name}`]);
            match = (logs.stdout + logs.stderr).match(
              /Started private network "Private call integration" with Peer ID: ([A-Za-z0-9]+)/,
            );
            const privateRelayLine = (logs.stdout + logs.stderr)
              .split("\n")
              .find((line) =>
                line.includes(
                  `Private IPFS relay server enabled: networkId=${network.id} `,
                ),
              );
            port = privateRelayLine?.match(
              /listenAddresses="\/ip4\/0\.0\.0\.0\/tcp\/(\d+)"/,
            );
            if (match && port) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          assert.ok(
            match,
            "Application must report its private network peer ID",
          );
          assert.ok(
            port,
            "Application must report its assigned private network port",
          );
          return { id: match[1], port: Number(port[1]) };
        }),
      );
      for (const [index, name] of ["a", "b"].entries()) {
        const remoteIp = index === 0 ? env.TEST_IP_B : env.TEST_IP_A;
        const remote = `/ip4/${remoteIp}/tcp/${peers[1 - index].port}/p2p/${peers[1 - index].id}`;
        const localIp = index === 0 ? env.TEST_IP_A : env.TEST_IP_B;
        const result = await run(
          ["exec", "-T", `app-${name}`, "node", "--input-type=module"],
          {
            input: `
        const url = 'http://127.0.0.1:8080/api/node/relay-configuration/';
        const configuration = {publicHost:${JSON.stringify(localIp)},callsRelay:{port:4101},privateRelay:{enabled:true,portStart:4102,portEnd:4133,publicationEnabled:false,discoveryEnabled:false},publicNetwork:{enabled:false},manualRelayMultiaddrs:[${JSON.stringify(remote)}]};
        const response = await fetch(url, { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(configuration) });
        if (!response.ok) throw new Error('Manual bootstrap failed: ' + response.status);
      `,
          },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      for (const name of ["a", "b"]) {
        await compose("restart", `app-${name}`);
        await compose(
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "90",
          `app-${name}`,
        );
      }
      for (const name of ["a", "b"]) {
        const address = await compose(
          "exec",
          "-T",
          `app-${name}`,
          "node",
          "-e",
          "console.log(Object.values(require('node:os').networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address)",
        );
        assert.ok(
          address === env[`TEST_IP_${name.toUpperCase()}`],
          "Fixture node address must survive restart",
        );
      }
      await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "90",
        "app-a",
        "app-b",
        "turn-a",
        "turn-b",
      );
      await Promise.all(
        ["a", "b"].map(async (name, index) => {
          const logs = await run(["logs", "--no-color", `app-${name}`]);
          const startedPeers = [
            ...(logs.stdout + logs.stderr).matchAll(
              /Started private network "Private call integration" with Peer ID: ([A-Za-z0-9]+)/g,
            ),
          ];
          assert.ok(
            startedPeers.at(-1)?.[1] === peers[index].id,
            "Private network peer identity must survive restart",
          );
          const readiness = await run(
            ["exec", "-T", `app-${name}`, "node", "--input-type=module"],
            {
              timeout: 70000,
              input: `
          const deadline = Date.now() + 60000;
          let summary;
          while (Date.now() < deadline) {
            const response = await fetch('http://127.0.0.1:8080/api/peers/', {signal:AbortSignal.timeout(5000)});
            const peers = await response.json();
            const network = peers.networkSynchronization?.networks?.find(network => network.id === ${JSON.stringify(network.id)});
            summary = {state:network?.state,connected:network?.connectedPeerIds?.length,replicating:network?.replicationPeerIds?.length,stores:network?.totalStoreCount,converged:network?.convergedStoreCount};
            if (network?.connectedPeerIds?.includes(${JSON.stringify(peers[1 - index].id)}) && network.totalStoreCount > 0 && network.state === 'converged') {
              console.log('Private network ready: ' + JSON.stringify(summary));
              process.exit(0);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          console.error('Private network readiness failed: ' + JSON.stringify(summary));
          process.exitCode = 1;
        `,
            },
          );
          assert.equal(
            readiness.status,
            0,
            readiness.stdout + readiness.stderr,
          );
          console.log(`Node ${name}: ${readiness.stdout.trim()}`);
        }),
      );
      const result = await run(
        [
          "exec",
          "-T",
          "-e",
          `TEST_IP_A=${env.TEST_IP_A}`,
          "-e",
          `TEST_IP_B=${env.TEST_IP_B}`,
          "browser",
          "node",
          "/opt/pigeon/tests/two-node-call-browser.mjs",
        ],
        { timeout: 300000, progress: true },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /PASS two-node call/);
    } catch (error) {
      failure = error;
    } finally {
      const cleanup = await run(["down", "--volumes", "--remove-orphans"], {
        cleanup: true,
      });
      if (cleanup.status !== 0)
        throw new AggregateError(
          [
            ...(failure ? [failure] : []),
            new Error(
              `Cleanup failed for disposable project ${env.COMPOSE_PROJECT_NAME}`,
            ),
          ],
          "Disposable call test cleanup failed",
        );
    }
    if (failure) throw failure;
  },
);
