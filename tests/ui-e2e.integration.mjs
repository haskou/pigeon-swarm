import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

const image = process.env.PIGEON_TEST_IMAGE;
const uiSource = process.env.PIGEON_UI_SOURCE;
const origin = "http://127.0.0.1:8080";
// Specs that drive the real UI against the real node in the image. The other
// specs in the UI repository use Vite fixtures or external accounts.
const specs = [
  "e2e/login-methods.spec.ts",
  "e2e/empty-members-column.spec.ts",
  "e2e/remember-session.spec.ts",
  "e2e/direct-message-sync.spec.ts",
  "e2e/call-page-departure.spec.ts",
];

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      process.stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      output += data;
      process.stderr.write(data);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} ${args[0]} failed (${code})`));
    });
  });

const waitFor = async (check, timeout, description) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`${description}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

test(
  "UI flows work against a real node served by the application image",
  { timeout: 1800000 },
  async () => {
    assert.match(
      image || "",
      /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
    );
    assert.ok(uiSource, "PIGEON_UI_SOURCE must point to the UI checkout");
    const name = `pigeon-ui-e2e-${randomBytes(5).toString("hex")}`;
    const network = {
      id: randomUUID(),
      name: "UI acceptance",
      key: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    try {
      await run("docker", [
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1:8080:8080",
        "-e",
        "PIGEON_TURN_MODE=external",
        "-e",
        `CALLS_TURN_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
        "-e",
        "PIGEON_PUBLIC_BOOTSTRAP_ENABLED=false",
        image,
      ]);
      await waitFor(
        async () => {
          const response = await fetch(`${origin}/api/node/`);
          assert.ok(response.ok, `node status ${response.status}`);
        },
        120000,
        "node did not become ready",
      );
      const registered = await fetch(`${origin}/api/node/networks/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(network),
      });
      assert.ok(registered.ok, `network registration ${registered.status}`);
      await waitFor(
        async () => {
          const response = await fetch(`${origin}/`);
          assert.ok(response.ok, `UI status ${response.status}`);
        },
        60000,
        "UI is not served by the image",
      );
      await run(
        "yarn",
        ["playwright", "test", ...specs, "--project=desktop-chromium"],
        {
          cwd: uiSource,
          env: {
            ...process.env,
            CI: "true",
            E2E_BASE_URL: origin,
            E2E_NETWORK_ID: network.id,
          },
        },
      );
    } catch (error) {
      await run("docker", ["logs", "--tail", "200", name]).catch(() => {});
      throw error;
    } finally {
      await run("docker", ["rm", "-fv", name]).catch(() => {});
    }
  },
);
