# Private delivery contracts, version 1

These contracts are implementation boundaries for [ADR-001](ADR-001-private-data.md).
They are not active API routes yet. `npm run test:privacy` compiles the schemas
and exercises permitted and rejected examples. That test does not perform
cryptographic verification, run a mailbox server or prove traffic unlinkability.

## Public-to-gateway boundary

The logical delivery API is inside an OHTTP request. TLS remains required on
both hops. Gateway request bodies and authorization headers are unavailable to
the forwarding relay. Never forward browser cookies, bearer account sessions,
`X-Forwarded-For`, identity headers or referrers through this boundary.

| Logical operation | Authentication / request | Result and invariants |
| --- | --- | --- |
| Create mailbox lease | Anonymous resource-admission voucher; client-selected random 32-byte mailbox ID and independent write/read/ack/management capabilities | Fixed quota, accepted expiry, selected replica pair and capability commitments. No identity, group or device field. Creation must be rate-limited before allocating storage. |
| Put delivery | Write capability in protected authorization header; [delivery schema](contracts/delivery-v1.schema.json) | Validate lease, expiry, quota and exact byte bucket. Atomic body plus outbox write. Return `stored-local` or `replicated`, never conflate them. |
| Read page | Read capability; mailbox ID, opaque server cursor, limit <= 50 and <= 1 MiB decoded ciphertext per page | Only unexpired entries. Cursor is queue-local, opaque and integrity-protected. No private search or cross-mailbox enumeration. |
| Acknowledge | Ack capability; [ack schema](contracts/acknowledgement-v1.schema.json) | Idempotent body removal plus tombstone/outbox. Return `pending-replica` or `complete`. Ack follows verified durable client persistence. |
| Retire mailbox | Management capability from lease creation | Stop new writes; keep reads/acks until accepted deliveries expire. Revocation rotates credentials without exposing the replacement relationship. |

Acknowledgements may use the [batch schema](contracts/acknowledgement-batch-v1.schema.json)
for up to 50 IDs from the same mailbox under its ack capability. One batch costs
one request against the shared lease budget; partial replica completion remains
explicit per delivery. A page and its acknowledgement cannot bypass byte quotas.

Capabilities are independent 256-bit random secrets, transmitted only inside the
protected request, never URLs or logs. Persist their one-way commitments, not
raw tokens. Resource vouchers must not become a reusable account identifier on
every delivery. The detailed anonymous admission mechanism is a release gate
for node #289 / wrapper #32; an unlimited create endpoint is not acceptable.

The persisted delivery row contains only `version`, `mailboxId`, `deliveryId`,
`expiresAt`, `bucketBytes` and `ciphertext`. Server-local queue ordering and
capability commitments live in separate scoped indexes. `expiresAt` is an integer
UTC second accepted within the lease and retention policy, rounded to an hour
for ordinary messages. Call signalling and presence use their shorter limits;
there is no plaintext type field to tell the server which private activity an
envelope contains. Separate short-lived leases enforce those maxima.

The serialized opaque bytes must be exactly 4,096, 16,384, 65,536 or 262,144 bytes,
including recipient HPKE wrapping and padding. JSON uses canonical base64 for
these bytes and unpadded base64url for identifiers. The server must decode and
check canonical encoding and exact length, reject a request over 360 KiB before
parsing, and bound nesting/field count. JSON Schema checks shape and encoded
length; it does not establish those runtime properties by itself.

Deduplicate by `(mailboxId, deliveryId)`. Repeating the same ID and identical
ciphertext/expiry returns its existing status without consuming more quota.
The same ID with different bytes or expiry is a conflict, not an overwrite.
Never extend retention through retries. Persist the original accepted expiry.
Different recipient copies use different random IDs and outer ciphertext.

The two selected servers exchange only these records, capability commitments,
bounded tombstones and replication cursors. No identity/group lookup table is
needed to reconcile a queue. Tombstones win over a matching body until original
expiry plus 24 hours; after that, the expiry read/write gate rejects resurrection.
Reconnect after the tombstone window by exchanging only still-valid rows.

