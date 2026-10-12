import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
  "e2e/direct-message-sync.spec.ts",
  "e2e/call-page-departure.spec.ts",
];
// Engine and viewport coverage: the specs that need no second device.
const crossEngineSpecs = [
  "e2e/login-methods.spec.ts",
  "e2e/empty-members-column.spec.ts",
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
// Pairs a new device of the identity from a signed-in device, through the
// same UI steps a user takes, then waits for the new device's workspace.
const pairDevice = async (origin, password, authorized, handle, fresh) => {
  await openSidebar(authorized);
  await visible(authorized, "own-profile-menu-button").click();
  await authorized.getByTestId("edit-profile-button").click();
  await authorized.getByRole("button", { name: "Security" }).click();
  await authorized.getByTestId("profile-pair-device").click();

  const invitation = await authorized
    .getByTestId("device-pairing-invitation-output")
    .inputValue();

  assert.match(invitation, /^\S+$/);
  await fresh.goto(origin);
  await fresh.getByTestId("auth-identity-input").fill(`@${handle}`);
  await fresh
    .getByTestId("auth-login-method-control")
    .getByRole("button", { name: "New device" })
    .click();
  await fresh
    .getByTestId("auth-device-pairing-invitation-input")
    .fill(invitation);
  await fresh.getByTestId("auth-device-pairing-prepare").click();

  const request = await fresh
    .getByTestId("auth-device-pairing-request-output")
    .inputValue();
  const code = await fresh
    .getByTestId("auth-device-pairing-verification-code")
    .innerText();

  await authorized.getByTestId("device-pairing-request-input").fill(request);
  await authorized.getByTestId("device-pairing-submit").click();
  await waitFor(
    async () => {
      const shown = await authorized
        .getByTestId("device-pairing-verification-code")
        .innerText();

      assert.equal(shown, code);
    },
    45000,
    "pairing verification codes differ",
  );
  await authorized.getByTestId("device-pairing-submit").click();

  const completionOutput = authorized.getByTestId(
    "device-pairing-completion-output",
  );

  await completionOutput.waitFor({ state: "visible" });

  const completion = await completionOutput.inputValue();

  await fresh
    .getByTestId("auth-device-pairing-completion-input")
    .fill(completion);
  await fresh.getByTestId("auth-password-input").fill(password);
  await fresh.getByTestId("auth-password-confirmation-input").fill(password);
  await fresh.getByTestId("auth-submit-button").click();
  await visible(fresh, "create-conversation-button").waitFor({
    state: "visible",
  });
  await dismissPushPrompt(fresh);
  await authorized
    .getByRole("button", { name: "Close dialog" })
    .last()
    .click();
};

// Checks that a one-to-one message also travels through the recipient mailbox
// on this node, then that the recipient renders a second message with the
// legacy copy withheld, after its saved mailbox state is cleared. A failed
// mailbox append is silent and the legacy copy still delivers, so the specs
// above cannot show this path. With the legacy copy still withheld, the sender
// then replies to, reacts to, edits and deletes messages, and each must reach
// the recipient from the mailbox alone. The server must echo replyToMessageId
// and targetMessageId in the responses those records are built from. A second
// device of the recipient's identity, paired in through the UI, must render a
// third message only after the first device has acked it. No mailbox POST may
// fail on any of the three devices. Logs counts only: no message text, ids or
// envelope bodies.
const assertDirectMessageMailboxDelivery = async (uiSource, origin) => {
  const { chromium } = createRequire(join(uiSource, "package.json"))(
    "playwright-core",
  );
  const browser = await chromium.launch({ headless: true });

  try {
    const suffix = randomBytes(3).toString("hex");
    const password = `Disposable-mailbox-test-password1!${suffix}`;
    const selectConversation = async (page, title) => {
      await openSidebar(page);
      const row = page
        .getByTestId("conversation-list-item")
        .filter({ hasText: title })
        .first();

      await row.waitFor({ state: "visible" });
      await row.click();
    };
    const sha256 = (token) => createHash("sha256").update(token).digest("hex");
    const bodyOf = (request) => {
      try {
        return request.postDataJSON() ?? {};
      } catch {
        return {};
      }
    };
    // One browser context per device. The trace keeps reader classes, never
    // tokens: "root" for the inbox root reader, "device" for a reader enrolled
    // by a device, "unknown" for anything else.
    const openPage = async ({ withholdLegacy = false } = {}) => {
      const context = await browser.newContext({ locale: "en-US" });
      // The app falls back to Spanish unless English is stored explicitly; the
      // probe's locators are English, so seed the stored language per context.
      await context.addInitScript(() => {
        if (!location.protocol.startsWith("http")) return;
        localStorage.setItem("pigeon-swarm-language-v2", "en");
        localStorage.setItem("pigeon-swarm-language-explicit-v3", "true");
      });
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
      const trace = {
        rootHashes: new Set(),
        readerHashes: new Set(),
        reads: [],
        acks: [],
        appends: [],
        observers: [],
      };
      const classify = (token) => {
        const hash = sha256(token);

        if (trace.rootHashes.has(hash)) return "root";
        if (trace.readerHashes.has(hash)) return "device";
        return "unknown";
      };
      const notify = (event) => {
        for (const observe of trace.observers) observe(event);
      };
      const tally = (key) => {
        counts.seen[key] = (counts.seen[key] ?? 0) + 1;
      };
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/mailboxes/")) {
          tally(
            `${request.method()} failed ${request.failure()?.errorText ?? "unknown"}`,
          );
        }
      });
      page.on("pageerror", (error) => tally(`pageerror ${error.name}`));
      page.on("console", (message) => {
        if (message.type() === "error") tally("console error");
      });
      page.on("response", async (response) => {
        const { pathname } = new URL(response.url());
        if (pathname.startsWith("/api/") && response.status() >= 400) {
          // Record only an error code or the body's key names, never values.
          const body = await response.json().catch(() => null);
          const code =
            [body?.code, body?.error?.code, body?.error?.name].find(
              (value) => typeof value === "string" && /^[\w.:-]{1,60}$/.test(value),
            ) ?? `keys:${Object.keys(body ?? {}).join("|")}`;
          tally(
            `${response.request().method()} ${response.status()} ${pathname.split("/")[2]} ${code.slice(0, 100)}`,
          );
        }
        if (!pathname.startsWith("/api/mailboxes/")) return;
        const request = response.request();
        const method = request.method();
        const mailbox = pathname.split("/")[3];
        const auth = request.headers().authorization ?? "";
        const token = auth.startsWith("Bearer ")
          ? auth.slice("Bearer ".length)
          : "";

        tally(`${method} ${response.status()}`);
        if (method === "PUT") {
          trace.rootHashes.add(bodyOf(request).readTokenHash);
        }
        if (method === "POST" && pathname.endsWith("/readers")) {
          trace.readerHashes.add(bodyOf(request).readTokenHash);
        }
        if (method === "PUT" && response.ok()) {
          counts.inboxes += 1;
        } else if (
          method === "POST" &&
          pathname.endsWith("/envelopes") &&
          response.ok()
        ) {
          counts.appends += 1;
          const { cursor } = await response.json().catch(() => ({}));
          const event = { kind: "append", mailbox, cursor };

          trace.appends.push(event);
          notify(event);
        } else if (
          method === "GET" &&
          pathname.endsWith("/envelopes") &&
          response.status() === 200
        ) {
          const body = await response.json().catch(() => ({}));
          const envelopes = Array.isArray(body.envelopes) ? body.envelopes : [];

          counts.reads += 1;
          counts.envelopes += envelopes.length;
          trace.reads.push({
            mailbox,
            token: classify(token),
            envelopes: envelopes.length,
          });
        } else if (
          method === "POST" &&
          pathname.endsWith("/ack") &&
          response.status() === 204
        ) {
          counts.acks += 1;
          const event = {
            kind: "ack",
            mailbox,
            token: classify(token),
            upTo: bodyOf(request).upTo,
          };

          trace.acks.push(event);
          notify(event);
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

      return { page, counts, legacy, trace };
    };
    const register = async (name, handle, options) => {
      const opened = await openPage(options);
      const { page } = opened;

      await page.goto(origin);
      await page
        .getByTestId("auth-mode-control")
        .locator("button")
        .nth(1)
        .click();
      await page.getByTestId("auth-name-input").fill(name);
      await page.getByTestId("auth-handle-input").fill(handle);
      await page.getByTestId("auth-password-input").fill(password);
      await page.getByTestId("auth-password-confirmation-input").fill(password);
      await page.getByTestId("auth-recovery-key-confirm").click();
      await page.getByTestId("auth-submit-button").click();
      await visible(page, "create-conversation-button")
        .waitFor({ state: "visible" })
        .catch(async (error) => {
          const shown = await page
            .locator("[data-testid]:visible")
            .evaluateAll((nodes) =>
              nodes.map((node) => node.dataset.testid).slice(0, 50),
            );
          const alerts = await page
            .locator('[role="alert"]:visible')
            .allInnerTexts();

          throw new Error(
            `${error.message.split("\n")[0]}; visible ${JSON.stringify(shown)}; alerts ${JSON.stringify(alerts.map((text) => text.slice(0, 160)))}; seen ${JSON.stringify(opened.counts.seen)}`,
          );
        });
      await dismissPushPrompt(page);
      return opened;
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
    // Mailbox-only actions. Bob's legacy copies stay withheld from here on, so
    // each action below must reach him through the mailbox alone. Only a
    // message's author can edit or delete it, so Alice replies to and reacts to
    // Bob's message, then edits and deletes her own. Each action waits for Bob
    // to render it, and for his envelope, ack and withheld-frame counts to move.
    const actions = {};
    const bobSnapshot = () => ({
      envelopes: bob.counts.envelopes,
      acks: bob.counts.acks,
      withheld: bob.legacy.withheldFrames,
    });
    const bobStep = async (name, before, achieved) => {
      await waitFor(
        async () => {
          const done = await achieved();

          assert.ok(
            done &&
              bob.counts.envelopes > before.envelopes &&
              bob.counts.acks > before.acks &&
              bob.legacy.withheldFrames > before.withheld,
            `recipient ${name} ${JSON.stringify({
              done,
              counts: bob.counts,
              legacy: bob.legacy,
            })}`,
          );
        },
        90000,
        `${name} did not render from the recipient mailbox alone`,
      );
      actions[name] = {
        envelopes: bob.counts.envelopes - before.envelopes,
        acks: bob.counts.acks - before.acks,
        withheldFrames: bob.legacy.withheldFrames - before.withheld,
      };
    };
    const messageItem = (page, text) =>
      page.getByTestId("message-item").filter({ hasText: text, visible: true });
    const messageId = (page, text) =>
      messageItem(page, text).first().getAttribute("data-message-id");
    const openMessageMenu = async (page, text) => {
      await messageItem(page, text)
        .first()
        .getByTestId("message-bubble")
        .click({ button: "right" });
    };
    const menuAction = (page, label) =>
      page.getByRole("button", { name: label, exact: true }).click();

    const bobTargetText = `bob target ${suffix}`;

    await bob.page.getByTestId("message-composer-input").fill(bobTargetText);
    await bob.page.getByTestId("message-send-button").click();
    await waitFor(
      async () =>
        assert.ok(
          (await messageItem(alice.page, bobTargetText).count()) > 0,
          "sender did not render the recipient's message",
        ),
      90000,
      "recipient's message did not reach the sender",
    );
    const bobTargetId = await messageId(alice.page, bobTargetText);

    assert.ok(bobTargetId, "sender's view of the recipient's message has no id");

    const replyText = `reply ${suffix}`;
    const replyBefore = bobSnapshot();

    await openMessageMenu(alice.page, bobTargetText);
    await menuAction(alice.page, "Reply");
    await alice.page.getByTestId("message-composer-input").fill(replyText);
    const [replyResponse] = await Promise.all([
      alice.page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/messages"),
      ),
      alice.page.getByTestId("message-send-button").click(),
    ]);
    assert.equal(
      (await replyResponse.json()).replyToMessageId,
      bobTargetId,
      "server response did not echo replyToMessageId",
    );
    await bobStep("reply", replyBefore, async () =>
      (await messageItem(bob.page, replyText)
        .filter({ hasText: bobTargetText })
        .count()) > 0,
    );

    const reactionBefore = bobSnapshot();

    await openMessageMenu(alice.page, bobTargetText);
    const addReaction = alice.page
      .getByRole("button", { name: /^Add reaction /u })
      .first();
    const reactionLabel = await addReaction.getAttribute("aria-label");
    const emoji = reactionLabel?.replace("Add reaction ", "");

    assert.ok(emoji, "no quick reaction offered on the recipient's message");
    await addReaction.click();
    await bobStep("reaction", reactionBefore, async () =>
      (await messageItem(bob.page, bobTargetText)
        .first()
        .getByRole("button", { name: `${emoji} 1`, exact: true })
        .count()) > 0,
    );

    const editedText = `edited ${suffix}`;
    const mailboxOnlyId = await messageId(alice.page, mailboxOnlyText);

    assert.ok(
      mailboxOnlyId,
      "sender's view of the mailbox-only message has no id",
    );

    const editBefore = bobSnapshot();

    await openMessageMenu(alice.page, mailboxOnlyText);
    await menuAction(alice.page, "Edit");
    await alice.page.getByTestId("message-composer-input").fill(editedText);
    const [editResponse] = await Promise.all([
      alice.page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname.endsWith(
            `/messages/${encodeURIComponent(mailboxOnlyId)}`,
          ),
      ),
      alice.page.getByTestId("message-send-button").click(),
    ]);
    assert.equal(
      (await editResponse.json()).targetMessageId,
      mailboxOnlyId,
      "server response did not echo targetMessageId",
    );
    await bobStep("edit", editBefore, async () =>
      (await messageItem(bob.page, editedText).count()) > 0 &&
      (await messageItem(bob.page, mailboxOnlyText).count()) === 0,
    );

    const deleteBefore = bobSnapshot();

    await openMessageMenu(alice.page, replyText);
    await menuAction(alice.page, "Delete");
    await bobStep("delete", deleteBefore, async () =>
      (await messageItem(bob.page, replyText).count()) === 0,
    );

    // A second device of the recipient's identity pairs in from device A and
    // reads the same inbox with its own reader. The next message must reach it
    // from the mailbox alone, and only after device A has acked that message.
    const device = await openPage({ withholdLegacy: true });

    await pairDevice(
      origin,
      password,
      bob.page,
      `mailbox-b-${suffix}`,
      device.page,
    );
    await selectConversation(device.page, `Mailbox A ${suffix}`);
    await waitFor(
      () =>
        assert.ok(
          device.counts.reads > 0,
          `second device inbox not read; ${JSON.stringify(device.counts.seen)}`,
        ),
      90000,
      "second device mailbox sync did not start",
    );

    const mailbox = alice.trace.appends.at(-1)?.mailbox;

    assert.ok(mailbox, "sender did not append to the recipient mailbox");
    assert.ok(
      device.trace.reads.some((read) => read.mailbox === mailbox),
      "second device reads a different mailbox than the sender appends to",
    );

    // Gate: the second device's envelope reads are held until device A's device
    // reader has acked at or past the cursor of the message sent below. The UI
    // renders a page before it acknowledges it, so that ack means device A
    // rendered the message.
    const gate = {
      armed: false,
      cursor: undefined,
      ackUpTo: 0,
      opened: false,
      timedOut: false,
      held: 0,
      timer: undefined,
    };
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const settle = () => {
      if (gate.opened || typeof gate.cursor !== "number") return;
      if (gate.ackUpTo < gate.cursor) return;

      gate.opened = true;
      clearTimeout(gate.timer);
      release();
    };

    alice.trace.observers.push((event) => {
      if (
        gate.armed &&
        gate.cursor === undefined &&
        event.kind === "append" &&
        event.mailbox === mailbox &&
        typeof event.cursor === "number"
      ) {
        gate.cursor = event.cursor;
        settle();
      }
    });
    bob.trace.observers.push((event) => {
      if (
        event.kind === "ack" &&
        event.token === "device" &&
        event.mailbox === mailbox &&
        typeof event.upTo === "number"
      ) {
        gate.ackUpTo = Math.max(gate.ackUpTo, event.upTo);
        settle();
      }
    });
    await device.page.route(
      (url) => url.pathname === `/api/mailboxes/${mailbox}/envelopes`,
      async (route) => {
        if (gate.armed && !gate.opened) {
          gate.held += 1;
          await released;
        }

        return route.fallback();
      },
    );

    const before = {
      envelopes: device.counts.envelopes,
      withheld: device.legacy.withheldFrames,
    };

    device.legacy.withholding = true;
    gate.armed = true;
    gate.timer = setTimeout(() => {
      gate.timedOut = true;
      release();
    }, 90000);

    const secondText = `second device ${suffix}`;

    await alice.page.getByTestId("message-composer-input").fill(secondText);
    await alice.page.getByTestId("message-send-button").click();
    await waitFor(
      async () => {
        if (gate.timedOut) {
          throw Object.assign(
            new Error("device A did not ack the message before the gate timeout"),
            { fatal: true },
          );
        }

        const rendered = await device.page
          .getByTestId("message-item")
          .filter({ hasText: secondText, visible: true })
          .count();

        assert.ok(
          gate.opened &&
            rendered > 0 &&
            device.counts.envelopes > before.envelopes &&
            device.legacy.withheldFrames > before.withheld,
          `second device ${JSON.stringify({
            gateOpened: gate.opened,
            rendered: rendered > 0,
            counts: device.counts,
            legacy: device.legacy,
          })}`,
        );
      },
      120000,
      "second device did not render the message after device A acked it",
    );

    const tokenCount = (events) =>
      events.reduce(
        (tally, { token }) => ({ ...tally, [token]: (tally[token] ?? 0) + 1 }),
        {},
      );
    const readTokens = tokenCount(
      device.trace.reads.filter((read) => read.mailbox === mailbox),
    );
    const ackTokens = tokenCount(
      device.trace.acks.filter((ack) => ack.mailbox === mailbox),
    );

    assert.ok(
      readTokens.device > 0 &&
        readTokens.root === undefined &&
        readTokens.unknown === undefined,
      `second device reads ${JSON.stringify(readTokens)}`,
    );
    assert.ok(
      ackTokens.device > 0,
      `second device acks ${JSON.stringify(ackTokens)}`,
    );
    // A mailbox POST that Chromium reports as failed is a regression, whatever
    // the error text: an acked 204 that the page cancels shows up as
    // net::ERR_ABORTED. Failed reads (GET) stay in the logged counts only.
    const failedPosts = (counts) =>
      Object.entries(counts.seen)
        .filter(([key]) => key.startsWith("POST failed "))
        .reduce((total, [, count]) => total + count, 0);
    const postFailures = {
      sender: failedPosts(alice.counts),
      recipient: failedPosts(bob.counts),
      secondDevice: failedPosts(device.counts),
    };

    assert.deepEqual(
      postFailures,
      { sender: 0, recipient: 0, secondDevice: 0 },
      `mailbox POST requests failed ${JSON.stringify({
        sender: alice.counts.seen,
        recipient: bob.counts.seen,
        secondDevice: device.counts.seen,
      })}`,
    );
    console.log(
      JSON.stringify({
        directMailbox: {
          sender: alice.counts,
          mailboxActions: actions,
          recipient: bob.counts,
          recipientStateCleared: clearedMailboxState,
          legacyWithheld: {
            frames: bob.legacy.withheldFrames,
            reads: bob.legacy.blockedReads,
          },
          secondDevice: {
            counts: device.counts,
            legacyWithheld: {
              frames: device.legacy.withheldFrames,
              reads: device.legacy.blockedReads,
            },
            gate: { opened: gate.opened, heldReads: gate.held },
            readTokens,
            ackTokens,
          },
        },
      }),
    );
  } finally {
    await browser.close();
  }
};

