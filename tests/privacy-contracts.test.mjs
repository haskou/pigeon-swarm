import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: true });
const load = async (name) =>
  ajv.compile(
    JSON.parse(
      await readFile(
        new URL(
          `../docs/privacy/contracts/${name}.schema.json`,
          import.meta.url,
        ),
      ),
    ),
  );
await load("authorization-policy-v1");
const delivery = await load("delivery-v1");
const acknowledgement = await load("acknowledgement-v1");
const operation = await load("private-operation-v1");
const batchAck = await load("acknowledgement-batch-v1");
const frame = await load("protected-frame-v1");
const genesis = await load("genesis-head-v1");
const valid = {
  version: 1,
  mailboxId: Buffer.alloc(32, 1).toString("base64url"),
  deliveryId: Buffer.alloc(16, 2).toString("base64url"),
  expiresAt: 2_000_000_000,
  bucketBytes: 4096,
  ciphertext: Buffer.alloc(4096, 3).toString("base64"),
};

const policy = {
  version: 1,
  devices: [{ deviceKey: valid.mailboxId, mlsCredentialHash: valid.mailboxId }],
  authorityKeys: [valid.mailboxId],
  threshold: 1,
  sequencerKey: valid.mailboxId,
  freshnessAuthorityKey: valid.mailboxId,
  leaseRevocationKey: valid.mailboxId,
  leaseRevocationHpkeKey: valid.mailboxId,
};

test("delivery allows each documented padding bucket", () => {
  for (const bucketBytes of [4096, 16384, 65536, 262144]) {
    assert.equal(
      delivery({
        ...valid,
        bucketBytes,
        ciphertext: Buffer.alloc(bucketBytes).toString("base64"),
      }),
      true,
      JSON.stringify(delivery.errors),
    );
  }
});

for (const field of [
  "authorId",
  "participantIds",
  "conversationId",
  "networkId",
  "groupId",
  "identityId",
  "deviceId",
  "cid",
  "filename",
  "signature",
  "writeCapability",
  "readCapability",
  "ackCapability",
]) {
  test(`delivery rejects the extra ${field} field`, () => {
    assert.equal(
      delivery({ ...valid, [field]: "must not be stored in the delivery row" }),
      false,
    );
  });
}

test("delivery rejects unsupported versions, non-opaque identifiers, fractional expiry and incorrect padding", () => {
  for (const invalid of [
    { version: 0 },
    { version: 2 },
    { mailboxId: "alice@example.com" },
    { deliveryId: "conversation-1" },
    { expiresAt: -1 },
    { expiresAt: 0.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { bucketBytes: 8192 },
    { ciphertext: Buffer.alloc(4000).toString("base64") },
  ]) {
    assert.equal(
      delivery({ ...valid, ...invalid }),
      false,
      JSON.stringify(invalid),
    );
  }
});

test("acknowledgements carry only opaque delivery references", () => {
  const ack = {
    version: 1,
    mailboxId: valid.mailboxId,
    deliveryId: valid.deliveryId,
  };
  assert.equal(acknowledgement(ack), true);
  assert.equal(
    acknowledgement({ ...ack, recipientIdentityId: "alice" }),
    false,
  );
});

test("authorship and causal context belong inside the decrypted operation", () => {
  const inner = {
    version: 1,
    operationId: valid.deliveryId,
    scopeId: valid.mailboxId,
    authorizationRevision: 1,
    authorDeviceKey: valid.mailboxId,
    kind: "message.create",
    previousOperationIds: [],
    payload: { text: "private" },
    signature: Buffer.alloc(64, 4).toString("base64url"),
  };
  assert.equal(operation(inner), true, JSON.stringify(operation.errors));
  assert.equal(delivery(inner), false);
  assert.equal(operation({ ...inner, authorizationRevision: -1 }), false);
  assert.equal(operation({ ...inner, kind: "unknown.operation" }), false);
  assert.equal(
    operation({
      ...inner,
      previousOperationIds: [valid.deliveryId, valid.deliveryId],
    }),
    false,
  );
});

test("batch acknowledgements are bounded and cannot repeat delivery IDs", () => {
  const ack = {
    version: 1,
    mailboxId: valid.mailboxId,
    deliveryIds: [valid.deliveryId],
  };
  assert.equal(batchAck(ack), true);
  assert.equal(batchAck({ ...ack, deliveryIds: [] }), false);
  assert.equal(
    batchAck({ ...ack, deliveryIds: [valid.deliveryId, valid.deliveryId] }),
    false,
  );
  assert.equal(
    batchAck({
      ...ack,
      deliveryIds: Array.from({ length: 51 }, (_, index) =>
        Buffer.alloc(16, index).toString("base64url"),
      ),
    }),
    false,
  );
});

test("MLS application and control frames have distinct protected contracts", () => {
  const application = {
    version: 1,
    kind: "mls-application",
    mlsMessage: "AQIDBA==",
  };
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 2,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 2,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    policy,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures: { [valid.mailboxId]: Buffer.alloc(64).toString("base64url") },
  };
  assert.equal(frame(application), true);
  assert.equal(operation(application), false);
  assert.equal(delivery(application), false);
  for (const kind of ["mls-commit", "mls-welcome"]) {
    assert.equal(frame({ ...application, kind }), false);
    assert.equal(
      frame({ ...application, kind, authorization }),
      true,
      JSON.stringify(frame.errors),
    );
  }
  assert.equal(frame({ ...application, authorization }), false);
  assert.equal(frame({ ...application, kind: "unknown" }), false);
});

