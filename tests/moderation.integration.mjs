import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const image = process.env.PIGEON_TEST_IMAGE;
const nodeUrl = "http://127.0.0.1:8080/api/";

const docker = (args, input, timeout = 120000) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`docker ${args[0]} failed (${code}): ${stderr.slice(-1500)}`),
        );
    });
    child.stdin.end(input);
  });

const readiness = `
import { createActor, publishIdentity, signedRequest } from "/app/signed-pigeon-client.mjs";
const base = new URL(process.env.MODERATION_TEST_NODE);
const network = process.env.MODERATION_TEST_NETWORK_ID;
const deadline = Date.now() + 120000;
for (;;) {
  try {
    await publishIdentity((...args) => signedRequest(base, ...args), await createActor(), [network], "Readiness");
    console.log("READY");
    break;
  } catch (error) {
    if (Date.now() > deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
`;

test(
  "moderation and publishing limits are enforced by a real node",
  { timeout: 600000 },
  async () => {
    assert.match(
      image || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
    );
    const name = `pigeon-moderation-${randomBytes(5).toString("hex")}`;
    const network = {
      id: randomUUID(),
      name: "Moderation acceptance",
      key: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    try {
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "-e",
        "PIGEON_TURN_MODE=external",
        "-e",
        `CALLS_TURN_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
        "-e",
        "PIGEON_PUBLIC_BOOTSTRAP_ENABLED=false",
        image,
      ]);
      const env = [
        "-e",
        `MODERATION_TEST_NODE=${nodeUrl}`,
        "-e",
        `MODERATION_TEST_NETWORK_ID=${network.id}`,
      ];
      const deadline = Date.now() + 120000;
      for (;;) {
        try {
          await docker([
            "exec",
            name,
            "node",
            "-e",
            `fetch(${JSON.stringify(nodeUrl + "node/")}).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
          ]);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      await docker([
        "exec",
        "-i",
        name,
        "node",
        "-e",
        `fetch(${JSON.stringify(nodeUrl + "node/networks/")}, {method: "POST", headers: {"content-type": "application/json"}, body: ${JSON.stringify(JSON.stringify(network))}}).then((r) => process.exit(r.ok ? 0 : 1))`,
      ]);
      await docker([
        "cp",
        "tests/signed-pigeon-client.mjs",
        `${name}:/app/signed-pigeon-client.mjs`,
      ]);
      assert.equal(
        await docker(
          ["exec", "-i", ...env, name, "node", "--input-type=module"],
          readiness,
          180000,
        ),
        "READY",
      );
      const output = await docker(
        ["exec", "-i", ...env, name, "node", "--input-type=module"],
        await readFile("tests/moderation-probe.mjs", "utf8"),
        300000,
      );
      assert.match(output, /PASS moderation/);
      console.log(output);
    } finally {
      await docker(["rm", "-fv", name]).catch(() => {});
    }
  },
);
