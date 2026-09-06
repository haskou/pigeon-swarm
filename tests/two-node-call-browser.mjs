import assert from "node:assert/strict";
import { once } from "node:events";
import { createClientServer } from "../client/server.mjs";
import { chromium } from "playwright";
import { startCallTestGateways } from "./call-test-https-proxy.mjs";

let stage = "browser startup";
const urls = ["https://localhost:8443", "https://localhost:8444"];
const relayAddresses = [process.env.TEST_IP_A, process.env.TEST_IP_B];
const { stop: stopGateways, spki } = await startCallTestGateways();
const independentClient = process.env.PIGEON_INDEPENDENT_CLIENT === "true";
const clientServer = independentClient ? await createClientServer({root: "/opt/pigeon/client-dist"}) : undefined;
if (clientServer) {
  clientServer.listen(8445, '127.0.0.1');
  await once(clientServer, 'listening');
}
const stopClient = async () => { if (clientServer) await new Promise(resolve => clientServer.close(resolve)); };
const pages = [];
const browser = await chromium
  .launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  })
  .catch(async () => {
    await stopClient();
    await stopGateways();
    throw new Error("Test browser startup failed");
  });
try {
  for (const [index, url] of urls.entries()) {
    const context = await browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript((expectedRelay) => {
      localStorage.setItem("pigeon-swarm-language-v2", "en");
      localStorage.setItem("pigeon-swarm-language-explicit-v3", "true");
      if (window.PublicKeyCredential?.getClientCapabilities)
        Object.defineProperty(
          window.PublicKeyCredential,
          "getClientCapabilities",
          { configurable: true, value: undefined },
        );
      const Original = window.RTCPeerConnection;
      window.callProbePeers = [];
      window.RTCPeerConnection = class extends Original {
        constructor(configuration, ...rest) {
          const iceServers = (configuration?.iceServers || []).flatMap(
            (server) => {
              const urls = (
                Array.isArray(server.urls) ? server.urls : [server.urls]
              ).filter(
                (url) =>
                  url === `turn:${expectedRelay}:4101?transport=udp` ||
                  url === `turn:${expectedRelay}:4101`,
              );
              return urls.length ? [{ ...server, urls }] : [];
            },
          );
          super(
            { ...configuration, iceServers, iceTransportPolicy: "relay" },
            ...rest,
          );
          window.callProbePeers.push(this);
        }
      };
    }, relayAddresses[index]);
    const page = await context.newPage();
    page.on("response", async (response) => {
      if (
        response.status() >= 400 &&
        new URL(response.url()).pathname === "/api/identities/"
      ) {
        const body = await response.json().catch(() => ({}));
        console.log(
          "Identity registration response",
          response.status(),
          /^[A-Za-z]+Error$/.test(body.code || "")
            ? body.code
            : "no domain error code",
        );
      }
    });
    page.setDefaultTimeout(45000);
    pages.push(page);
    stage = `register user ${index + 1}`;
    console.log(stage);
    await page.goto(independentClient ? 'http://127.0.0.1:8445' : url);
    if (independentClient) {
      await page.getByLabel('Node address').fill(url + '/api');
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('link', { name: 'Change node', exact: true }).waitFor();
    }
    assert.ok(
      await page.evaluate(
        () => isSecureContext && Boolean(globalThis.crypto?.subtle),
      ),
      "Registration requires a secure browser context",
    );
    stage = `registration mode ${index + 1}`;
    await page
      .getByTestId("auth-mode-control")
      .locator("button")
      .nth(1)
      .click();
    await page.getByTestId("auth-name-input").fill(`Caller ${index + 1}`);
    await page.getByTestId("auth-handle-input").fill(`caller-${index + 1}`);
    await page
      .getByTestId("auth-password-input")
      .fill("Disposable-call-test-password1!");
    await page
      .getByTestId("auth-password-confirmation-input")
      .fill("Disposable-call-test-password1!");
    await page.getByTestId("auth-recovery-key-confirm").click();
    const passkey = page.getByTestId("auth-passkey-prf-toggle");
    if (
      (await passkey.isEnabled()) &&
      (await passkey.getAttribute("aria-pressed")) === "true"
    )
      await passkey.click();
    stage = `registration submit ${index + 1}`;
    await page.getByTestId("auth-submit-button").click();
    stage = `workspace after registration ${index + 1}`;
    await page.getByTestId("create-conversation-button").first().waitFor();
    if (await page.getByTestId("push-notification-dismiss-button").isVisible())
      await page.getByTestId("push-notification-dismiss-button").click();
  }
  stage = "identity replication between nodes";
  const replicatedIdentityIds = [];
  for (const [index, page] of pages.entries()) {
    const deadline = Date.now() + 60000;
    let identityId;
    while (Date.now() < deadline) {
      identityId = await page.evaluate(
        async ({handle, nodeUrl}) => {
          const response = await fetch(`${nodeUrl}/api/identities/${handle}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (response.status !== 200) return null;
          const identity = await response.json();
          return typeof identity?.id === "string" ? identity.id : null;
        },
        {handle: `caller-${2 - index}`, nodeUrl: urls[index]},
      );
      if (identityId) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(
      typeof identityId,
      "string",
      "Remote identity must be replicated before opening the conversation",
    );
    replicatedIdentityIds.push(identityId);
  }
  stage = "cross-node conversation invitation";
  console.log(stage);
  await pages[0].getByTestId("create-conversation-button").first().click();
  const recipientId = replicatedIdentityIds[0];
  assert.equal(typeof recipientId, "string");
  await pages[0]
    .getByTestId("create-conversation-recipient-input")
    .fill(recipientId);
  stage = "resolve conversation recipient";
  await pages[0].getByTestId("create-conversation-submit-button").click();
  stage = "persist direct conversation";
  await pages[0]
    .getByTestId("create-conversation-recipient-input")
    .waitFor({ state: "hidden" });
  stage = "replicate direct conversation";
  await pages[1].getByTestId("conversation-list-item").first().click();
  await pages[1].getByTestId("message-composer-input").waitFor();
  if (independentClient) {
    stage = "accept encrypted conversation invitation";
    await pages[1].getByTestId("notifications-open-button").first().click();
    await pages[1].getByTestId("notification-accept-button").click();
    await pages[1].waitForFunction(
      () => !document.querySelector('[data-testid="message-composer-input"]').disabled,
    );
    await pages[0].bringToFront();
    await pages[0].getByTestId("message-composer-input").fill("Independent client message");
    await pages[0].getByTestId("message-composer-input").press("Enter");
    await pages[0].getByText("Independent client message", { exact: true }).first().waitFor();
    await pages[1].bringToFront();
    await pages[1].getByText("Independent client message", { exact: true }).first().waitFor();
    console.log("PASS independent client message decryption");
  }
  stage = "application call signalling";
  console.log(stage);
  await pages[0]
    .getByRole("button", { name: "Open conversation menu", exact: true })
    .click();
  await pages[0]
    .getByRole("button", { name: "Start call", exact: true })
    .click();
  await pages[1].getByRole("button", { name: "Answer", exact: true }).click();
  const assertAudio = async (label) => {
    stage = label;
    const sample = (page) =>
      page.evaluate(async () => {
        const peer = window.callProbePeer;
        if (!peer || peer.connectionState !== "connected") return null;
        const stats = await peer.getStats();
        const transport = [...stats.values()].find(
          (stat) => stat.type === "transport" && stat.selectedCandidatePairId,
        );
        const pair = transport && stats.get(transport.selectedCandidatePairId);
        const inbound = [...stats.values()].filter(
          (stat) => stat.type === "inbound-rtp" && stat.kind === "audio",
        );
        return {
          local: pair && stats.get(pair.localCandidateId)?.candidateType,
          remote: pair && stats.get(pair.remoteCandidateId)?.candidateType,
          localAddress: pair && stats.get(pair.localCandidateId)?.address,
          remoteAddress: pair && stats.get(pair.remoteCandidateId)?.address,
          bytes: inbound.reduce(
            (sum, entry) => sum + (entry.bytesReceived || 0),
            0,
          ),
          packets: inbound.reduce(
            (sum, entry) => sum + (entry.packetsReceived || 0),
            0,
          ),
        };
      });
    for (const page of pages)
      await page.waitForFunction(
        () =>
          window.callProbePeers.some(
            (peer) => peer.connectionState === "connected",
          ),
        null,
        { timeout: 60000 },
      );
    for (const page of pages)
      assert.equal(
        await page.evaluate(() => {
          const peers = window.callProbePeers.filter(
            (peer) => peer.connectionState === "connected",
          );
          window.callProbePeer = peers[0];
          return peers.length;
        }),
        1,
        "Exactly one connected call peer must be sampled",
      );
    const before = await Promise.all(pages.map(sample));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await Promise.all(pages.map(sample));
    for (let index = 0; index < 2; index++) {
      assert.equal(after[index]?.local, "relay");
      assert.equal(after[index]?.remote, "relay");
      assert.equal(after[index]?.localAddress, relayAddresses[index]);
      assert.equal(after[index]?.remoteAddress, relayAddresses[1 - index]);
      assert.ok(after[index].bytes > before[index].bytes);
      assert.ok(after[index].packets > before[index].packets);
    }
    console.log(
      `PASS ${label}: distinct relay addresses; inbound audio packet deltas ${after.map((entry, index) => entry.packets - before[index].packets).join("/")}`,
    );
  };
  await assertAudio("direct call");
  await pages[0].getByTestId("compact-call-bar").click();
  await pages[0]
    .getByRole("button", { name: "Leave call", exact: true })
    .click();
  for (const page of pages)
    await page.waitForFunction(() =>
      window.callProbePeers.every((peer) => peer.connectionState === "closed"),
    );

  stage = "community voice channel setup";
  await pages[0]
    .getByRole("button", { name: "Add community", exact: true })
    .click();
  stage = "community create tab";
  await pages[0].getByRole("button", { name: "Create", exact: true }).click();
  stage = "community profile";
  await pages[0]
    .getByRole("textbox", { name: "Community name", exact: true })
    .fill("Relay voice test");
  await pages[0].getByRole("button", { name: /^Public community/ }).click();
  stage = "community instant join";
  await pages[0].getByText("Allow instant join", { exact: true }).click();
  stage = "community initial voice channel";
  await pages[0]
    .getByPlaceholder("Channel name", { exact: true })
    .fill("voice-test");
  await pages[0].getByRole("button", { name: "Channels", exact: true }).click();
  await pages[0].getByRole("option", { name: "Voice", exact: true }).click();
  await pages[0]
    .getByRole("button", { name: "Add channel", exact: true })
    .click();
  await pages[0]
    .getByRole("button", { name: "Create community", exact: true })
    .click();
  stage = "community creation completion";
  await pages[0]
    .getByRole("textbox", { name: "Community name", exact: true })
    .waitFor({ state: "hidden" });
  await pages[1]
    .getByRole("button", { name: "Add community", exact: true })
    .click();
  stage = "community discovery and membership";
  await pages[1]
    .getByRole("button", { name: "Join instantly", exact: true })
    .click();
  stage = "community voice signalling";
  for (const page of pages) {
    await page
      .getByRole("button", { name: "Relay voice test", exact: true })
      .click();
    await page
      .getByTitle(/Join (voice|voice channel)/i)
      .filter({ hasText: "voice-test" })
      .click();
  }
  await assertAudio("community voice call");
  console.log(
    "PASS two-node call: direct and community voice calls through application signalling.",
  );
} catch (error) {
  console.log(
    "Failure location:",
    error?.name,
    error?.stack
      ?.split("\n")
      .find((line) => line.includes("/opt/pigeon/tests/")),
  );
  if (error?.name === "TimeoutError")
    console.log(
      "Timed out control:",
      error.message.split("\n").find((line) => line.includes("waiting for")),
    );
  for (const page of pages)
    console.log(
      "Visible test controls:",
      await page
        .locator("[data-testid]:visible")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-testid")),
        )
        .catch(() => []),
    );
  console.error(
    `FAIL two-node call: ${stage}. Response bodies and browser logs withheld.`,
  );
  process.exitCode = 1;
} finally {
  try {
    await browser.close();
  } finally {
    await stopClient();
    await stopGateways();
  }
}
