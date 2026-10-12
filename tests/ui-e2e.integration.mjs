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
      if (error.fatal || Date.now() > deadline) {
        throw new Error(`${description}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

// Fails at once when the recipient or sender page shows the network error
// copy, instead of waiting out the sync timeout. The message carries no page
// text, only the side that failed.
const failFastOnNetworkError = async (page, side) => {
  const networkErrors = await page
    .getByText(/No se pudo contactar con el servidor/)
    .count();

  if (networkErrors > 0) {
    const error = new Error(`${side} page shows the network error copy`);
    error.fatal = true;
    throw error;
  }
};

// Realtime frames for a message timeline event carry the full message inline,
// which is the legacy replicated copy the mailbox is replacing. The recipient
// is denied that copy during the mailbox-only assertion.
const legacyMessageEventPrefix = "conversations.v1.message.";
const legacyMessageReadPath = /\/conversations\/[^/]+\/messages(\/|$)/;
const isLegacyMessageFrame = (message) => {
  try {
    const frame = JSON.parse(message.toString());

    return (
      frame.type === "domain_event" &&
      typeof frame.event?.type === "string" &&
      frame.event.type.startsWith(legacyMessageEventPrefix)
    );
  } catch {
    return false;
  }
};

// Checks that a one-to-one message also travels through the recipient mailbox
// on this node, then that the recipient renders a second message with the
// legacy copy withheld, after its saved mailbox state is cleared. A failed
// mailbox append is silent and the legacy copy still delivers, so the specs
// above cannot show this path. Logs counts only: no message text, ids or
// envelope bodies.
const assertDirectMessageMailboxDelivery = async (uiSource, origin) => {
  const { chromium } = createRequire(join(uiSource, "package.json"))(
    "playwright-core",
  );
  const browser = await chromium.launch({ headless: true });

  try {
    const suffix = randomBytes(3).toString("hex");
    const password = `Disposable-mailbox-test-password1!${suffix}`;
    const visible = (page, testId) =>
      page.getByTestId(testId).filter({ visible: true }).first();
    const dismissPushPrompt = async (page) => {
      const dismiss = visible(page, "push-notification-dismiss-button");

      if ((await dismiss.count()) > 0) await dismiss.click();
    };
    const openSidebar = async (page) => {
      if ((await visible(page, "create-conversation-button").count()) > 0) {
        return;
      }

      await visible(page, "workspace-sidebar-open-button").click();
      await visible(page, "create-conversation-button").waitFor({
        state: "visible",
      });
    };
    const selectConversation = async (page, title) => {
      await openSidebar(page);
      const row = page
        .getByTestId("conversation-list-item")
        .filter({ hasText: title })
        .first();

      await row.waitFor({ state: "visible" });
      await row.click();
    };
    const register = async (name, handle, { withholdLegacy = false } = {}) => {
      const context = await browser.newContext({ locale: "en-US" });
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      const counts = {
        inboxes: 0,
        appends: 0,
        reads: 0,
        envelopes: 0,
        acks: 0,
        seen: {},
      };
      const tally = (key) => {
        counts.seen[key] = (counts.seen[key] ?? 0) + 1;
      };
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/mailboxes/")) {
          tally(`${request.method()} failed`);
        }
      });
      page.on("response", async (response) => {
        const { pathname } = new URL(response.url());
        if (!pathname.startsWith("/api/mailboxes/")) return;
        const method = response.request().method();
        tally(`${method} ${response.status()}`);
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
      const legacy = { withholding: false, withheldFrames: 0, blockedReads: 0 };

      if (withholdLegacy) {
        await page.routeWebSocket(/\/realtime\/v1/, (ws) => {
          const server = ws.connectToServer();

          ws.onMessage((message) => server.send(message));
          server.onMessage((message) => {
            if (legacy.withholding && isLegacyMessageFrame(message)) {
              legacy.withheldFrames += 1;

              return;
            }

            ws.send(message);
          });
        });
        await page.route(
          (url) => legacyMessageReadPath.test(url.pathname),
          (route) => {
            if (!legacy.withholding || route.request().method() !== "GET") {
              return route.fallback();
            }

            legacy.blockedReads += 1;

            return route.abort("blockedbyclient");
          },
        );
      }

      await page.goto(origin);
      await page.getByTestId("auth-mode-control").locator("button").nth(1).click();
      await page.getByTestId("auth-name-input").fill(name);
      await page.getByTestId("auth-handle-input").fill(handle);
      await page.getByTestId("auth-password-input").fill(password);
      await page.getByTestId("auth-password-confirmation-input").fill(password);
      await page.getByTestId("auth-recovery-key-confirm").click();
      await page.getByTestId("auth-submit-button").click();
      await visible(page, "create-conversation-button").waitFor({
        state: "visible",
      });
      await dismissPushPrompt(page);
      return { page, counts, legacy };
    };
    const alice = await register(`Mailbox A ${suffix}`, `mailbox-a-${suffix}`);
    const bob = await register(`Mailbox B ${suffix}`, `mailbox-b-${suffix}`, {
      withholdLegacy: true,
    });

    await openSidebar(alice.page);
    await visible(alice.page, "create-conversation-button").click();
    await alice.page
      .getByTestId("create-conversation-recipient-input")
      .fill(`@mailbox-b-${suffix}`);
    await alice.page.getByTestId("create-conversation-submit-button").click();
    await alice.page
      .getByTestId("create-conversation-recipient-input")
      .waitFor({ state: "hidden" });
    await dismissPushPrompt(alice.page);

    await openSidebar(bob.page);
    await visible(bob.page, "notifications-open-button").click();
    await visible(bob.page, "notification-accept-button").click();
    await dismissPushPrompt(bob.page);

    await selectConversation(alice.page, `Mailbox B ${suffix}`);
    await selectConversation(bob.page, `Mailbox A ${suffix}`);
    // The recipient's sync starts with the active conversation and creates the
    // inbox on its first pass. A send before that is refused by the node, so
    // wait until the recipient has read it.
    await waitFor(
      async () => {
        await failFastOnNetworkError(bob.page, "recipient");
        const notice = await bob.page
          .getByText(/could not be synced|Conversation key is required/)
          .count();
        const composer = await bob.page
          .getByTestId("message-composer-input")
          .isEnabled({ timeout: 2000 })
          .catch(() => false);

        assert.ok(
          bob.counts.reads > 0,
          `recipient inbox not read; ${JSON.stringify({
            bob: bob.counts.seen,
            alice: alice.counts.seen,
            syncNotice: notice > 0,
            composerEnabled: composer,
          })}`,
        );
      },
      60000,
      "recipient mailbox sync did not start",
    );

    // Forget the recipient's saved mailbox state (read cursor and any stored
    // token), as a device that lost its local storage would. The next sync pass
    // creates the state again and derives the read token from the identity key.
    const clearedMailboxState = await bob.page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((key) =>
        key.startsWith("pigeon.direct-mailbox."),
      );

      for (const key of keys) localStorage.removeItem(key);

      return keys.length;
    });

    assert.ok(
      clearedMailboxState > 0,
      "recipient mailbox state was not saved before the clear",
    );

    await alice.page
      .getByTestId("message-composer-input")
      .fill(`mailbox probe ${suffix}`);
    await alice.page.getByTestId("message-send-button").click();
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
    // Withhold the legacy copy from the recipient, then send a second message.
    // With realtime message frames and message reads blocked, the mailbox is the
    // only path left, so the text must render from the mailbox alone.
    // The saved mailbox state was cleared above, so this read starts from cursor 0.
    bob.legacy.withholding = true;
    const withheldBefore = bob.legacy.withheldFrames;
    const envelopesBefore = bob.counts.envelopes;
    const acksBefore = bob.counts.acks;
    const mailboxOnlyText = `mailbox only ${suffix}`;
    await alice.page
      .getByTestId("message-composer-input")
      .fill(mailboxOnlyText);
    await alice.page.getByTestId("message-send-button").click();
    await waitFor(
      async () => {
        const rendered = await bob.page
          .getByTestId("message-item")
          .filter({ hasText: mailboxOnlyText, visible: true })
          .count();

        assert.ok(
          rendered > 0 &&
            bob.counts.envelopes > envelopesBefore &&
            bob.counts.acks > acksBefore &&
            bob.legacy.withheldFrames > withheldBefore,
          `recipient ${JSON.stringify({
            rendered: rendered > 0,
            counts: bob.counts,
            legacy: bob.legacy,
          })}`,
        );
      },
      90000,
      "direct message did not render from the recipient mailbox alone",
    );
    console.log(
      JSON.stringify({
        directMailbox: {
          sender: alice.counts,
          recipient: bob.counts,
          recipientStateCleared: clearedMailboxState,
          legacyWithheld: {
            frames: bob.legacy.withheldFrames,
            reads: bob.legacy.blockedReads,
          },
        },
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
