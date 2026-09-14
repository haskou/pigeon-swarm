import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
let stage = "configuration";
const sockets = [];
const joined = [];
let nodes = [];
let failure;
let success;

function headers(identity, method, path, body = {}) {
  const timestamp = Date.now();
  const payload = {
    bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    method,
    path,
    timestamp,
  };
  return {
    "content-type": "application/json",
    "x-identity-id": identity.id,
    "x-timestamp": String(timestamp),
    "x-signature": sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      identity.privateKey,
    ).toString("base64"),
  };
}

async function request(index, identity, method, route, body = {}) {
  const url = new URL(route, nodes[index]);
  const response = await fetch(url, {
    method,
    headers: headers(identity, method, url.pathname, body),
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} at node ${index + 1}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function eventually(label, operation, timeout = 55000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await operation()) return;
    } catch {}
    await pause(250);
  }
  throw new Error(`Timed out: ${label}`);
}

function connect(index, identity) {
  const url = new URL("ws", nodes[index]);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const auth = headers(identity, "GET", url.pathname);
  url.search = new URLSearchParams({
    identityId: identity.id,
    timestamp: auth["x-timestamp"],
    signature: auth["x-signature"],
  }).toString();
  const socket = new WebSocket(url);
  const state = { socket, messages: [], acknowledged: false, failed: false };
  sockets.push(state);
  socket.addEventListener("message", ({ data }) => {
    try {
      const message = JSON.parse(data);
      if (
        message.type === "connection_ack" &&
        message.identityId === identity.id
      )
        state.acknowledged = true;
      if (
        message.type === "domain_event" &&
        message.event?.type === "calls.v1.signal.sent"
      ) {
        state.messages.push(message.event);
        if (state.messages.length > 128) state.messages.shift();
      }
    } catch {
      state.failed = true;
    }
  });
  socket.addEventListener("error", () => {
    state.failed = true;
  });
  socket.addEventListener("close", () => {
    state.failed = true;
  });
  return state;
}