## Protected operation boundary

The binary recipient wrapper is the 32-byte X25519 encapsulated key followed by
HPKE ciphertext and its 16-byte GCM tag. The encrypted plaintext contains a
4-byte unsigned big-endian frame length, the canonical UTF-8 JSON frame and zero
padding to the selected bucket. Reject inconsistent lengths or nonzero padding.
Each protected frame limits `mlsMessage` to 210,000 base64 characters. Even a
control frame with 128 devices, authority keys, signatures and maximum integer fields fits the 256 KiB
bucket including the 52 bytes of wrapping/length overhead. Check the actual
serialized size before encryption; larger MLS outputs must fail before committing
a local transition, not produce an undeliverable operation. The crypto integration
must demonstrate that supported 128-device transitions fit this budget before release.

A new scope starts with a separate [genesis head](contracts/genesis-head-v1.schema.json),
not an MLS Commit or Welcome. The creator generates a fresh random `scopeId`,
creates its single-device MLS group at epoch zero and records revision zero with
`parentHeadHash: null`. The initial policy lists only the creator device and its SHA-256 MLS credential
hash in `devices`, and has exactly the creator's pinned
Ed25519 device key as authority, sequencer and freshness authority, with threshold
one. Equality of those policy keys and the sole signature key is a required domain
check. Additional administrators/devices and delegated authorities require later
signed transitions; they cannot be inserted into a genesis policy.

Compute `policyHash` as SHA-256 of the JCS initial policy. Compute `headHash` from
the same canonical head tuple used below (scope, revision, null parent, epoch,
MLS context hash and policy hash). Sign JCS of the complete genesis record excluding
`signatures`, prefixed by UTF-8 `pigeon.private-genesis.v1` and a zero separator. Verify
hashes, signature, epoch/revision and key equality before persisting it. The creator
trusts its own locally generated key; another device accepts genesis only against
the owner key already pinned by the verified invitation/contact channel. A
self-signed record fetched from infrastructure is not a trust anchor.

Persist genesis atomically with the initial local MLS state before any outbound
operation. Invitations deliver this signed record and the authenticated policy
chain through the protected bootstrap channel. The first membership Commit/Welcome
uses revision one, epoch one and the genesis `headHash` as parent; verify it under
the genesis owner's policy. Later heads require the verified previous head/policy.
Control frames require positive revision/epoch and a non-null parent. Refuse a
second different genesis for an already pinned scope; resetting requires a new
random scope and explicit invitation. Schema tests cover initial versus transition
shape; cryptographic pinning, hash/signature and atomic-state tests are release gates.

After recipient HPKE processing, decode the
[protected frame](contracts/protected-frame-v1.schema.json). The frame distinguishes
`mls-application`, `mls-commit` and `mls-welcome`; its kind and MLS framing never
appear outside recipient encryption.

- Application frames: process the MLS application message, then decode the
  [private operation schema](contracts/private-operation-v1.schema.json). This is
  where scope, author device, authorization revision and causal links belong.
  Those fields must never be copied to the outer delivery, access logs or global
  indexes. Each recipient stores one operation regardless of transport duplicates.
- Commit frames: verify the signed authorization transition against the previous
  policy, including scope, parent-head hash/revision, resulting MLS epoch, policy
  hash and SHA-256 of the exact MLS control bytes. Process the MLS commit on a
  candidate state, check its resulting membership against the authorized policy,
  then persist the MLS state and authorization head atomically. Do not feed the
  raw MLS commit into the application-operation parser.
- Welcome frames: verify the invitation's pinned authority and a signed binding
  of the welcome bytes to the intended scope, resulting epoch and current policy.
  Only then initialize the device's group state. Welcome is not an application
  operation either.

Control `authorization` is a signed binding, not the authorization head itself.
Every Commit and Welcome carries its complete candidate
[authorization policy](contracts/authorization-policy-v1.schema.json) in
`authorization.policy`; the signature covers this object along with `policyHash`.
Recompute SHA-256 of its JCS encoding and reject a hash mismatch before processing
MLS. Do not substitute an unsigned policy fetched from another endpoint.

