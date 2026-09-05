import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';

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
const delivery = await load('delivery-v1');
const acknowledgement = await load('acknowledgement-v1');
const operation = await load('private-operation-v1');
const batchAck = await load('acknowledgement-batch-v1');
const frame = await load('protected-frame-v1');
const valid = {
  version: 1,
  mailboxId: Buffer.alloc(32, 1).toString('base64url'),
  deliveryId: Buffer.alloc(16, 2).toString('base64url'),
  expiresAt: 2_000_000_000,
  bucketBytes: 4096,
  ciphertext: Buffer.alloc(4096, 3).toString('base64'),
};

test('delivery allows each documented padding bucket', () => {
  for (const bucketBytes of [4096, 16384, 65536, 262144]) {
    assert.equal(
      delivery({
        ...valid,
        bucketBytes,
        ciphertext: Buffer.alloc(bucketBytes).toString('base64'),
      }),
      true,
      JSON.stringify(delivery.errors),
    );
  }
});

for (const field of [
  'authorId',
  'participantIds',
  'conversationId',
  'networkId',
  'groupId',
  'identityId',
  'deviceId',
  'cid',
  'filename',
  'signature',
  'writeCapability',
  'readCapability',
  'ackCapability',
]) {
  test(`delivery rejects the extra ${field} field`, () => {
    assert.equal(
      delivery({ ...valid, [field]: 'must not be stored in the delivery row' }),
      false,
    );
  });
}

test('delivery rejects unsupported versions, non-opaque identifiers, fractional expiry and incorrect padding', () => {
  for (const invalid of [
    { version: 0 },
    { version: 2 },
    { mailboxId: 'alice@example.com' },
    { deliveryId: 'conversation-1' },
    { expiresAt: -1 },
    { expiresAt: 0.5 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { bucketBytes: 8192 },
    { ciphertext: Buffer.alloc(4000).toString('base64') },
  ]) {
    assert.equal(
      delivery({ ...valid, ...invalid }),
      false,
      JSON.stringify(invalid),
    );
  }
});

test('acknowledgements carry only opaque delivery references', () => {
  const ack = {
    version: 1,
    mailboxId: valid.mailboxId,
    deliveryId: valid.deliveryId,
  };
  assert.equal(acknowledgement(ack), true);
  assert.equal(
    acknowledgement({ ...ack, recipientIdentityId: 'alice' }),
    false,
  );
});

test('authorship and causal context belong inside the decrypted operation', () => {
  const inner = {
    version: 1,
    operationId: valid.deliveryId,
    scopeId: valid.mailboxId,
    authorizationRevision: 1,
    authorDeviceKey: valid.mailboxId,
    kind: 'message.create',
    previousOperationIds: [],
    payload: { text: 'private' },
    signature: Buffer.alloc(64, 4).toString('base64url'),
  };
  assert.equal(operation(inner), true, JSON.stringify(operation.errors));
  assert.equal(delivery(inner), false);
  assert.equal(operation({ ...inner, authorizationRevision: -1 }), false);
  assert.equal(operation({ ...inner, kind: 'unknown.operation' }), false);
  assert.equal(
    operation({
      ...inner,
      previousOperationIds: [valid.deliveryId, valid.deliveryId],
    }),
    false,
  );
});

test('batch acknowledgements are bounded and cannot repeat delivery IDs', () => {
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
        Buffer.alloc(16, index).toString('base64url'),
      ),
    }),
    false,
  );
});

test('MLS application and control frames have distinct protected contracts', () => {
  const application = {
    version: 1,
    kind: 'mls-application',
    mlsMessage: 'AQIDBA==',
  };
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 2,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 2,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures: { [valid.mailboxId]: Buffer.alloc(64).toString('base64url') },
  };
  assert.equal(frame(application), true);
  assert.equal(operation(application), false);
  assert.equal(delivery(application), false);
  for (const kind of ['mls-commit', 'mls-welcome']) {
    assert.equal(frame({ ...application, kind }), false);
    assert.equal(
      frame({ ...application, kind, authorization }),
      true,
      JSON.stringify(frame.errors),
    );
  }
  assert.equal(frame({ ...application, authorization }), false);
  assert.equal(frame({ ...application, kind: 'unknown' }), false);
});

test('control authorization uses distinct signer keys instead of countable duplicate entries', () => {
  const signature = Buffer.alloc(64).toString('base64url');
  const signer = { authorDeviceKey: valid.mailboxId, signature };
  const authorization = {
    scopeId: valid.mailboxId,
    revision: 2,
    parentHeadHash: valid.mailboxId,
    mlsEpoch: 2,
    mlsMessageHash: valid.mailboxId,
    policyHash: valid.mailboxId,
    headHash: valid.mailboxId,
    mlsContextHash: valid.mailboxId,
    signatures: { [valid.mailboxId]: signature },
  };
  for (const kind of ['mls-commit', 'mls-welcome']) {
    const control = { version: 1, kind, mlsMessage: 'AQIDBA==', authorization };
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

test('presence has a bounded private operation without an identity-to-node announcement', () => {
  const presence = {
    version: 1,
    operationId: valid.deliveryId,
    scopeId: valid.mailboxId,
    authorizationRevision: 1,
    authorDeviceKey: valid.mailboxId,
    kind: 'presence.update',
    previousOperationIds: [],
    payload: {
      status: 'online',
      sequence: 1,
      sentAt: 2000000000,
      expiresAt: 2000000090,
    },
    signature: Buffer.alloc(64).toString('base64url'),
  };
  assert.equal(operation(presence), true, JSON.stringify(operation.errors));
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, ownerNodeId: 'node-1' },
    }),
    false,
  );
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, customMessage: 'x'.repeat(141) },
    }),
    false,
  );
  assert.equal(
    operation({
      ...presence,
      payload: { ...presence.payload, status: 'unknown' },
    }),
    false,
  );
});
