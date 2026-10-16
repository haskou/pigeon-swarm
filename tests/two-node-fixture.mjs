import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isIPv4 } from "node:net";
import { prepareNatNetwork } from "./call-test-nat-network.mjs";

const PASSED_ENV = [
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
];
const NETWORK_NAME = "Private call integration";
const STARTED = /Started private network with Peer ID: ([A-Za-z0-9]+)/g;

/**
 * A disposable Compose project of two application nodes (`app-a`, `app-b`) and
 * a `browser` container on an internal network. `run` runs `docker compose`
 * (or plain `docker` with `raw`) under the project, bounded by the deadline;
 * `compose` asserts success and returns stdout. Secrets in `env` never reach
 * the logs: a failed `compose` reports its stderr only in NAT runs, redacted.
 */
export function createTwoNodeFixture({ composeFiles, projectPrefix, deadlineMs, nat = false, extraEnv = {} }) {
  const env = {
    ...Object.fromEntries(PASSED_ENV.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    COMPOSE_FILE: composeFiles.join(":"),
    COMPOSE_PROJECT_NAME: `${projectPrefix}-${randomBytes(5).toString("hex")}`,
    COMPOSE_ENV_FILES: "/dev/null",
    CALLS_TURN_SHARED_SECRET: randomBytes(32).toString("hex"),
    TEST_SECRET_A: randomBytes(32).toString("hex"),
    TEST_SECRET_B: randomBytes(32).toString("hex"),
    TEST_IP_A: "",
    TEST_IP_B: "",
    TEST_PRIVATE_IP_A: "",
    TEST_PRIVATE_IP_B: "",
    CALLS_TURN_EXTERNAL_IP: "",
    CALLS_TURN_USER_QUOTA: "16",
    CALLS_TURN_TOTAL_QUOTA: "128",
    ...extraEnv,
  };
  const deadline = Date.now() + deadlineMs;
  const run = (args, options = {}) =>
    new Promise((resolve) => {
      const child = spawn("docker", [...(options.raw ? [] : ["compose"]), ...args], {
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
        options.onStdout?.(stdout, child);
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
      if (options.keepStdin) child.stdin.write(options.input ?? "");
      else child.stdin.end(options.input);
    });
  const compose = async (...args) => {
    const result = await run(args);
    if (nat && result.status !== 0) {
      // Fixture command errors only, never application logs or Compose config.
      let diagnostic = result.stderr;
      for (const name of ["CALLS_TURN_SHARED_SECRET", "TEST_SECRET_A", "TEST_SECRET_B"])
        diagnostic = diagnostic.replaceAll(env[name], "[redacted]");
      console.error(diagnostic.slice(-3000));
    }
    assert.equal(
      result.status,
      0,
      `Compose ${args[0]} failed; configuration output withheld`,
    );
    return result.stdout.trim();
  };
  const startedPeerId = async (service) => {
    let peerId;
    for (let attempt = 0; attempt < 20 && !peerId; attempt++) {
      const logs = await run(["logs", "--no-color", service]);
      peerId = [...(logs.stdout + logs.stderr).matchAll(STARTED)].at(-1)?.[1];
      if (!peerId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return peerId;
  };
  const remove = async (failure, profiles = []) => {
    const cleanup = await run([...profiles.flatMap((profile) => ["--profile", profile]), "down", "--volumes", "--remove-orphans"], {
      cleanup: true,
    });
    if (cleanup.status !== 0)
      throw new AggregateError(
        [
          ...(failure ? [failure] : []),
          new Error(`Cleanup failed for disposable project ${env.COMPOSE_PROJECT_NAME}`),
        ],
        "Disposable two-node test cleanup failed",
      );
    if (failure) throw failure;
  };
  return { env, run, compose, startedPeerId, remove, nat };
}

/**
 * Starts both nodes and the browser container, registers one private network
 * on each node, bootstraps each node to the other over libp2p, restarts them
 * one at a time, then waits until each node reports the network converged
 * with the other node connected. `companions` start after the restart, before
 * the convergence wait. Returns the network and each node's peer ID and port.
 */
export async function startTwoNodeNetwork(fixture, { companions = [] } = {}) {
  const { env, run, compose, nat } = fixture;
  await compose("up", "-d", "--wait", "--wait-timeout", "90", "app-a", "app-b", "browser");
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
  env.TEST_PRIVATE_IP_A = env.TEST_IP_A;
  env.TEST_PRIVATE_IP_B = env.TEST_IP_B;
  if (nat) {
    env.TEST_IP_A = "203.0.113.11";
    env.TEST_IP_B = "203.0.113.12";
    await prepareNatNetwork(compose);
  }
  const network = {
    id: randomUUID(),
    name: NETWORK_NAME,
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
        match = (logs.stdout + logs.stderr).match(/Started private network with Peer ID: ([A-Za-z0-9]+)/);
        const privateRelayLine = (logs.stdout + logs.stderr)
          .split("\n")
          .find((line) => line.includes("Private IPFS relay server enabled: "));
        port = privateRelayLine?.match(/listenAddresses="\/ip4\/0\.0\.0\.0\/tcp\/(\d+)"/);
        if (match && port) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.ok(match, "Application must report its private network peer ID");
      assert.ok(port, "Application must report its assigned private network port");
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
    await compose("up", "-d", "--wait", "--wait-timeout", "90", `app-${name}`);
  }
  for (const name of ["a", "b"]) await assertNodeAddressSurvived(fixture, name);
  await compose("up", "-d", "--wait", "--wait-timeout", "90", "app-a", "app-b", ...companions);
  await Promise.all(["a", "b"].map((_, index) => awaitNetworkReady(fixture, network, peers, index)));
  return { network, peers };
}

/**
 * Restarts one node (`"a"` or `"b"`) of a running two-node network, then
 * requires the same Docker address and private network peer ID and waits until
 * both nodes report the network converged with each other connected again.
 */
export async function restartNode(fixture, name, { network, peers }) {
  await fixture.compose("restart", `app-${name}`);
  await fixture.compose("up", "-d", "--wait", "--wait-timeout", "90", `app-${name}`);
  await assertNodeAddressSurvived(fixture, name);
  await Promise.all(["a", "b"].map((_, index) => awaitNetworkReady(fixture, network, peers, index)));
}

async function assertNodeAddressSurvived({ env, compose }, name) {
  const address = await compose(
    "exec",
    "-T",
    `app-${name}`,
    "node",
    "-e",
    "console.log(Object.values(require('node:os').networkInterfaces()).flat().find(ip => ip.family === 'IPv4' && !ip.internal).address)",
  );
  assert.ok(
    address === env[`TEST_PRIVATE_IP_${name.toUpperCase()}`],
    "Fixture node address must survive restart",
  );
}

async function awaitNetworkReady({ run }, network, peers, index) {
  const name = ["a", "b"][index];
  const logs = await run(["logs", "--no-color", `app-${name}`]);
  const startedPeers = [...(logs.stdout + logs.stderr).matchAll(STARTED)];
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
  assert.equal(readiness.status, 0, readiness.stdout + readiness.stderr);
  console.log(`Node ${name}: ${readiness.stdout.trim()}`);
}
