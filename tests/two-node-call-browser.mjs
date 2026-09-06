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
const deliveryDiagnostics = [];
const callDiagnostics = [];
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
      window.callProbeErrors = [];
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
          for (const method of ["setLocalDescription", "setRemoteDescription", "addIceCandidate", "createOffer", "createAnswer"]) {
            const original = this[method].bind(this);
            this[method] = async (...args) => {
              try { return await original(...args); }
              catch (error) {
                window.callProbeErrors.push({ method, name: error.name, state: this.signalingState });
                throw error;
              }
            };
          }
        }
      };
    }, relayAddresses[index]);
    const page = await context.newPage();
    const callEvents = [];
    callDiagnostics.push(callEvents);
    page.on("console", async message => {
      const args = message.args();
      if (args.length < 2 || await args[0].jsonValue().catch(() => null) !== "[pigeon:calls]") return;
      const event = await args[1].jsonValue().catch(() => null);
      if (typeof event !== "string" || !/^[a-z:-]+$/.test(event)) return;
      const errorName = args[2] && await args[2].evaluate(context => context?.error?.name).catch(() => undefined);
      callEvents.push({ stage, event, errorName: typeof errorName === "string" && /^[A-Za-z]+Error$/.test(errorName) ? errorName : undefined });
      if (callEvents.length > 80) callEvents.shift();
    });
    const diagnostics = {
      connectionAcks: 0,
      conversationEvents: 0,
      listResponses: [],
      callErrors: [],
    };
    deliveryDiagnostics.push(diagnostics);
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          if (message.type === "connection_ack") diagnostics.connectionAcks++;
          if (
            message.type === "domain_event" &&
            message.event?.type === "conversations.v1.conversation.was_created"
          )
            diagnostics.conversationEvents++;
        } catch {}
      });
    });
    page.on("response", async (response) => {
      if (response.status() >= 400 && new URL(response.url()).pathname.startsWith("/api/calls/")) {
        const body = await response.json().catch(() => ({}));
        diagnostics.callErrors.push({ stage, status: response.status(), code: /^[A-Za-z]+Error$/.test(body.code || "") ? body.code : "unknown" });
        console.log("Call HTTP error:", JSON.stringify(diagnostics.callErrors.at(-1)));
        if (diagnostics.callErrors.length > 10) diagnostics.callErrors.shift();
      }
      if (
        new URL(response.url()).pathname === "/api/conversations/" &&
        response.request().method() === "GET"
      ) {
        const body = await response.json().catch(() => undefined);
        diagnostics.listResponses.push({
          status: response.status(),
          count: Array.isArray(body?.conversations) ? body.conversations.length : null,
        });
        if (diagnostics.listResponses.length > 8) diagnostics.listResponses.shift();
      }
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
  stage = "accept encrypted conversation invitation";
  await pages[1].getByTestId("notifications-open-button").first().click();
  await pages[1].getByTestId("notification-accept-button").click();
  await pages[1].waitForFunction(
    () => !document.querySelector('[data-testid="message-composer-input"]').disabled,
  );
  stage = "bidirectional message decryption";
  const deliver = async (sender, text) => {
    await sender.bringToFront();
    await sender.getByTestId("message-composer-input").fill(text);
    await sender.getByTestId("message-composer-input").press("Enter");
    for (const page of pages)
      await page.getByText(text, { exact: true }).first().waitFor();
  };
  await deliver(pages[0], "Encrypted message from caller one");
  await deliver(pages[1], "Encrypted message from caller two");
  console.log(
    "PASS encrypted DM invitation acceptance and bidirectional message decryption",
  );
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
  stage = "community text delivery";
  for (const page of pages) {
    await page.getByRole("button", { name: "Relay voice test", exact: true }).click();
    await page.getByRole("button", { name: "# general", exact: true }).click();
  }
  await deliver(pages[0], "Community message from caller one");
  await deliver(pages[1], "Community message from caller two");
  console.log("PASS community membership and bidirectional text delivery");
  stage = "community voice signalling";
  const joinVoice = (page) =>
    page
      .getByTitle(/Join (voice|voice channel)/i)
      .filter({ hasText: "voice-test" })
      .click();
  const leaveVoice = async (page) => {
    await page.getByTestId("compact-call-bar").click();
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
  };
  const expectVoiceParticipants = (page, count) =>
    page.waitForFunction(
      (expected) => document.querySelectorAll("[data-testid=voice-channel-participant]").length === expected,
      count,
    );
  for (const page of pages) {
    await page
      .getByRole("button", { name: "Relay voice test", exact: true })
      .click();
    await joinVoice(page);
  }
  await assertAudio("community voice call");
  for (const page of pages) await expectVoiceParticipants(page, 2);
  for (let cycle = 1; cycle <= 3; cycle++) {
    stage = `community voice leave ${cycle}`;
    for (const page of pages) await leaveVoice(page);
    for (const page of pages)
      await page.waitForFunction(() =>
        window.callProbePeers.every((peer) => peer.connectionState === "closed"),
      );
    for (const page of pages) await expectVoiceParticipants(page, 0);
    stage = `community voice rejoin ${cycle}`;
    for (const page of pages) await joinVoice(page);
    await assertAudio(`community voice rejoin ${cycle}`);
  }
  stage = "community voice presence removal";
  for (const page of pages) await leaveVoice(page);
  for (const page of pages)
    await page.waitForFunction(() =>
      window.callProbePeers.every((peer) => peer.connectionState === "closed"),
    );
  for (const page of pages) {
    await page.reload();
    await page.getByTestId("own-profile-menu-button").waitFor();
    if (await page.getByTestId("push-notification-dismiss-button").isVisible())
      await page.getByTestId("push-notification-dismiss-button").click();
    await page
      .getByRole("button", { name: "Relay voice test", exact: true })
      .click();
    await page
      .getByTitle(/Join (voice|voice channel)/i)
      .filter({ hasText: "voice-test" })
      .waitFor();
    await expectVoiceParticipants(page, 0);
    assert.equal(
      await page.getByTitle(/Join (voice|voice channel)/i).filter({ hasText: "voice-test" }).innerText(),
      "voice-test",
      "Fresh channel reads must not show disconnected participants",
    );
  }
  stage = "password login and persisted message decryption";
  for (const [index, page] of pages.entries()) {
    await page.getByTestId("own-profile-menu-button").click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await page.getByTestId("auth-identity-input").fill(`caller-${index + 1}`);
    await page.getByTestId("auth-password-input").fill("Disposable-call-test-password1!");
    await page.getByTestId("auth-submit-button").click();
    await page.getByTestId("own-profile-menu-button").waitFor();
    if (await page.getByTestId("push-notification-dismiss-button").isVisible())
      await page.getByTestId("push-notification-dismiss-button").click();
    await page.getByRole("button", { name: "Open messages workspace", exact: true }).click();
    await page.getByTestId("conversation-list-item").first().click();
    await page.getByText("Encrypted message from caller one", { exact: true }).first().waitFor();
    await page.getByText("Encrypted message from caller two", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Relay voice test", exact: true }).click();
    await page.getByRole("button", { name: "# general", exact: true }).click();
    await page.getByText("Community message from caller one", { exact: true }).first().waitFor();
    await page.getByText("Community message from caller two", { exact: true }).first().waitFor();
    await joinVoice(page);
  }
  await assertAudio("community voice after password login");
  for (const page of pages) await expectVoiceParticipants(page, 2);
  stage = "abrupt client departure";
  const returningContext = pages[1].context();
  await returningContext.setOffline(true);
  await pages[1].close();
  await expectVoiceParticipants(pages[0], 1);
  await leaveVoice(pages[0]);
  await expectVoiceParticipants(pages[0], 0);
  await returningContext.setOffline(false);
  pages[1] = await returningContext.newPage();
  pages[1].setDefaultTimeout(45000);
  await pages[1].goto(independentClient ? 'http://127.0.0.1:8445' : urls[1]);
  await pages[1].getByTestId("own-profile-menu-button").waitFor();
  await pages[1].getByRole("button", { name: "Relay voice test", exact: true }).click();
  await expectVoiceParticipants(pages[1], 0);
  console.log("PASS password login, retained community history, and presence expiry after abrupt client departure");
  console.log(
    "PASS two-node call: direct and community voice calls, voice rejoin, and presence removal through application signalling.",
  );
} catch (error) {
  console.log("WebRTC operation errors:", JSON.stringify(await Promise.all(pages.map(page => page.evaluate(() => window.callProbeErrors).catch(() => [])))));
  console.log("Call lifecycle events:", JSON.stringify(callDiagnostics));
  console.log("WebRTC lifecycle diagnostics:", JSON.stringify(await Promise.all(pages.map(page => page.evaluate(() =>
    window.callProbePeers.map(peer => ({
      connection: peer.connectionState,
      ice: peer.iceConnectionState,
      signalling: peer.signalingState,
      localDescription: peer.localDescription?.type,
      remoteDescription: peer.remoteDescription?.type,
      tracks: peer.getSenders().map(sender => sender.track?.readyState),
    })),
  ).catch(() => [])))));
  console.log(
    "Conversation delivery diagnostics:",
    JSON.stringify(deliveryDiagnostics),
  );
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