test("control authorization uses distinct signer keys instead of countable duplicate entries", () => {
  const signature = Buffer.alloc(64).toString("base64url");
  const signer = { authorDeviceKey: valid.mailboxId, signature };
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 2,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 2,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    policy,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures: { [valid.mailboxId]: signature },
  };
  for (const kind of ["mls-commit", "mls-welcome"]) {
    const control = { version: 1, kind, mlsMessage: "AQIDBA==", authorization };
    assert.equal(frame(control), true);
    assert.equal(
      frame({
        ...control,
        authorization: { ...authorization, signatures: [signer, signer] },
      }),
      false,
    );
    assert.equal(
      frame({
        ...control,
        authorization: { ...authorization, signatures: {} },
      }),
      false,
    );
  }
});

test("presence has a bounded private operation without an identity-to-node announcement", () => {
  const presence = {
    version: 1,
    operationId: valid.deliveryId,
    scopeId: valid.mailboxId,
    authorizationRevision: 1,
    authorDeviceKey: valid.mailboxId,
    kind: "presence.update",
    previousOperationIds: [],
    payload: {
      status: "online",
      sequence: 1,
      sentAt: 2000000000,
      expiresAt: 2000000090,
    },
    signature: Buffer.alloc(64).toString("base64url"),
  };
  assert.equal(operation(presence), true, JSON.stringify(operation.errors));
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, ownerNodeId: "node-1" },
    }),
    false,
  );
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, customMessage: "x".repeat(141) },
    }),
    false,
  );
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, status: "unknown" },
    }),
    false,
  );
});

test("maximum protected frames fit the delivery bucket including recipient wrapping", () => {
  const signatures = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [
      Buffer.alloc(32, index).toString("base64url"),
      Buffer.alloc(64).toString("base64url"),
    ]),
  );
  const authorization = {
    scopeId: valid.mailboxId,
    revision: Number.MAX_SAFE_INTEGER,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: Number.MAX_SAFE_INTEGER,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures,
    policy: {
      ...policy,
      devices: Object.keys(signatures).map((deviceKey) => ({
        deviceKey,
        mlsCredentialHash: deviceKey,
      })),
      authorityKeys: Object.keys(signatures),
      threshold: 128,
    },
  };
  for (const kind of ["mls-application", "mls-commit", "mls-welcome"]) {
    const value = { version: 1, kind, mlsMessage: "A".repeat(210000) };
    if (kind !== "mls-application") value.authorization = authorization;
    assert.equal(frame(value), true, JSON.stringify(frame.errors));
    const encodedBytes = Buffer.byteLength(JSON.stringify(value));
    assert.ok(encodedBytes + 32 + 16 + 4 <= 262144);
    assert.equal(frame({ ...value, mlsMessage: "A".repeat(210004) }), false);
    if (kind !== "mls-application") {
      assert.equal(
        frame({
          ...value,
          authorization: {
            ...authorization,
            signatures: {
              ...signatures,
              [Buffer.alloc(32, 128).toString("base64url")]:
                Buffer.alloc(64).toString("base64url"),
            },
          },
        }),
        false,
      );
    }
  }
});

test("control authorization rejects noncanonical aliases of the same signer key", () => {
  const key = Buffer.alloc(32).toString("base64url");
  const signature = Buffer.alloc(64).toString("base64url");
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 1,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 1,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    policy,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures: { [key]: signature },
  };
  for (const kind of ["mls-commit", "mls-welcome"]) {
    const value = { version: 1, kind, mlsMessage: "AQIDBA==", authorization };
    assert.equal(frame(value), true);
    for (const last of ["B", "C", "D"]) {
      const alias = key.slice(0, -1) + last;
      assert.deepEqual(
        Buffer.from(alias, "base64url"),
        Buffer.from(key, "base64url"),
      );
      assert.equal(
        frame({
          ...value,
          authorization: {
            ...authorization,
            signatures: { [key]: signature, [alias]: signature },
          },
        }),
        false,
      );
    }
  }
});

