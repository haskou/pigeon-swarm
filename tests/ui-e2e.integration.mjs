import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
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
// Engine and viewport coverage: the session specs that need no second device.
const crossEngineSpecs = [
  "e2e/login-methods.spec.ts",
  "e2e/empty-members-column.spec.ts",
  "e2e/remember-session.spec.ts",
];
const crossEngineProjects = ["mobile-chromium", "desktop-firefox"];

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

// Count-only check that a one-to-one message also travels through the
// recipient mailbox on this node. A failed mailbox append is silent and the
// legacy copy still delivers, so the specs above cannot show this path. Logs
// counts only: no message text, ids or envelope bodies.
const assertDirectMessageMailboxDelivery = async (uiSource, origin) => {
  const { chromium } = createRequire(join(uiSource, "package.json"))(
    "playwright-core",
  );
  const browser = await chromium.launch({ headless: true });

  try {
    const suffix = randomBytes(3).toString("hex");
    const password = `Disposable-mailbox-test-password1!${suffix}`;
    const register = async (handle) => {
      const context = await browser.newContext({ locale: "en-US" });
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      const counts = { inboxes: 0, appends: 0, reads: 0, envelopes: 0, acks: 0 };
      page.on("response", async (response) => {
        const { pathname } = new URL(response.url());
        if (!pathname.startsWith("/api/mailboxes/")) return;
        const method = response.request().method();
        if (method === "PUT" && response.ok()) {
          counts.inboxes += 1;
        } else if (
          method === "POST" &&
          pathname.endsWith("/envelopes") &&
          response.ok()
        ) {
          counts.appends += 1;
        } else if (
          method === "GET" &&
          pathname.endsWith("/envelopes") &&
          response.status() === 200
        ) {
          const body = await response.json().catch(() => ({}));
          counts.reads += 1;
          counts.envelopes += Array.isArray(body.envelopes)
            ? body.envelopes.length
            : 0;
        } else if (
          method === "POST" &&
          pathname.endsWith("/ack") &&
          response.status() === 204
        ) {
          counts.acks += 1;
        }
      });
      await page.goto(origin);
      await page.getByTestId("auth-mode-control").locator("button").nth(1).click();
      await page.getByTestId("auth-name-input").fill(handle);
      await page.getByTestId("auth-handle-input").fill(handle);
      await page.getByTestId("auth-password-input").fill(password);
      await page.getByTestId("auth-password-confirmation-input").fill(password);
      await page.getByTestId("auth-recovery-key-confirm").click();
      await page.getByTestId("auth-submit-button").click();
      await page.getByTestId("create-conversation-button").first().waitFor();
      if (await page.getByTestId("push-notification-dismiss-button").isVisible())
        await page.getByTestId("push-notification-dismiss-button").click();
      return { page, counts };
    };
    const alice = await register(`mailbox-a-${suffix}`);
    const bob = await register(`mailbox-b-${suffix}`);
    const recipientId = await waitFor(
      async () => {
        const response = await fetch(
          `${origin}/api/identities/mailbox-b-${suffix}`,
        );
        assert.ok(response.ok, `identity status ${response.status}`);
        const identity = await response.json();
        assert.equal(typeof identity?.id, "string");
        return identity.id;
      },
      60000,
      "recipient identity is not available on the node",
    );
    await alice.page.getByTestId("create-conversation-button").first().click();
    await alice.page
      .getByTestId("create-conversation-recipient-input")
      .fill(recipientId);
    await alice.page.getByTestId("create-conversation-submit-button").click();
    await alice.page
      .getByTestId("create-conversation-recipient-input")
      .waitFor({ state: "hidden" });
    await bob.page
      .locator('[data-testid="notifications-open-button"]:visible')
      .first()
      .click();
    const accept = bob.page.getByTestId("notification-accept-button").first();
    await accept.waitFor({ state: "visible", timeout: 60000 });
    await accept.click();
    await bob.page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="message-composer-input"]')
          ?.disabled,
      undefined,
      { timeout: 60000 },
    );
    // The recipient's first sync creates the inbox. A send before that is
    // refused by the node, so wait until the recipient has read it.
    await waitFor(
      () => assert.ok(bob.counts.reads > 0, "recipient inbox not read yet"),
      60000,
      "recipient mailbox sync did not start",
    );
    const composer = alice.page.getByTestId("message-composer-input");
    await composer.fill(`mailbox probe ${suffix}`);
    await composer.press("Enter");
    await waitFor(
      () =>
        assert.ok(
          alice.counts.appends > 0 &&
            bob.counts.envelopes > 0 &&
            bob.counts.acks > 0,
          `sender ${JSON.stringify(alice.counts)}, recipient ${JSON.stringify(bob.counts)}`,
        ),
      90000,
      "direct message was not delivered through the recipient mailbox",
    );
    console.log(
      JSON.stringify({
        directMailbox: { sender: alice.counts, recipient: bob.counts },
      }),
    );
  } finally {
    await browser.close();
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
      const playwright = (projects, files) =>
        run(
          "yarn",
          [
            "playwright",
            "test",
            ...files,
            ...projects.map((project) => `--project=${project}`),
          ],
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
      await playwright(["desktop-chromium"], specs);
      await playwright(crossEngineProjects, crossEngineSpecs);
      await assertDirectMessageMailboxDelivery(uiSource, origin);
    } catch (error) {
      await run("docker", ["logs", "--tail", "200", name]).catch(() => {});
      throw error;
    } finally {
      await run("docker", ["rm", "-fv", name]).catch(() => {});
    }
  },
);