try {
  const configured = JSON.parse(process.env.RELAY_TEST_NODES || "null");
  check(
    Array.isArray(configured) &&
      configured.length >= 2 &&
      configured.length <= 8,
    "RELAY_TEST_NODES must contain 2 to 8 API base URLs",
  );
  nodes = configured.map((value) => {
    const url = new URL(value.endsWith("/") ? value : value + "/");
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "Invalid API base URL",
    );
    return url;
  });
  check(
    new Set(nodes.map(String)).size === nodes.length,
    "Node URLs must be distinct",
  );
  const networkId = process.env.RELAY_TEST_NETWORK_ID;
  const phase = process.env.RELAY_TEST_PHASE;
  check(
    typeof networkId === "string" && networkId.length > 0,
    "Missing network ID",
  );
  check(
    typeof phase === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(phase),
    "Invalid phase label",
  );
  check(
    typeof WebSocket === "function",
    "Node runtime requires native WebSocket",
  );
  const runId = randomUUID();
  const identities = nodes.map(() => {
    const pair = generateKeyPairSync("ed25519");
    return {
      privateKey: pair.privateKey,
      id: pair.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
    };
  });
  const owner = identities[0];
  const profile = {
    networkId,
    name: `Relay ${phase.slice(0, 24)} ${runId}`,
    description: `Fresh replicated profile ${randomUUID()}`,
    autoJoinEnabled: true,
    discoverable: false,
    visibility: "private",
  };
  stage = "create community";
  const community = await request(0, owner, "POST", "communities/", profile);
  check(typeof community?.id === "string", "Missing community ID");
  const communityRoute = `communities/${encodeURIComponent(community.id)}`;
  stage = "create voice channel";
  const channel = await request(
    0,
    owner,
    "POST",
    `${communityRoute}/channels/voice`,
    { name: "Relay probe" },
  );
  check(typeof channel?.id === "string", "Missing voice channel ID");
  stage = "admit participants";
  for (const identity of identities.slice(1))
    await request(0, identity, "POST", `${communityRoute}/join-requests`);
  const expected = await request(0, owner, "GET", communityRoute);
  check(
    expected.name === profile.name &&
      expected.description === profile.description &&
      expected.networkId === networkId &&
      expected.ownerIdentityId === owner.id &&
      identities.every((identity) =>
        expected.memberIds?.includes(identity.id),
      ) &&
      expected.voiceChannels?.some((item) => item.id === channel.id),
    "Source community did not preserve requested profile, roster and channel",
  );
  stage = "replicate complete community";
  await Promise.all(
    nodes.map((_, index) =>
      eventually(`community replica at node ${index + 1}`, async () =>
        isDeepStrictEqual(
          await request(index, identities[index], "GET", communityRoute),
          expected,
        ),
      ),
    ),
  );

  stage = "join replicated call";
  const callBody = {
    scopeType: "community_channel",
    communityId: community.id,
    channelId: channel.id,
  };
  let callId;
  for (const identity of identities) {
    const call = await request(0, identity, "POST", "calls/", callBody);
    check(
      typeof call?.id === "string" && (!callId || call.id === callId),
      "Participants did not join the same call",
    );
    callId = call.id;
    joined.push({ identity, callId });
  }
  const callRoute = `calls/${encodeURIComponent(callId)}`;
  await Promise.all(
    nodes.map((_, index) =>
      eventually(`call replica at node ${index + 1}`, async () => {
        const call = await request(index, identities[index], "GET", callRoute);
        return (
          call.id === callId &&
          call.networkId === networkId &&
          identities.every((identity) =>
            call.participants?.some(
              (p) => p.identityId === identity.id && p.status === "joined",
            ),
          )
        );
      }),
    ),
  );
  stage = "authenticate recipient sockets";
  const clients = identities.map((identity, index) => connect(index, identity));
  await Promise.all(
    clients.map((client, index) =>
      eventually(
        `socket acknowledgement at node ${index + 1}`,
        async () => !client.failed && client.acknowledged,
        15000,
      ),
    ),
  );

  for (let index = 0; index < nodes.length - 1; index++) {
    stage = `signal node ${index + 1} to ${index + 2}`;
    const nonce = randomUUID();
    const sentAt = Date.now();
    const delivery = await request(
      index,
      identities[index],
      "POST",
      `${callRoute}/signals`,
      {
        recipientIdentityId: identities[index + 1].id,
        signalType: "offer",
        payload: { phase, nonce, runId },
      },
    );
    check(
      typeof delivery?.signalId === "string",
      "Signal response did not contain a delivery ID",
    );
    const recipient = clients[index + 1];
    await eventually(
      `fresh signal at node ${index + 2}`,
      async () => {
        if (recipient.failed) return false;
        const event = recipient.messages.find((event) => {
          const value = event.attributes;
          return (
            event.aggregate_id === callId &&
            value?.signalId === delivery.signalId &&
            value.callId === callId &&
            value.networkId === networkId &&
            value.senderIdentityId === identities[index].id &&
            value.recipientIdentityId === identities[index + 1].id &&
            value.signalType === "offer" &&
            value.payload?.nonce === nonce &&
            value.payload?.runId === runId &&
            value.payload?.phase === phase &&
            value.sentAt >= sentAt - 5000 &&
            value.expiresAt > Date.now()
          );
        });
        if (!event) return false;
        recipient.socket.send(
          JSON.stringify({
            type: "call_signal_ack",
            signalId: delivery.signalId,
          }),
        );
        return true;
      },
      20000,
    );
  }
  success = `PASS relay traffic phase=${phase} nodes=${nodes.length} complete-community-replicas=${nodes.length} fresh-signals=${nodes.length - 1}`;
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      sockets: sockets.map((client) => ({
        acknowledged: client.acknowledged,
        failed: client.failed,
        signals: client.messages.length,
        eventFields: client.messages.length
          ? Object.keys(client.messages.at(-1))
          : [],
      })),
    }),
  );
  const detail =
    /^(HTTP [0-9]{3} at node [0-9]+|Timed out: [a-zA-Z0-9 ]+)$/.test(
      error?.message || "",
    )
      ? `: ${error.message}`
      : "";
  failure = `Relay traffic probe failed during ${stage}${detail}`;
} finally {
  for (const { identity, callId } of joined) {
    try {
      await request(
        0,
        identity,
        "DELETE",
        `calls/${encodeURIComponent(callId)}/participants/me`,
      );
    } catch {
      failure ||= "Relay traffic probe could not leave every call participant";
    }
  }
  for (const client of sockets) client.socket.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else console.log(success);
