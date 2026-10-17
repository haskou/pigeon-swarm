import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chromium } from "playwright";
import { createClientServer } from "../client/server.mjs";
import { startCallTestGateways } from "./call-test-https-proxy.mjs";

// Runs inside the browser container of tests/compose.two-node-call.yml, driven
// by tests/two-node-presence.integration.mjs. Node A is Alice's home and node B
// is Bob's. Each client publishes the node it is connected to as its mailbox
// home, so a contact's presence update must travel from the sender's page to
// the contact's home on the other node.
// Logs carry stages, ports, statuses and counts only: never statuses of a
// person, mailbox ids, tokens or envelope bodies.

const NODE_A = "https://localhost:8443";
const NODE_B = "https://localhost:8444";
const CLIENT = "http://127.0.0.1:8445";
const PASSWORD = "Disposable-presence-test-password1!";
// The labels the presence dot carries, as the English copy names them.
const STATUSES = ["Online", "Idle", "Do not disturb", "Offline", "Invisible"];
// A contact reads its presence inbox every 30 s, a sender refreshes every
// 45 s, and the page re-evaluates every 5 s.
const RECEIVE_MS = 90000;
// An update sent before the contact's inbox exists is refused, and the sender
// pauses that contact for two minutes before its next refresh.
const RECEIVE_AFTER_BACKOFF_MS = 240000;
// An update lives 90 s from its receipt, read up to 30 s after it was sent,
// and expiry is noticed within 5 s.
const EXPIRY_MS = 180000;
const suffix = randomBytes(4).toString("hex");
const portOf = (url) => new URL(url).port;
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const mailboxPath = /^\/api\/mailboxes\/([^/]+)\/?$/;
const envelopesPath = /^\/api\/mailboxes\/([^/]+)\/envelopes\/?$/;
let stage = "startup";
const startedAt = Date.now();

const waitFor = async (check, timeout, description, interval = 500) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`${description} (${stage})${lastError ? `: ${lastError.message}` : ""}`);
};

const { stop: stopGateways, spki } = await startCallTestGateways();
const clientServer = await createClientServer({ root: "/opt/pigeon/client-dist" });
clientServer.listen(8445, "127.0.0.1");
await once(clientServer, "listening");
const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
const devices = [];

/**
 * One browser context per user, connected to one node through the independent
 * client. Records every mailbox creation, read and append by port, with the
 * mailbox id hashed, so the checks can tell which node took a presence update.
 */
const openDevice = async (name, node) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("pigeon-swarm-language-v2", "en");
    localStorage.setItem("pigeon-swarm-language-explicit-v3", "true");
    if (window.PublicKeyCredential?.getClientCapabilities)
      Object.defineProperty(window.PublicKeyCredential, "getClientCapabilities", {
        configurable: true,
        value: undefined,
      });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const device = { name, node, page, creations: [], reads: [], appends: [] };
  page.on("response", (response) => {
    const url = new URL(response.url());
    const method = response.request().method();
    const entry = { at: Date.now(), stage, port: url.port, status: response.status() };
    const mailbox = url.pathname.match(mailboxPath);
    const envelopes = url.pathname.match(envelopesPath);
    if (mailbox && method === "PUT") device.creations.push({ ...entry, mailbox: hash(mailbox[1]) });
    else if (envelopes && method === "GET") device.reads.push({ ...entry, mailbox: hash(envelopes[1]) });
    else if (envelopes && method === "POST") device.appends.push({ ...entry, mailbox: hash(envelopes[1]) });
  });
  await page.goto(CLIENT);
  await page.getByLabel("Node address").fill(`${node}/api`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("link", { name: "Change node", exact: true }).waitFor();
  devices.push(device);
  return device;
};

const visible = (page, testId) => page.getByTestId(testId).filter({ visible: true }).first();
const dismissPushPrompt = async (page) => {
  const dismiss = visible(page, "push-notification-dismiss-button");
  if ((await dismiss.count()) > 0) await dismiss.click();
};
const register = async ({ page }, name, handle) => {
  await page.getByTestId("auth-mode-control").locator("button").nth(1).click();
  await page.getByTestId("auth-name-input").fill(name);
  await page.getByTestId("auth-handle-input").fill(handle);
  await page.getByTestId("auth-password-input").fill(PASSWORD);
  await page.getByTestId("auth-password-confirmation-input").fill(PASSWORD);
  await page.getByTestId("auth-recovery-key-confirm").click();
  await page.getByTestId("auth-submit-button").click();
  await visible(page, "create-conversation-button").waitFor();
  await dismissPushPrompt(page);
};
const remoteIdentityId = (device, node, handle) =>
  waitFor(
    () =>
      device.page.evaluate(
        async ({ node, handle }) => {
          const response = await fetch(`${node}/api/identities/${handle}`, { signal: AbortSignal.timeout(5000) });
          if (response.status !== 200) return false;
          const identity = await response.json();
          return typeof identity?.id === "string" ? identity.id : false;
        },
        { node, handle },
      ),
    60000,
    "Identity was not replicated to the other node",
  );