test("genesis is a pinned single-owner epoch-zero head rather than a control transition", () => {
  const owner = valid.mailboxId;
  const value = {
    version: 1,
    scopeId: valid.mailboxId,
    revision: 0,
    parentHeadHash: null,
    mlsEpoch: 0,
    mlsContextHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    policy,
    headHash: valid.mailboxId,
    signatures: { [owner]: Buffer.alloc(64).toString("base64url") },
  };
  assert.equal(genesis(value), true, JSON.stringify(genesis.errors));
  for (const patch of [
    { revision: 1 },
    { mlsEpoch: 1 },
    { parentHeadHash: valid.mailboxId },
    { signatures: {} },
  ]) {
    assert.equal(genesis({ ...value, ...patch }), false);
  }
  assert.equal(
    genesis({ ...value, policy: { ...value.policy, threshold: 2 } }),
    false,
  );
  const authorization = { ...value, mlsMessageHash: valid.mailboxId };
  delete authorization.version;
  for (const kind of ["mls-commit", "mls-welcome"]) {
    const control = { version: 1, kind, mlsMessage: "AQIDBA==", authorization };
    assert.equal(frame(control), false);
    assert.equal(
      frame({
        ...control,
        authorization: {
          ...authorization,
          revision: 1,
          mlsEpoch: 1,
          parentHeadHash: value.headHash,
        },
      }),
      true,
    );
  }
});

test("every control transition carries its complete bounded candidate policy", () => {
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 1,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 1,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    policy,
    signatures: { [valid.mailboxId]: Buffer.alloc(64).toString("base64url") },
  };
  for (const kind of ["mls-commit", "mls-welcome"]) {
    const control = { version: 1, kind, mlsMessage: "AQIDBA==", authorization };
    assert.equal(frame(control), true);
    const withoutPolicy = { ...authorization };
    delete withoutPolicy.policy;
    assert.equal(frame({ ...control, authorization: withoutPolicy }), false);
    for (const patch of [
      { devices: [] },
      { authorityKeys: [] },
      { threshold: 129 },
      { authorityKeys: [valid.mailboxId, valid.mailboxId] },
    ]) {
      assert.equal(
        frame({
          ...control,
          authorization: { ...authorization, policy: { ...policy, ...patch } },
        }),
        false,
      );
    }
  }
});

