// Client side of the node's signed-mutation contract for deployment probes.
//
// The key handling and signatures come from the published
// @haskou/pigeon-swarm-crypto package. The record shapes, digests and request
// authentication mirror the UI (PublicMutationSigner, CommunityOperationSigner,
// CommunityModerationLogSigner and RequestSigner), and the node verifies them,
// so any divergence fails against a real node instead of passing silently.
//
// The module is meant to run inside a Pigeon container (working directory
// /app), where the crypto package is installed next to the node itself.
import { randomBytes } from "node:crypto";

import { KeyPair, SHA256Hash } from "@haskou/pigeon-swarm-crypto";

const MUTATION_DOMAIN = "pigeon:public-mutation:v1\n";
const FIRST_POSITION = { predecessor: null, sequence: 0 };

export class HttpError extends Error {
  constructor(status, bodyText) {
    super(`HTTP ${status}`);
    this.status = status;
    this.bodyText = bodyText;
  }
}

const base64Url = (bytes) =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const sha256 = (content) => SHA256Hash.from(content).toString();
const sha256Url = (content) => base64Url(Buffer.from(sha256(content), "hex"));

// RFC 8785 canonical JSON for objects, arrays, strings, safe integers,
// booleans and null: the value shapes public mutations commit to.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("Canonical JSON supports safe integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError("Value cannot be canonicalized");
}

export const normalizeKey = (pem) =>
  pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");

// A person: identity key, genesis device credential and recovery authority.
export async function createActor() {
  const [identity, device, recovery] = await Promise.all([
    KeyPair.generate(),
    KeyPair.generate(),
    KeyPair.generate(),
  ]);
  return {
    identity,
    device,
    recovery,
    id: normalizeKey(identity.toPrimitives().publicKey),
  };
}

// Identity-signed request headers; the signed path is the full URL path.
export function requestHeaders(actor, method, path, bodyText) {
  const timestamp = Date.now();
  const payload = JSON.stringify({
    bodyHash: sha256(bodyText),
    method: method.toUpperCase(),
    path,
    timestamp,
  });
  return {
    "content-type": "application/json",
    "x-identity-id": actor.id,
    "x-timestamp": String(timestamp),
    "x-signature": actor.identity.sign(payload).toString(),
  };
}