const assertTestInputs = () => {
  assert.match(
    image || "",
    /^(?:ghcr\.io\/haskou\/pigeon-swarm@)?sha256:[a-f0-9]{64}$/,
  );
  assert.ok(uiSource, "PIGEON_UI_SOURCE must point to the UI checkout");
};

// Starts the application image with an external TURN relay, registers a
// network on it and waits until the UI is served. Returns the network.
const startNode = async (name) => {
  const network = {
    id: randomUUID(),
    name: "UI acceptance",
    key: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  };

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

  return network;
};

// Creates an identity on the first device through the UI.
const registerIdentity = async (page, origin, { name, handle, password }) => {
  await page.goto(origin);
  await page.getByTestId("auth-mode-control").locator("button").nth(1).click();
  await page.getByTestId("auth-name-input").fill(name);
  await page.getByTestId("auth-handle-input").fill(handle);
  await page.getByTestId("auth-password-input").fill(password);
  await page.getByTestId("auth-password-confirmation-input").fill(password);
  const recoveryKey = await page
    .getByTestId("auth-recovery-key-output")
    .inputValue();
  await page.getByTestId("auth-recovery-key-confirm").click();
  await page.getByTestId("auth-submit-button").click();
  await visible(page, "create-conversation-button").waitFor({
    state: "visible",
  });
  await dismissPushPrompt(page);
  return recoveryKey;
};