const conversationRow = ({ page }, title) =>
  page.getByTestId("conversation-list-item").filter({ hasText: title }).first();
/** The presence labels shown on a conversation row. */
const contactStatuses = async (row) => {
  const titles = await row.locator("[title]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("title") ?? ""),
  );
  return titles.filter((title) => STATUSES.includes(title));
};
const statusesEqual = async (row, expected) =>
  JSON.stringify(await contactStatuses(row)) === JSON.stringify(expected);
/**
 * Turns on "Share status" in the open conversation, and waits until the choice
 * is sealed on the device and the menu offers to stop it.
 */
const shareStatus = async ({ page }) => {
  const menu = page.getByRole("button", { name: "Open conversation menu", exact: true });
  await menu.click();
  await page.getByRole("button", { name: "Share status", exact: true }).click();
  await waitFor(
    async () => {
      await menu.click();
      const stop = page.getByRole("button", { name: "Stop sharing status", exact: true });
      const shared = await stop.waitFor({ state: "visible", timeout: 2000 }).then(
        () => true,
        () => false,
      );
      await page.keyboard.press("Escape");
      return shared;
    },
    30000,
    "Sharing was not turned on",
  );
};
const selectOwnStatus = async ({ page }, status) => {
  await visible(page, "own-profile-menu-button").click();
  const select = page.getByRole("button", { name: "Select status" });
  await select.click();
  await page.getByRole("option", { name: status, exact: true }).click();
  await waitFor(async () => (await select.innerText()).includes(status) && (await select.isEnabled()), 30000, "Own status was not applied");
  await page.keyboard.press("Escape");
};
const ok = (entry) => (entry.status >= 200 && entry.status < 300) || entry.status === 409;
/** The mailboxes a device created on its own node: its inboxes live there. */
const inboxesOf = (device) =>
  new Set(
    device.creations
      .filter((entry) => entry.port === portOf(device.node) && ok(entry))
      .map((entry) => entry.mailbox),
  );
/**
 * Waits until the device created an inbox on its own node after `since` and
 * read it: turning on sharing creates and reads the presence inbox.
 */
const inboxOpened = (device, since) =>
  waitFor(
    () =>
      device.reads.some(
        (entry) =>
          entry.at >= since &&
          entry.status === 200 &&
          device.creations.some(
            (created) =>
              created.at >= since &&
              created.port === portOf(device.node) &&
              ok(created) &&
              created.mailbox === entry.mailbox,
          ),
      ),
    60000,
    "No inbox was created and read on the home node",
  );
/**
 * After the sender turns on sharing it appends nothing but presence updates.
 * They must land in an inbox the contact created on its home node, and never
 * be accepted on the sender's own node. An update refused before the inbox
 * existed is retried on the sender's node, which refuses it too, so only
 * accepted appends are held to the home node.
 */
const assertDeliveredToHome = (sender, contact, since) => {
  const inboxes = inboxesOf(contact);
  const home = portOf(contact.node);
  const appends = sender.appends.filter((entry) => entry.at >= since);
  const landed = (entry) => entry.status >= 200 && entry.status < 300;
  console.log(
    `${sender.name} appends since sharing:`,
    JSON.stringify(
      appends.map(({ port, status, mailbox }) => ({ port, status, contactInbox: inboxes.has(mailbox) })),
    ),
  );
  assert.ok(
    appends.some((entry) => entry.port === home && landed(entry) && inboxes.has(entry.mailbox)),
    `${sender.name}'s presence update did not land in the contact's inbox on its home node`,
  );
  assert.ok(
    !appends.some((entry) => entry.port !== home && landed(entry)),
    `${sender.name}'s presence update was accepted on a node other than the contact's home`,
  );
};
const summary = (device, since) => ({
  device: device.name,
  creations: device.creations
    .filter((entry) => entry.at >= since)
    .map(({ port, status, stage }) => ({ port, status, stage })),
  appends: device.appends.filter((entry) => entry.at >= since).map(({ port, status }) => ({ port, status })),
  reads: device.reads.filter((entry) => entry.at >= since).length,
});

