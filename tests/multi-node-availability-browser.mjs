import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import { createClientServer } from "../client/server.mjs";
import { startCallTestGateways } from "./call-test-https-proxy.mjs";

// Runs inside the browser container of tests/compose.two-node-call.yml, driven
// by tests/multi-node-availability.integration.mjs. Node A is Alice's home and
// node B is Bob's; the client build lists both nodes as availability servers,
// so each identity also keeps its inbox on the other node. The runner kills
// node A when this script prints the stop marker, and answers on stdin.
// Logs carry stages, ports, statuses and counts only: never message text,
// mailbox ids, tokens or envelope bodies.

const NODE_A = "https://localhost:8443";
const NODE_B = "https://localhost:8444";
const CLIENT = "http://127.0.0.1:8445";
const PASSWORD = "Disposable-availability-test-password1!";
const POLL_GRACE_MS = 20000;
const suffix = randomBytes(4).toString("hex");
const text = (label) => `${label} ${suffix}`;
const portOf = (url) => new URL(url).port;
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const envelopesPath = /^\/api\/mailboxes\/([^/]+)\/envelopes\/?$/;
const readersPath = /^\/api\/mailboxes\/([^/]+)\/readers\/[^/]+$/;
let stage = "startup";
const startedAt = Date.now();
const stdin = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