The policy lists each admitted device signing key and SHA-256 of its exact MLS
credential bytes, its administrator keys and quorum, sequencer and freshness
signer. Device keys and credential hashes must each be distinct; administrator
keys must be admitted device keys, the sequencer must be an administrator and
the threshold cannot exceed the number of administrators. A freshness signer may
be an explicitly delegated external key, with the trust limits in the ADR.
Reject invalid policies before signing or applying a transition. Verify signatures
under the **previous** verified policy, never the candidate administrators. After
MLS processing, compare the complete resulting leaf credential/device set with
`policy.devices`, then atomically persist the candidate policy, head and MLS state.
The next transition uses that persisted policy. Application-level role/operation
permissions remain subject to the scope's authenticated domain state and the
operation checks in the implementation issues; this policy grants no blanket
administrator access to private content outside the scope.

The canonical head hash is SHA-256 of the JCS object with exactly `scopeId`,
`revision`, `parentHeadHash`, `mlsEpoch`, `mlsContextHash` and `policyHash`, using
the values in the verified head. Encode all hash fields as canonical unpadded
base64url of their 32 bytes. The binding adds the
hash of the exact control message bytes, so different Welcome and Commit bytes
can refer to the same head without creating different heads. Verify its
Ed25519 signatures using the previous policy (or pinned invite authority), with
JCS encoding excluding `signatures` and domain separator
`pigeon.private-control.v1` followed by a zero byte. The candidate MLS context
must match `mlsContextHash` before committing state. `signatures` is a map from
admitted administrator public key to signature, not an array of countable entries.
Policies admit at most 128 authority keys and require a threshold between one
and the number of admitted keys; reject an unsatisfiable policy before adoption.
Require canonical unpadded base64url: decode and re-encode byte-for-byte, rejecting
nonzero unused bits. Count distinct decoded public-key bytes from the previous
policy only, never textual property names; reject unknown
signers and invalid signatures. Reject duplicate JSON property names before
parsing/canonicalization, so duplicate signer keys cannot be hidden by a parser.
The shape tests reject repeated-entry arrays; runtime quorum/duplicate-key parsing
and signature validation remain required application/crypto tests.

The `membership.commit` application operation records the accepted administrative
transition for history; it references its signed head/commit hash and does not
contain another MLS commit to apply recursively. The private-operation parser
cannot itself authorize group-key changes.

If an application frame arrives ahead of its MLS commit, persist at most 128
pending frames or 1 MiB per scope without acknowledging application success.
Fetch missing authenticated control frames first through the scoped control
channel; stop fetching further application pages when the bound is reached.
Retry control recovery with bounded backoff up to five minutes. If the seven-day
recovery window is exhausted, surface a required authorized rejoin/history
transfer rather than silently dropping or applying the orphaned messages.

The recipient HPKE ciphertext authenticates the canonical outer `version`,
`mailboxId`, `deliveryId`, `expiresAt` and `bucketBytes` as associated data under
the label `pigeon.private-delivery.v1`. Changing a retained header must fail
recipient authentication. Choose HPKE base mode with X25519/HKDF-SHA256/AES-128-GCM;
MLS and the signed inner operation supply author authentication. Crypto adapters
must share exact vectors for the framing and associated-data encoding.