test("freshness vectors bind the exact batch, nonce and signature domain", async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL(
        "../docs/privacy/contracts/verification-vectors-v1.json",
        import.meta.url,
      ),
    ),
  );
  const request = await load("freshness-request-v1");
  const proof = await load("freshness-proof-v1");
  const batch = await load("outbound-batch-v1");
  assert.equal(batch(vectors.batch.value), true);
  assert.equal(request(vectors.freshness.request), true);
  assert.equal(proof(vectors.freshness.proof), true);
  assert.deepEqual(JSON.parse(vectors.batch.jcs), vectors.batch.value);
  assert.equal(
    createHash("sha256").update(vectors.batch.jcs).digest("base64url"),
    vectors.batch.sha256,
  );
  const { signature, ...body } = vectors.freshness.proof;
  assert.deepEqual(JSON.parse(vectors.freshness.jcs), body);
  const signed = Buffer.concat([
    Buffer.from("pigeon.private-freshness.v1\0"),
    Buffer.from(vectors.freshness.jcs),
  ]);
  assert.equal(signed.toString("hex"), vectors.freshness.signedBytesHex);
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(body.signerKey, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  assert.equal(
    verify(null, signed, publicKey, Buffer.from(signature, "base64url")),
    true,
  );
  for (const text of [
    vectors.freshness.jcs.replace(body.nonce, valid.mailboxId),
    vectors.freshness.jcs.replace(body.batchCommitment, valid.mailboxId),
  ]) {
    assert.equal(
      verify(
        null,
        Buffer.concat([
          Buffer.from("pigeon.private-freshness.v1\0"),
          Buffer.from(text),
        ]),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      false,
    );
  }
  assert.equal(
    verify(
      null,
      Buffer.concat([
        Buffer.from("pigeon.private-control.v1\0"),
        Buffer.from(vectors.freshness.jcs),
      ]),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    false,
  );
  assert.equal(
    request({ ...vectors.freshness.request, nonce: undefined }),
    false,
  );
  assert.equal(
    batch({
      ...vectors.batch.value,
      operationHashes: [
        ...vectors.batch.value.operationHashes,
        ...vectors.batch.value.operationHashes,
      ],
    }),
    false,
  );
});

test("MLS context digest covers the complete TLS context vector", async () => {
  const { groupContext: value } = JSON.parse(
    await readFile(
      new URL(
        "../docs/privacy/contracts/verification-vectors-v1.json",
        import.meta.url,
      ),
    ),
  );
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64BE(BigInt(value.epoch));
  const encoded = Buffer.concat([
    Buffer.from("00010001", "hex"),
    Buffer.from([32]),
    Buffer.from(value.groupIdHex, "hex"),
    epoch,
    Buffer.from([32]),
    Buffer.from(value.treeHashHex, "hex"),
    Buffer.from([32]),
    Buffer.from(value.confirmedTranscriptHashHex, "hex"),
    Buffer.from([0]),
  ]);
  assert.equal(encoded.toString("hex"), value.tlsHex);
  assert.equal(
    createHash("sha256").update(encoded).digest("base64url"),
    value.sha256,
  );
  for (const offset of [0, 3, 5, 44, 46, 80, encoded.length - 1]) {
    const changed = Buffer.from(encoded);
    changed[offset] ^= 1;
    assert.notEqual(
      createHash("sha256").update(changed).digest("base64url"),
      value.sha256,
    );
  }
});

test("lease retirement grants carry a separate retire-only right and a bounded receipt", async () => {
  const grant = await load("lease-retirement-grant-v1");
  const receipt = await load("lease-retirement-receipt-v1");
  const value = {
    version: 1,
    scopeId: valid.mailboxId,
    revision: 1,
    headHash: valid.mailboxId,
    recipientDeviceKey: valid.mailboxId,
    senderDeviceKey: valid.mailboxId,
    mailboxId: valid.mailboxId,
    gatewayId: valid.mailboxId,
    leaseExpiresAt: valid.expiresAt,
    retireCapability: valid.mailboxId,
    issuerDeviceKey: valid.mailboxId,
    signature: Buffer.alloc(64).toString("base64url"),
  };
  assert.equal(grant(value), true);
  assert.equal(grant({ ...value, senderDeviceKey: undefined }), false);
  assert.equal(grant({ ...value, readCapability: valid.mailboxId }), false);
  assert.equal(grant({ ...value, gatewayOrigin: "https://localhost:8443" }), false);
  assert.equal(
    grant({ ...value, gatewayId: "https://localhost:8443" }),
    false,
  );
  assert.equal(
    receipt({
      version: 1,
      scopeId: value.scopeId,
      headHash: value.headHash,
      grantHash: valid.mailboxId,
      signerKey: valid.mailboxId,
      signature: value.signature,
    }),
    true,
  );
});

test("HPKE framing vector fixes the exact context and authenticated header bytes", async () => {
  const { hpkeFraming: value } = JSON.parse(
    await readFile(
      new URL(
        "../docs/privacy/contracts/verification-vectors-v1.json",
        import.meta.url,
      ),
    ),
  );
  assert.equal(
    Buffer.from("pigeon.private-delivery.v1\0").toString("hex"),
    value.infoHex,
  );
  assert.deepEqual(JSON.parse(value.aadJcs), value.header);
  assert.equal(Buffer.from(value.aadJcs).toString("hex"), value.aadHex);
  const frameBytes = Buffer.from(value.frameJcs);
  assert.equal(frame(JSON.parse(value.frameJcs)), true);
  assert.equal(frameBytes.length, value.frameByteLength);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(frameBytes.length);
  assert.equal(prefix.toString("hex"), value.lengthPrefixHex);
  const plaintext = Buffer.concat([
    prefix,
    frameBytes,
    Buffer.alloc(value.zeroPaddingBytes),
  ]);
  assert.equal(plaintext.length + 32 + 16, value.header.bucketBytes);
  assert.equal(
    createHash("sha256").update(plaintext).digest("hex"),
    value.plaintextSha256Hex,
  );
  for (const field of Object.keys(value.header)) {
    const changed = {
      ...value.header,
      [field]:
        typeof value.header[field] === "number"
          ? value.header[field] + 1
          : value.header[field] + "A",
    };
    const encoded = JSON.stringify(
      Object.fromEntries(
        Object.entries(changed).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
    );
    assert.notEqual(Buffer.from(encoded).toString("hex"), value.aadHex);
  }
  assert.equal(
    Buffer.from("pigeon.private-lease-grant.v1\0").toString("hex"),
    value.grantInfoHex,
  );
  assert.deepEqual(JSON.parse(value.grantAadJcs), value.grantAad);
  assert.equal(
    Buffer.from(value.grantAadJcs).toString("hex"),
    value.grantAadHex,
  );
});