const waitFor = async (check, timeout, description) => {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
 * One browser context per device, connected to one node through the
 * independent client. Records each mailbox response by port, so the checks can
 * tell which node served a read or took an append. The read capability a
 * device presents is kept in memory for the replay check and never logged.
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
  const device = { name, node, page, reads: [], appends: [], readerRemovals: [], failures: [], readTokens: new Map() };
  page.on("request", async (request) => {
    const url = new URL(request.url());
    const match = url.pathname.match(envelopesPath);
    if (request.method() !== "GET" || !match || url.origin !== NODE_B) return;
    const authorization = (await request.allHeaders()).authorization;
    if (!/^Bearer \S+$/.test(authorization ?? "")) return;
    const tokens = device.readTokens.get(match[1]) ?? new Set();
    tokens.add(authorization);
    device.readTokens.set(match[1], tokens);
  });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    const method = response.request().method();
    const envelopes = url.pathname.match(envelopesPath);
    const entry = { at: Date.now(), stage, port: url.port, status: response.status() };
    if (envelopes && method === "GET") {
      const body = await response.json().catch(() => null);
      device.reads.push({ ...entry, mailbox: hash(envelopes[1]), count: Array.isArray(body?.envelopes) ? body.envelopes.length : null });
    } else if (envelopes && method === "POST") device.appends.push({ ...entry, mailbox: hash(envelopes[1]) });
    else if (readersPath.test(url.pathname) && method === "DELETE") device.readerRemovals.push(entry);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/mailboxes/")) return;
    device.failures.push({ at: Date.now(), stage, port: url.port, method: request.method() });
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
const openSecurity = async (page) => {
  if ((await visible(page, "create-conversation-button").count()) === 0) {
    await visible(page, "workspace-sidebar-open-button").click();
  }
  await visible(page, "own-profile-menu-button").click();
  await page.getByTestId("edit-profile-button").click();
  await page.getByRole("button", { name: "Security" }).click();
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
// Same UI steps as the pairing in tests/ui-e2e.integration.mjs.
const pair = async ({ page: authorized }, handle, { page: fresh }) => {
  await openSecurity(authorized);
  await authorized.getByTestId("profile-pair-device").click();
  const invitation = await authorized.getByTestId("device-pairing-invitation-output").inputValue();
  await fresh.getByTestId("auth-identity-input").fill(`@${handle}`);
  await fresh.getByTestId("auth-login-method-control").getByRole("button", { name: "New device" }).click();
  await fresh.getByTestId("auth-device-pairing-invitation-input").fill(invitation);
  await fresh.getByTestId("auth-device-pairing-prepare").click();
  const request = await fresh.getByTestId("auth-device-pairing-request-output").inputValue();
  const code = await fresh.getByTestId("auth-device-pairing-verification-code").innerText();
  await authorized.getByTestId("device-pairing-request-input").fill(request);
  await authorized.getByTestId("device-pairing-submit").click();
  await waitFor(
    async () => (await authorized.getByTestId("device-pairing-verification-code").innerText()) === code,
    45000,
    "Pairing verification codes differ",
  );
  await authorized.getByTestId("device-pairing-submit").click();
  const completion = authorized.getByTestId("device-pairing-completion-output");
  await completion.waitFor({ state: "visible" });
  await fresh.getByTestId("auth-device-pairing-completion-input").fill(await completion.inputValue());
  await fresh.getByTestId("auth-password-input").fill(PASSWORD);
  await fresh.getByTestId("auth-password-confirmation-input").fill(PASSWORD);
  await fresh.getByTestId("auth-submit-button").click();
  await visible(fresh, "create-conversation-button").waitFor();
  await dismissPushPrompt(fresh);
  await authorized.getByRole("button", { name: "Close dialog" }).last().click();
};
const closeDialog = async (page, markerTestId) => {
  await page
    .locator(".app-overlay-scrim", { has: page.getByTestId(markerTestId) })
    .last()
    .locator(".ui-dialog-header")
    .getByRole("button", { name: "Close dialog" })
    .click();
  await page.getByTestId(markerTestId).waitFor({ state: "detached" });
};
const rendered = (device, message) =>
  device.page.getByTestId("message-item").filter({ hasText: message, visible: true }).count();
const send = async (device, message) => {
  await device.page.getByTestId("message-composer-input").fill(message);
  await device.page.getByTestId("message-composer-input").press("Enter");
};
// Every device in `on` must render the message exactly once.
const expectRendered = async (on, message, timeout = 60000) => {
  for (const device of on)
    await waitFor(async () => (await rendered(device, message)) >= 1, timeout, `${device.name} did not render the message`);
  for (const device of on) assert.equal(await rendered(device, message), 1, `${device.name} rendered the message more than once`);
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
const summary = (device, since) => ({
  device: device.name,
  reads: device.reads.filter((entry) => entry.at >= since).map(({ at, mailbox, ...rest }) => ({ ...rest, at: at - startedAt })),
  appends: device.appends.filter((entry) => entry.at >= since).map(({ at, mailbox, ...rest }) => ({ ...rest, at: at - startedAt })),
  readerRemovals: device.readerRemovals.filter((entry) => entry.at >= since).map(({ at, ...rest }) => ({ ...rest, at: at - startedAt })),
  failures: device.failures.filter((entry) => entry.at >= since).map(({ at, ...rest }) => ({ ...rest, at: at - startedAt })),
});
let since = startedAt;

try {
  stage = "register";
  console.log(stage);
  const alice = await openDevice("alice-1", NODE_A);
  const bob = await openDevice("bob", NODE_B);
  const aliceHandle = `alice-${suffix}`;
  const bobHandle = `bob-${suffix}`;
  await register(alice, "Alice Availability", aliceHandle);
  await register(bob, "Bob Availability", bobHandle);

  stage = "replication between nodes";
  console.log(stage);
  const bobId = await remoteIdentityId(alice, NODE_A, bobHandle);
  await remoteIdentityId(bob, NODE_B, aliceHandle);
  const networkId = process.env.PIGEON_TEST_NETWORK_ID;
  assert.ok(networkId, "PIGEON_TEST_NETWORK_ID must be set by the runner");
  for (const [device, node] of [[alice, NODE_A], [bob, NODE_B]])
    await waitFor(
      () =>
        device.page.evaluate(
          async ({ node, networkId }) => {
            const response = await fetch(`${node}/api/peers/`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) return false;
            const network = (await response.json()).networkSynchronization?.networks?.find((entry) => entry.id === networkId);
            return network?.state === "converged" && network.connectedPeerIds?.length > 0 && network.totalStoreCount > 0;
          },
          { node, networkId },
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

  stage = "both nodes up";
  console.log(stage);
  const fromAlice = text("alice before outage");
  await send(alice, fromAlice);
  await expectRendered([bob, alice], fromAlice);
  const fromBob = text("bob before outage");
  await send(bob, fromBob);
  await expectRendered([alice, bob], fromBob);

  // The second device joins an existing conversation, as in the pairing check
  // of tests/ui-e2e.integration.mjs.
  stage = "pair second device";
  console.log(stage);
  const second = await openDevice("alice-2", NODE_A);
  await pair(alice, aliceHandle, second);
  if ((await visible(second.page, "create-conversation-button").count()) === 0)
    await visible(second.page, "workspace-sidebar-open-button").click();
  await second.page.getByTestId("conversation-list-item").filter({ hasText: "Bob Availability" }).first().click({ timeout: 60000 });
  await second.page.waitForFunction(
    () => document.querySelector('[data-testid="message-composer-input"]')?.disabled === false,
    undefined,
    { timeout: 60000 },
  );
  const fromBobPaired = text("bob after pairing");
  await send(bob, fromBobPaired);
  await expectRendered([alice, second, bob], fromBobPaired);

  // A sender appends to the servers its peer announced. Bob learns Alice's
  // servers from her announcement, an envelope in his inbox; the client keeps
  // the last one per inbox under this localStorage prefix (pigeon-swarm-ui
  // DirectMessageAvailabilityStore). Waiting on it only orders the steps; the
  // fan-out itself is checked on the wire below.
  stage = "availability announcement";
  console.log(stage);
  await waitFor(
    () =>
      bob.page.evaluate(
        (server) =>
          Object.keys(localStorage).some(
            (key) => key.includes("pigeon.direct-mailbox-servers.") && localStorage.getItem(key)?.includes(server),
          ),
        `${NODE_B}/api`,
      ),
    90000,
    "Bob never received Alice's availability announcement",
  );

  stage = "fan-out to home and availability server";
  console.log(stage);
  since = Date.now();
  const fannedOut = text("bob fanned out");
  await send(bob, fannedOut);
  await expectRendered([alice, second], fannedOut);
  const appendsToAlice = await waitFor(
    () => {
      const appends = bob.appends.filter((entry) => entry.at >= since && entry.status >= 200 && entry.status < 300);
      const byMailbox = Map.groupBy(appends, (entry) => entry.mailbox);
      const both = [...byMailbox.values()].find(
        (entries) => entries.some((entry) => entry.port === portOf(NODE_A)) && entries.some((entry) => entry.port === portOf(NODE_B)),
      );
      return both ?? false;
    },
    30000,
    "Bob's append did not land on both Alice's home and her availability server",
  );
  const aliceInbox = appendsToAlice[0].mailbox;
  await waitFor(
    () => second.reads.some((entry) => entry.at >= since && entry.port === portOf(NODE_B) && entry.status === 200),
    30000,
    "Alice's second device never read her inbox on the availability server",
  );
  const revokedTokens = [...second.readTokens.entries()].filter(([mailbox]) => hash(mailbox) === aliceInbox);
  assert.ok(revokedTokens.length > 0, "No read capability of the second device was observed on the availability server");
  console.log("Fan-out:", JSON.stringify([summary(bob, since)]));

  stage = "revoke second device";
  console.log(stage);
  await openSecurity(alice.page);
  await alice.page.getByTestId("profile-manage-devices").click();
  await waitFor(async () => (await alice.page.getByTestId("device-row").count()) === 2, 45000, "First device does not list both devices");
  await alice.page.getByTestId("device-revoke-open").click();
  await alice.page.getByTestId("device-revoke-confirm").click();
  await waitFor(async () => (await alice.page.getByTestId("device-row").count()) === 1, 45000, "First device still lists the revoked device");
  const revokedAt = Date.now();
  await closeDialog(alice.page, "device-list");
  // The revoke may already have closed the profile editor behind the list.
  if ((await alice.page.getByTestId("profile-save-button").count()) > 0) await closeDialog(alice.page, "profile-save-button");
  // The remaining device must keep reading the availability server under the
  // root the revoke rotated to.
  await waitFor(
    () => alice.reads.some((entry) => entry.at > revokedAt && entry.port === portOf(NODE_B) && entry.status === 200),
    60000,
    "Alice's remaining device did not read the availability server after the revoke",
  );
  console.log("Revoke:", JSON.stringify([summary(alice, revokedAt), summary(second, revokedAt)]));

  stage = "kill home node";
  console.log("STOP-HOME-NODE");
  const answer = await stdin.next();
  assert.equal(answer.value, "killed", "Runner did not kill node A");
  const killedAt = Date.now();
  since = killedAt;
  const homeStatus = await bob.page.evaluate(async (node) => {
    try {
      return (await fetch(`${node}/api/peers/`, { signal: AbortSignal.timeout(5000) })).status;
    } catch {
      return "unreachable";
    }
  }, NODE_A);
  assert.ok(homeStatus === 502 || homeStatus === "unreachable", `Node A still answers after the kill: ${homeStatus}`);

  stage = "home node down";
  console.log(stage);
  const duringOutage = text("bob during outage");
  await send(bob, duringOutage);
  await expectRendered([alice], duringOutage, 90000);
  assert.ok(
    alice.reads.some((entry) => entry.at >= killedAt && entry.port === portOf(NODE_B) && entry.status === 200 && entry.count > 0),
    "Alice's remaining device did not read the message from the availability server",
  );
  assert.ok(
    !alice.reads.some((entry) => entry.at >= killedAt && entry.port === portOf(NODE_A) && entry.status === 200),
    "A read on node A succeeded after the kill",
  );
  assert.ok(
    bob.appends.some((entry) => entry.at >= killedAt && entry.mailbox === aliceInbox && entry.port === portOf(NODE_B) && entry.status >= 200 && entry.status < 300),
    "Bob's append did not land on the availability server while Alice's home was down",
  );

  stage = "revoked device during outage";
  console.log(stage);
  await new Promise((resolve) => setTimeout(resolve, POLL_GRACE_MS));
  assert.equal(await rendered(second, duringOutage), 0, "The revoked device rendered a message sent after the revoke");
  const replay = (device, entries) =>
    Promise.all(
      entries.flatMap(([mailbox, tokens]) =>
        [...tokens].map((authorization) =>
          device.page.evaluate(
            async ({ url, authorization }) => {
              const response = await fetch(url, { headers: { authorization }, cache: "no-store" });
              const body = await response.json().catch(() => null);
              return { status: response.status, count: Array.isArray(body?.envelopes) ? body.envelopes.length : null };
            },
            { url: `${NODE_B}/api/mailboxes/${mailbox}/envelopes`, authorization },
          ),
        ),
      ),
    );
  const replays = await replay(second, revokedTokens);
  // Control: the same inbox on the same server still answers the remaining
  // device, so the refusal is specific to the revoked capabilities.
  const controls = await replay(alice, [...alice.readTokens.entries()].filter(([mailbox]) => hash(mailbox) === aliceInbox));
  console.log("Revoked capability replays on the availability server:", JSON.stringify(replays));
  console.log("Remaining device replays on the availability server:", JSON.stringify(controls));
  assert.ok(controls.some((control) => control.status === 200), "The availability server no longer serves the inbox to the remaining device");
  assert.ok(
    replays.every((entry) => entry.status === 404),
    "The availability server still serves the inbox to a read capability of the revoked device",
  );
  console.log("Outage:", JSON.stringify(devices.map((device) => summary(device, killedAt))));
  console.log("PASS multi-node availability");
} catch (error) {
  console.error(`Failed at stage: ${stage}`);
  console.error("Mailbox traffic:", JSON.stringify(devices.map((device) => summary(device, since))));
  throw error;
} finally {
  await browser.close().catch(() => {});
  await new Promise((resolve) => clientServer.close(resolve));
  await stopGateways();
  process.stdin.destroy();
}