// Forgetting a device runs in that device's own profile menu. The device
// signs its requests with its credential, so the node must keep accepting a
// device-proof request the device signed before forgetting, and must refuse
// the identical request once the credential is revoked. The first device must
// still list itself. Logs hold status codes and counts only: no headers.
const assertDeviceForgetRevokesCredential = async (uiSource, origin) => {
  const { chromium } = createRequire(join(uiSource, "package.json"))(
    "playwright-core",
  );
  const browser = await chromium.launch({ headless: true });

  try {
    const suffix = randomBytes(3).toString("hex");
    const password = `Disposable-forget-test-password1!${suffix}`;
    const handle = `forget-a-${suffix}`;
    // Each page records the device-proof headers of its device-list requests,
    // the only signed requests this assertion replays.
    const openPage = async () => {
      const context = await browser.newContext({ locale: "en-US" });

      // The app falls back to Spanish unless English is stored explicitly.
      await context.addInitScript(() => {
        if (!location.protocol.startsWith("http")) return;
        localStorage.setItem("pigeon-swarm-language-v2", "en");
        localStorage.setItem("pigeon-swarm-language-explicit-v3", "true");
      });
      const page = await context.newPage();
      const proofs = [];

      page.setDefaultTimeout(45000);
      // Forgetting asks for confirmation through a native dialog.
      page.on("dialog", (dialog) => dialog.accept());
      page.on("request", (request) => {
        const headers = request.headers();

        if (
          request.method() === "GET" &&
          headers["x-device-signature"] !== undefined &&
          /^\/api\/identity-devices\/[^/]+\/devices$/.test(
            new URL(request.url()).pathname,
          )
        ) {
          proofs.push({
            url: request.url(),
            headers: Object.fromEntries(
              Object.entries(headers).filter(([key]) => key.startsWith("x-")),
            ),
          });
        }
      });

      return { page, proofs };
    };
    const openManageDevices = async (page) => {
      await openSidebar(page);
      await visible(page, "own-profile-menu-button").click();
      await page.getByTestId("edit-profile-button").click();
      await page.getByRole("button", { name: "Security" }).click();
      await page.getByTestId("profile-manage-devices").click();
    };
    const logOut = async (page) => {
      await openSidebar(page);
      await visible(page, "own-profile-menu-button").click();
      await page
        .getByRole("button", { name: "Log out" })
        .filter({ visible: true })
        .first()
        .click();
    };
    const expectDeviceRows = (page, expected, description) =>
      waitFor(
        async () => {
          assert.equal(await page.getByTestId("device-row").count(), expected);
        },
        45000,
        description,
      );
    const replay = async (proof) => {
      const response = await fetch(proof.url, { headers: proof.headers });
      const body = await response.json().catch(() => ({}));

      return { status: response.status, code: body.code };
    };
    const first = await openPage();
    const second = await openPage();

    await registerIdentity(first.page, origin, {
      name: `Forget A ${suffix}`,
      handle,
      password,
    });

    // The second device is a paired device of the identity. It signs out and
    // signs back in with the password: the path reported as failing for paired
    // devices.
    await pairDevice(origin, password, first.page, handle, second.page);
    await logOut(second.page);
    await second.page.getByTestId("auth-identity-input").fill(`@${handle}`);
    await second.page.getByTestId("auth-password-input").fill(password);
    await second.page.getByTestId("auth-submit-button").click();
    await visible(second.page, "create-conversation-button").waitFor({
      state: "visible",
    });
    await dismissPushPrompt(second.page);

    await openManageDevices(second.page);
    await expectDeviceRows(
      second.page,
      2,
      "second device does not list both devices",
    );
    assert.ok(second.proofs.length > 0, "no device-proof request was recorded");
    const signed = second.proofs.at(-1);
    const accepted = await replay(signed);

    assert.equal(
      accepted.status,
      200,
      `device-proof request before forgetting: status ${accepted.status}`,
    );
    await second.page
      .getByRole("button", { name: "Close dialog" })
      .last()
      .click();
    await second.page.getByTestId("device-list").waitFor({ state: "detached" });
    await second.page
      .getByRole("button", { name: "Close dialog" })
      .last()
      .click();
    await second.page
      .getByTestId("profile-save-button")
      .waitFor({ state: "detached" });

    await openSidebar(second.page);
    await visible(second.page, "own-profile-menu-button").click();
    await visible(second.page, "forget-device-button").click();
    await second.page
      .getByTestId("auth-identity-input")
      .waitFor({ state: "visible" });

    const refused = await replay(signed);

    assert.equal(
      refused.status,
      401,
      `device-proof request after forgetting: status ${refused.status}`,
    );
    assert.equal(
      refused.code,
      401020,
      `device-proof request after forgetting: code ${refused.code}`,
    );

    await openManageDevices(first.page);
    await expectDeviceRows(
      first.page,
      1,
      "first device does not list one device after the forget",
    );
  } finally {
    await browser.close();
  }
};

test(
  "UI flows work against a real node served by the application image",
  { timeout: 1800000 },
  async () => {
    assertTestInputs();
    const name = `pigeon-ui-e2e-${randomBytes(5).toString("hex")}`;

    try {
      const network = await startNode(name);
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

test(
  "a forgotten device is refused by the node and a second device signs in",
  { timeout: 900000 },
  async () => {
    assertTestInputs();
    const name = `pigeon-forget-e2e-${randomBytes(5).toString("hex")}`;

    try {
      await startNode(name);
      await assertDeviceForgetRevokesCredential(uiSource, origin);
    } catch (error) {
      await run("docker", ["logs", "--tail", "200", name]).catch(() => {});
      throw error;
    } finally {
      await run("docker", ["rm", "-fv", name]).catch(() => {});
    }
  },
);
