import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

test(
  "application relays discover and recover without private bootstrap addresses",
  { timeout: 600000 },
  async () => {
    const image = process.env.PIGEON_TEST_IMAGE;
    assert.match(
      image || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
    );
    console.log(`Application image: ${image}`);
    const name = `pigeon-discovery-${randomBytes(5).toString("hex")}`;
    const containers = [];
    const deadline = Date.now() + 540000;
    const network = {
      id: randomUUID(),
      name: "Relay acceptance",
      key: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    const docker = (args, input, timeout = 45000, cleanup = false) =>
      new Promise((resolve, reject) => {
        const child = spawn("docker", args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        const timer = setTimeout(
          () => child.kill("SIGKILL"),
          cleanup
            ? timeout
            : Math.min(timeout, Math.max(1, deadline - Date.now())),
        );
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.stdin.on("error", () => {});
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim());
          else
            reject(
              new Error(
                `Docker ${args[0]} failed (${code}): ${stderr.slice(-1500)}`,
              ),
            );
        });
        child.stdin.end(input);
      });
    const inside = (node, source) =>
      docker(
        ["exec", "-i", `${name}-${node}`, "node", "--input-type=module"],
        source,
      );
    const request = async (node, path, method = "GET", body, port = 8080) =>
      JSON.parse(
        await inside(
          node,
          `
    const response = await fetch('http://127.0.0.1:${port}${path}', {method:${JSON.stringify(method)}, headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(5000), body:${body === undefined ? "undefined" : `JSON.stringify(${JSON.stringify(body)})`}});
    if (!response.ok) throw new Error('HTTP status ' + response.status);
    console.log(JSON.stringify(await response.json()));
  `,
        ),
      );
    const wait = async (label, check, timeout = 120000) => {
      const end = Math.min(deadline, Date.now() + timeout);
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`Timed out: ${label}`);
    };
    const state = (node) => request(node, "/state", "GET", undefined, 9099);
    const fault = (node, path) => request(node, path, "POST", undefined, 9099);
    const firewall = (node, ...args) =>
      docker([
        "run",
        "--rm",
        "--cap-add",
        "NET_ADMIN",
        "--network",
        `container:${name}-net-${node}`,
        "pigeon-relay-firewall:test",
        ...args,
      ]);
    const dropPrivate = async (node) =>
      assert.ok(
        (await fault(node, "/private/drop")).closedPrivateConnections >= 2,
        "Fault must close both private peer links",
      );
    const publicNetwork = async (node, enabled) => {
      await firewall(
        node,
        enabled ? "-D" : "-A",
        "OUTPUT",
        "-d",
        "11.254.0.0/24",
        "-j",
        "PUBLIC_OUTAGE",
      );
      if (!enabled) await fault(node, "/public/drop");
    };
    const traffic = async (phase, count = 3) => {
      const nodes = ["10", "11", "12"]
        .slice(0, count)
        .map((octet) => `http://11.254.0.${octet}:8080/api/`);
      const output = await docker(
        [
          "exec",
          "-i",
          "-e",
          `RELAY_TEST_NODES=${JSON.stringify(nodes)}`,
          "-e",
          `RELAY_TEST_NETWORK_ID=${network.id}`,
          "-e",
          `RELAY_TEST_PHASE=${phase}`,
          `${name}-a`,
          "node",
          "--input-type=module",
        ],
        await readFile("tests/relay-traffic-probe.mjs", "utf8"),
        120000,
      );
      assert.match(output, /^PASS relay traffic/);
      console.log(output);
    };
    const mesh = async (nodes) => {
      await wait("automatic private relay mesh", async () => {
        const states = await Promise.all(nodes.map(state));
        const ids = states.map(
          (state) =>
            state.private.find((node) => node.status === "started")?.id,
        );
        return (
          ids.every(Boolean) &&
          new Set(ids).size === nodes.length &&
          states.every((state, index) =>
            ids.every(
              (id, other) =>
                other === index ||
                state.private.some((node) => node.peers.includes(id)),
            ),
          )
        );
      });
      for (const node of nodes) {
        const persistedId = await inside(
          node,
          `
          const {createRequire} = await import('node:module');
          const requireApp = createRequire('/app/package.json');
          const {libp2pKeyAdapter} = requireApp('./dist/contexts/shared/infrastructure/ipfs/networks/adapters/Libp2pKeyAdapter');
          const fs = await import('node:fs/promises');
          const key = await libp2pKeyAdapter.privateKeyFromProtobuf(await fs.readFile(process.env.IPFS_STORAGE_PATH + '/shared-peer-private-key.pb'));
          console.log(libp2pKeyAdapter.peerIdFromPrivateKey(key));
        `,
        );
        assert.equal(
          (await state(node)).private.find((node) => node.status === "started")
            .id,
          persistedId,
          "Live private identity must match the persisted key",
        );
      }
      console.log(JSON.stringify({ phase: "mesh", nodes: nodes.length }));
    };
    let createdNetwork = false;
    try {
      const keyProbe = `${name}-key-probe`;
      containers.push(keyProbe);
      console.log(
        await docker([
          "run",
          "--name",
          keyProbe,
          "--network",
          "none",
          "--entrypoint",
          "node",
          "-v",
          `${resolve("tests/relay-key-persistence.cjs")}:/test/probe.cjs:ro`,
          image,
          "/test/probe.cjs",
        ]),
      );
      await docker([
        "build",
        "-t",
        "pigeon-relay-firewall:test",
        "-f",
        "tests/Dockerfile.relay-firewall",
        "tests",
      ]);
      await docker([
        "network",
        "create",
        "--internal",
        "--subnet",
        "11.254.0.0/24",
        name,
      ]);
      createdNetwork = true;
      const addresses = [];
      for (let index = 2; index < 6; index++) {
        const bootstrap = `${name}-bootstrap-${index}`;
        containers.push(bootstrap);
        await docker([
          "run",
          "-d",
          "--name",
          bootstrap,
          "--no-healthcheck",
          "--network",
          name,
          "--ip",
          `11.254.0.${index}`,
          "-e",
          "PIGEON_PUBLIC_BOOTSTRAP_ENABLED=false",
          "-e",
          `TEST_BOOTSTRAP_IP=11.254.0.${index}`,
          "-v",
          `${resolve("tests/relay-bootstrap.cjs")}:/test/bootstrap.cjs:ro`,
          "--entrypoint",
          "node",
          image,
          "/test/bootstrap.cjs",
        ]);
        await wait("public bootstrap ready", async () => {
          const logs = await docker(["logs", bootstrap]);
          const published = logs
            .split("\n")
            .map((line) => {
              try {
                return JSON.parse(line).addresses;
              } catch {
                return undefined;
              }
            })
            .find((addresses) => addresses?.length === 1);
          if (!published) return false;
          addresses.push(...published);
          return true;
        });
      }
      const start = async (node, octet, delayPublic = false) => {
        containers.push(`${name}-net-${node}`);
        await docker([
          "run",
          "-d",
          "--name",
          `${name}-net-${node}`,
          "--sysctl",
          "net.ipv6.conf.all.disable_ipv6=1",
          "--sysctl",
          "net.ipv6.conf.default.disable_ipv6=1",
          "--network",
          name,
          "--ip",
          `11.254.0.${octet}`,
          "--entrypoint",
          "sleep",
          "pigeon-relay-firewall:test",
          "infinity",
        ]);
        await firewall(
          node,
          "-A",
          "OUTPUT",
          "-p",
          "udp",
          "--dport",
          "5353",
          "-j",
          "DROP",
        );
        await firewall(node, "-N", "PUBLIC_OUTAGE");
        for (const direction of ["--dport", "--sport"]) {
          for (const port of ["8080", "4102:4133"])
            await firewall(
              node,
              "-A",
              "PUBLIC_OUTAGE",
              "-p",
              "tcp",
              direction,
              port,
              "-j",
              "RETURN",
            );
        }
        await firewall(node, "-A", "PUBLIC_OUTAGE", "-j", "REJECT");
        containers.push(`${name}-${node}`);
        await docker([
          "run",
          "-d",
          "--name",
          `${name}-${node}`,
          "--network",
          `container:${name}-net-${node}`,
          "-e",
          "PIGEON_TURN_MODE=external",
          "-e",
          `CALLS_TURN_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
          "-e",
          `PIGEON_PUBLIC_BOOTSTRAP_MULTIADDRS=${addresses.join(",")}`,
          "-e",
          "PIGEON_RELAY_RECORD_DISCOVERY_INTERVAL_MS=2000",
          "-e",
          "PIGEON_RELAY_RECORD_CONNECTED_DISCOVERY_INTERVAL_MS=4000",
          "-e",
          "PIGEON_RELAY_RECORD_PUBLICATION_INTERVAL_MS=2000",
          "-e",
          "PIGEON_RELAY_RECORD_PUBLIC_PEER_WAIT_MS=1000",
          "-e",
          "PIGEON_RELAY_RECORD_TTL_MS=600000",
          "-v",
          `${resolve("tests/relay-runtime-control.cjs")}:/test/control.cjs:ro`,
          image,
          "node",
          "-r",
          "/test/control.cjs",
          "dist/index.js",
        ]);
        await wait("application ready", () =>
          request(node, "/api/node/").then(
            () => true,
            () => false,
          ),
        );
        await request(node, "/api/node/relay-configuration/", "PUT", {
          publicHost: `11.254.0.${octet}`,
          callsRelay: { port: 4101 },
          privateRelay: {
            enabled: true,
            portStart: 4102,
            portEnd: 4133,
            publicRecordPublicationEnabled: true,
            publicRecordDiscoveryEnabled: true,
          },
          publicNetwork: { enabled: true, port: 4100 },
          manualRelayMultiaddrs: [],
        });
        if (delayPublic) await publicNetwork(node, false);
        await request(node, "/api/node/networks/", "POST", network);
      };
      await start("a", 10);
      await start("b", 11, true);
      await wait("isolated private node started", async () =>
        (await state("b")).private.some((node) => node.status === "started"),
      );
      const guard = Date.now() + 5000;
      while (Date.now() < guard) {
        const isolated = await state("b");
        assert.ok(
          isolated.public.length > 0 &&
            isolated.public.every((node) => node.peers.length === 0),
        );
        assert.ok(
          isolated.private.every((node) => node.peers.length === 0),
          "Cold discovery must not bypass the unavailable public directory",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const delayedAt = Date.now();
      await publicNetwork("b", true);
      await mesh(["a", "b"]);
      await traffic("delayed-public", 2);
      console.log(
        JSON.stringify({
          phase: "delayed-public",
          durationMs: Date.now() - delayedAt,
        }),
      );
      const lateAt = Date.now();
      await start("c", 12);
      await mesh(["a", "b", "c"]);
      await traffic("late-publisher");
      console.log(
        JSON.stringify({
          phase: "late-publisher",
          durationMs: Date.now() - lateAt,
        }),
      );
      for (let cycle = 0; cycle < 2; cycle++) {
        const started = Date.now();
        await dropPrivate("c");
        await mesh(["a", "b", "c"]);
        await traffic(`link-recovery-${cycle}`);
        console.log(
          JSON.stringify({
            phase: "link-recovery",
            cycle,
            durationMs: Date.now() - started,
          }),
        );
      }
      await Promise.all(
        ["a", "b", "c"].map((node) => publicNetwork(node, false)),
      );
      const identities = await Promise.all(
        ["a", "b", "c"].map(async (node) => ({
          node,
          id: (await state(node)).private.find(
            (node) => node.status === "started",
          ).id,
        })),
      );
      const initiator = identities.sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )[0].node;
      await firewall(initiator, "-N", "PRIVATE_DIAL_BLOCK");
      await firewall(
        initiator,
        "-A",
        "PRIVATE_DIAL_BLOCK",
        "-p",
        "tcp",
        "-j",
        "REJECT",
        "--reject-with",
        "tcp-reset",
      );
      const dialRule = [
        "OUTPUT",
        "-p",
        "tcp",
        "--syn",
        "--dport",
        "4102:4133",
        "-j",
        "PRIVATE_DIAL_BLOCK",
      ];
      await firewall(initiator, "-A", ...dialRule);
      const outage = Date.now();
      await dropPrivate(initiator);
      await mesh(["a", "b", "c"]);
      await traffic("cached-recovery");
      for (const node of ["a", "b", "c"]) {
        const publicNodes = (await state(node)).public;
        assert.ok(
          publicNodes.length > 0 &&
            publicNodes.every((node) => node.peers.length === 0),
        );
      }
      const counters = await firewall(
        initiator,
        "-L",
        "PRIVATE_DIAL_BLOCK",
        "-vnx",
        "--line-numbers",
      );
      const rejectedDials = Number(
        counters
          .split("\n")
          .find((line) => /^\s*1\s/.test(line))
          ?.trim()
          .split(/\s+/)[1],
      );
      assert.ok(
        rejectedDials > 0,
        "The selected initiator must attempt blocked outbound connections",
      );
      assert.ok(
        Date.now() - outage <= 90000,
        "Cached mesh and fresh traffic must recover within 90 seconds",
      );
      await firewall(initiator, "-D", ...dialRule);
      console.log(
        JSON.stringify({
          phase: "cached-recovery",
          durationMs: Date.now() - outage,
          rejectedDials,
        }),
      );
      await Promise.all(
        ["a", "b", "c"].map((node) => publicNetwork(node, true)),
      );
      const before = (await state("c")).private.find(
        (node) => node.status === "started",
      ).id;
      const restartAt = Date.now();
      await docker(["restart", `${name}-c`]);
      await firewall(
        "c",
        "-C",
        "OUTPUT",
        "-p",
        "udp",
        "--dport",
        "5353",
        "-j",
        "DROP",
      );
      await wait("restarted application ready", () =>
        state("c").then(
          () => true,
          () => false,
        ),
      );
      await mesh(["a", "b", "c"]);
      assert.equal(
        (await state("c")).private.find((node) => node.status === "started").id,
        before,
      );
      await traffic("process-restart");
      console.log(
        JSON.stringify({
          phase: "process-restart",
          durationMs: Date.now() - restartAt,
        }),
      );
    } catch (error) {
      for (const node of ["a", "b", "c"]) {
        const snapshot = await state(node).catch(() => undefined);
        if (snapshot)
          console.log(
            JSON.stringify({
              node,
              private: snapshot.private.map((node) => ({
                status: node.status,
                peers: node.peers.length,
              })),
              public: snapshot.public.map((node) => ({
                status: node.status,
                peers: node.peers.length,
                pubsubStarted: node.pubsubStarted,
              })),
            }),
          );
      }
      throw error;
    } finally {
      const results = [];
      for (const container of [...containers].reverse())
        results.push(
          ...(await Promise.allSettled([
            docker(["rm", "-fv", container], undefined, 45000, true),
          ])),
        );
      if (createdNetwork)
        await docker(["network", "rm", name], undefined, 45000, true);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }
  },
);