The signature covers the UTF-8 bytes of the domain separator
`pigeon.private-operation.v1` followed by a zero byte and the
[JCS canonical encoding](https://www.rfc-editor.org/rfc/rfc8785.html) of the object
without `signature`. Use the admitted device's Ed25519 key. Verify canonical
encoding, the device-to-identity credential binding, signature, scope, current
authorization policy and kind-specific domain rules before applying state.
The canonicalization/library adapter and shared vectors belong in the crypto
repository; do not implement a second ad hoc serializer in each client.

| Kind | Required domain interpretation inside encrypted payload |
| --- | --- |
| `message.create` | Body and attachment manifests; creation must not grant membership |
| `message.edit` / `message.delete` | Target operation ID; original author or explicit moderator authority |
| `reaction.set` | Target operation ID and bounded reaction/removal value |
| `receipt.advance` | Causal read frontier for this admitted device; no claim on behalf of another member |
| `presence.update` | Opt-in status for the authenticated author device only; monotonic per-device sequence, integer sent/expiry times with <= 90-second lifetime, bounded custom message; reject expired or older sequences and never include a node ID |
| `call.signal` | Call/attempt ID, sender/recipient binding, signal type, payload and <= 60-second validity; do not revive an ended call |
| `membership.propose` | Requested policy change against exact signed parent revision; no immediate authority change |
| `membership.commit` | Accepted transition revision and signed head/commit hash; key-state changes use the separate control frame |
| `device.revoke` | Target credential and new authorization revision; requires existing owner/admin authority |

The generic schema deliberately does not authorize `payload`. Existing domain
validators must supply these kind-specific schemas/rules, including size limits,
before an implementation can accept operations. Unknown kinds or versions are
rejected; quarantine out-of-order authorized dependencies with a bounded pending
queue. Neither accepting a valid JSON object nor receiving it over a private
network is a proof of authorship.

## Bootstrap, local history and attachments

A verified invite/device bootstrap transfers, under an authenticated protected
channel: protocol version and suite, scope verifier, current signed authorization
head, admitted device key-package material and recipient mailbox descriptors.
A descriptor has random mailbox ID, selected gateway endpoints, independent
write/read/ack/management rights as appropriate, a daily write-validity interval,
maximum ciphertext expiry and recipient HPKE public key. Provision current day
plus seven future days under the authenticated scope and bind each descriptor
to its authorization revision. Reject exhausted or revoked schedules; never
synthesize replacement descriptors from identities or conversation hashes.
Share only the rights needed by that peer. No global service can enumerate these
descriptors by user identity.

Authorization-head challenges and responses use the same independent OHTTP path
and participant-protected control channel as descriptor refresh. A request binds
a fresh nonce and outbound batch commitment; the authority signs those values
with the scope, revision and head hash. The client uses a ten-second local
monotonic deadline, verifies the delegated authority from the signed policy and
rejects nonce reuse/rollback. A service that merely serves old signed JSON is
not an online freshness authority. If freshness cannot be proven, sending stays
pending. This authority is trusted for freshness, even though storage gateways
are not trusted for message authorship.

Blob requests use separate authenticated endpoints through the independent
relay, with a <= 2 MiB request bound for a 1 MiB encrypted chunk. A shared object
reveals repeated-access linkage to its operator. Names, manifests and participant
identities remain encrypted, and random objects/keys are never reused across
scopes. This explicit residual is different from globally publishing a CID.

A local history transaction stores the verified operation, dedup marker and new
cryptographic state together under the vault key before acknowledging delivery.
Local vault format and sync/export versions must be explicit and authenticated;
rollback or mismatched cryptographic state is an error, not a fresh empty vault.
A recovery import does not publish old operations as new authorized writes.

An attachment manifest exists only inside an encrypted operation: random object
ID, scoped download capability, selected blob endpoints, total size, filename,
MIME type, expiry, chunk order, authenticated chunk hashes and encryption
parameters. Object IDs are random, not plaintext content hashes. Receivers check
all lengths/hashes and authentication tags before exposing bytes. No manifest,
key or private CID goes into a public content-replication claim.

## Required implementation tests

The current schema tests reject outer relationship/identity/CID/capability fields,
unknown versions, invalid identifiers and wrong padding buckets. Before release,
dependent tasks must additionally demonstrate:

- standard crypto interoperability and tampered/wrong-recipient rejection;
- operator storage/traffic captures without plaintext author or roster;
- crash between body/outbox writes and between local persist/ack, with no silent
  loss or duplicate visible messages;
- duplicate conflicts, expiry on reads, clock skew, quota exhaustion, replica
  partitions and tombstone reconciliation;
- device removal concurrent with delivery, replay, stale authorization and
  out-of-order legitimate operations;
- no private IPFS/DHT/network-pubsub writes, including fallback/error paths;
- verified client distribution, logs, push and background-browser limitations.