// Performs a signed request against an API base URL (…/api/). A request without
// a body signs the empty object, as the UI does.
export async function signedRequest(
  base,
  actor,
  method,
  route,
  body,
  timeoutMs = 15000,
) {
  const url = new URL(route, base);
  const hasBody = method !== "GET" && method !== "HEAD";
  const bodyText = body === undefined ? "{}" : JSON.stringify(body);
  const response = await fetch(url, {
    method,
    headers: requestHeaders(actor, method, url.pathname, bodyText),
    ...(hasBody ? { body: bodyText } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, text);
  return text ? JSON.parse(text) : undefined;
}

// Publishes the identity with its independent genesis device credential and
// recovery authority, which the node needs to verify the actor's mutations.
export async function publishIdentity(request, actor, networks, name) {
  const deviceCredential = actor.device.toPrimitives().publicKey;
  const unsigned = {
    authorizationRevision: 0,
    deviceCredential,
    deviceCredentialCommitment: sha256(deviceCredential),
    id: actor.id,
    networks,
    profile: { name },
    recoveryAuthority: actor.recovery.toPrimitives().publicKey,
    timestamp: Date.now(),
    version: 1,
  };
  return request(actor, "POST", "identities/", {
    ...unsigned,
    signature: actor.identity.sign(JSON.stringify(unsigned)).toString(),
  });
}

function signMutation(actor, intent, position = FIRST_POSITION) {
  const body = {
    author: {
      deviceCredential: normalizeKey(actor.device.toPrimitives().publicKey),
      identityId: actor.id,
    },
    kind: intent.kind,
    operationId: base64Url(randomBytes(16)),
    payloadDigest: sha256Url(canonicalJson(intent.payload)),
    predecessor: position.predecessor,
    recordId: intent.recordId,
    sequence: position.sequence,
    store: intent.store,
    version: 1,
  };
  const signature = actor.device
    .sign(`${MUTATION_DOMAIN}${canonicalJson(body)}`)
    .toString();
  return { ...body, signature };
}

const mutationDigest = (mutation) => sha256Url(canonicalJson({ ...mutation }));

const entityId = (kind, communityId, creatorId, createdAt) =>
  sha256(JSON.stringify([kind, communityId, creatorId, createdAt])).slice(
    0,
    24,
  );

export const deriveCommunityId = (networkId, ownerIdentityId, nonce) =>
  sha256Url(canonicalJson({ networkId, nonce, ownerIdentityId }));

export const deriveInviteToken = (communityId, creatorId, nonce) =>
  sha256Url(JSON.stringify([communityId, creatorId, nonce]));

const membershipRequestId = (communityId, type, creatorId, identityId, at) =>
  sha256(
    JSON.stringify([communityId, type, creatorId, identityId, at]),
  ).slice(0, 24);

function signOperation(actor, input) {
  const parents = [...input.parents].sort();
  const body = {
    action: input.action,
    args: input.args,
    authorIdentityId: actor.id,
    communityId: input.communityId,
    createdAt: input.createdAt,
    networkId: input.networkId,
    parents,
    scopeType: "community_operation",
  };
  const recordId = `community:${input.communityId}:op:${sha256Url(canonicalJson(body))}`;
  const mutation = signMutation(actor, {
    kind: "put",
    payload: { ...body, id: recordId },
    recordId,
    store: "communityOperations",
  });
  return { createdAt: input.createdAt, mutation, parents };
}

function signModerationLog(actor, input) {
  const id = sha256(
    JSON.stringify([
      input.communityId,
      actor.id,
      input.action,
      input.target.type,
      input.target.id,
      input.createdAt,
    ]),
  ).slice(0, 24);
  const details = Object.fromEntries(
    Object.entries(input.details ?? {}).filter(([, v]) => v !== undefined),
  );
  const mutation = signMutation(actor, {
    kind: "put",
    payload: {
      action: input.action,
      actorIdentityId: actor.id,
      communityId: input.communityId,
      createdAt: input.createdAt,
      details,
      id,
      scopeType: "community_moderation_log",
      target: { id: input.target.id, type: input.target.type },
    },
    recordId: id,
    store: "moderationLogs",
  });
  return { createdAt: input.createdAt, mutation };
}

// Community operations against one node. `request(actor, method, route, body)`
// must perform an identity-signed request on that node.
export class SignedCommunities {
  constructor(request) {
    this.request = request;
  }

  async frontier(actor, communityId) {
    const result = await this.request(
      actor,
      "GET",
      `communities/${encodeURIComponent(communityId)}/frontier`,
    );
    return result.frontier;
  }

  async operation(actor, communityId, networkId, action, args, createdAt) {
    return signOperation(actor, {
      action,
      args,
      communityId,
      createdAt,
      networkId,
      parents: await this.frontier(actor, communityId),
    });
  }

  async create(actor, input) {
    const nonce = base64Url(randomBytes(16));
    const communityId = deriveCommunityId(input.networkId, actor.id, nonce);
    const operation = signOperation(actor, {
      action: "community_created",
      args: {
        autoJoinEnabled: input.autoJoinEnabled ?? false,
        description: input.description,
        discoverable: input.discoverable ?? true,
        name: input.name,
        nonce,
        visibility: input.visibility ?? "private",
      },
      communityId,
      createdAt: Date.now(),
      networkId: input.networkId,
      parents: [],
    });
    return this.request(actor, "POST", "communities/", {
      autoJoinEnabled: input.autoJoinEnabled,
      description: input.description,
      discoverable: input.discoverable,
      name: input.name,
      networkId: input.networkId,
      nonce,
      operation,
      visibility: input.visibility,
    });
  }

  async createChannel(actor, community, type, name) {
    const createdAt = Date.now();
    const channelId = entityId("channel", community.id, actor.id, createdAt);
    return this.request(
      actor,
      "POST",
      `communities/${encodeURIComponent(community.id)}/channels/${type}`,
      {
        moderationLog: signModerationLog(actor, {
          action: "channel_created",
          communityId: community.id,
          createdAt,
          details: { name, type },
          target: { id: channelId, type: "channel" },
        }),
        name,
        operation: await this.operation(
          actor,
          community.id,
          community.networkId,
          "channel_created",
          { channelId, name, type },
          createdAt,
        ),
      },
    );
  }

  // Joins an auto-join community: the requester signs the pending request,
  // its acceptance and the `member_joined` operation.
  async joinAutomatically(actor, community) {
    const createdAt = Date.now();
    const acceptedAt = createdAt + 1;
    const base = {
      communityId: community.id,
      creatorIdentityId: actor.id,
      id: membershipRequestId(
        community.id,
        "request",
        actor.id,
        actor.id,
        createdAt,
      ),
      identityId: actor.id,
      scopeType: "community_membership_request",
      type: "request",
    };
    const record = (status, updatedAt) => ({
      ...base,
      createdAt,
      status,
      updatedAt,
    });
    const operation = await this.operation(
      actor,
      community.id,
      community.networkId,
      "member_joined",
      { identityId: actor.id, method: "automatic" },
      acceptedAt,
    );
    const intent = (payload) => ({
      kind: "put",
      payload,
      recordId: base.id,
      store: "requests",
    });
    const mutation = signMutation(actor, intent(record("pending", createdAt)));
    const acceptedMutation = signMutation(
      actor,
      intent(record("accepted", acceptedAt)),
      {
        predecessor: mutationDigest(mutation),
        sequence: mutation.sequence + 1,
      },
    );
    return this.request(
      actor,
      "POST",
      `communities/${encodeURIComponent(community.id)}/join-requests`,
      { acceptedAt, acceptedMutation, createdAt, mutation, operation },
    );
  }
}