try {
  stage = "register";
  console.log(stage);
  const alice = await openDevice("alice", NODE_A);
  const bob = await openDevice("bob", NODE_B);
  const aliceName = "Alice Presence";
  const bobName = "Bob Presence";
  await register(alice, aliceName, `alice-${suffix}`);
  await register(bob, bobName, `bob-${suffix}`);

  stage = "replication between nodes";
  console.log(stage);
  const bobId = await remoteIdentityId(alice, NODE_A, `bob-${suffix}`);
  await remoteIdentityId(bob, NODE_B, `alice-${suffix}`);
  const networkId = process.env.PIGEON_TEST_NETWORK_ID;
  assert.ok(networkId, "PIGEON_TEST_NETWORK_ID must be set by the runner");
  for (const device of [alice, bob])
    await waitFor(
      () =>
        device.page.evaluate(
          async ({ node, networkId }) => {
            const response = await fetch(`${node}/api/peers`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) return false;
            const network = (await response.json()).networkSynchronization?.networks?.find((entry) => entry.id === networkId);
            return network?.state === "converged" && network.connectedPeerIds?.length > 0 && network.totalStoreCount > 0;
          },
          { node: device.node, networkId },
        ),
      60000,
      "Private network did not converge",
    );

  stage = "direct conversation";
  console.log(stage);
  await visible(alice.page, "create-conversation-button").click();
  await alice.page.getByTestId("create-conversation-recipient-input").fill(bobId);
  await alice.page.getByTestId("create-conversation-submit-button").click();
  await alice.page.getByTestId("create-conversation-recipient-input").waitFor({ state: "hidden" });
  await bob.page.locator('[data-testid="notifications-open-button"]:visible').first().click();
  const accept = bob.page.getByTestId("notification-accept-button").first();
  await accept.waitFor({ state: "visible", timeout: 60000 });
  await accept.click();
  for (const device of [alice, bob])
    await device.page.waitForFunction(
      () => document.querySelector('[data-testid="message-composer-input"]')?.disabled === false,
      undefined,
      { timeout: 60000 },
    );
  const aliceOnBob = conversationRow(bob, aliceName);
  const bobOnAlice = conversationRow(alice, bobName);
  assert.deepEqual(await contactStatuses(aliceOnBob), [], "A status was shown before sharing was turned on");

  // Bob shares first and waits until he has opened an inbox on node B, so
  // Alice's first update is likely to find his presence inbox.
  stage = "bob shares";
  console.log(stage);
  const bobSharedAt = Date.now();
  await shareStatus(bob);
  await inboxOpened(bob, bobSharedAt);
  await waitFor(() => statusesEqual(aliceOnBob, ["Offline"]), RECEIVE_MS, "Bob does not show Alice offline before she shares", 2000);

  stage = "alice shares";
  console.log(stage);
  const aliceSharedAt = Date.now();
  await shareStatus(alice);
  await inboxOpened(alice, aliceSharedAt);

  stage = "bob sees alice online";
  console.log(stage);
  await waitFor(() => statusesEqual(aliceOnBob, ["Online"]), RECEIVE_MS, "Bob does not see Alice online", 2000);
  assertDeliveredToHome(alice, bob, aliceSharedAt);

  // Bob's first update reached node A before Alice's inbox existed, so his
  // client paused before refreshing it.
  stage = "alice sees bob online";
  console.log(stage);
  await waitFor(() => statusesEqual(bobOnAlice, ["Online"]), RECEIVE_AFTER_BACKOFF_MS, "Alice does not see Bob online", 2000);
  assertDeliveredToHome(bob, alice, bobSharedAt);

  // Invisible sends nothing: Bob sees Alice's last update expire, and never
  // learns that she chose to be invisible.
  stage = "alice goes invisible";
  console.log(stage);
  await selectOwnStatus(alice, "Invisible");
  const seen = new Set();
  await waitFor(
    async () => {
      const statuses = await contactStatuses(aliceOnBob);
      for (const status of statuses) seen.add(status);
      return JSON.stringify(statuses) === JSON.stringify(["Offline"]);
    },
    EXPIRY_MS,
    "Bob does not see invisible Alice offline",
    2000,
  );
  assert.deepEqual(
    [...seen].filter((status) => status !== "Online"),
    ["Offline"],
    "Bob saw a status other than online and offline for Alice",
  );
  console.log("Presence traffic:", JSON.stringify(devices.map((device) => summary(device, bobSharedAt))));
  console.log("PASS two-node contact presence");
} catch (error) {
  console.error(`Failed at stage: ${stage}`);
  console.error("Presence traffic:", JSON.stringify(devices.map((device) => summary(device, startedAt))));
  throw error;
} finally {
  await browser.close().catch(() => {});
  await new Promise((resolve) => clientServer.close(resolve));
  await stopGateways();
}
