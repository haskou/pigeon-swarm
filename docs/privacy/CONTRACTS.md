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
The canonical head hash covers scope, revision, parent-head hash, resulting MLS
epoch, MLS GroupContext hash and membership-policy hash. The binding adds the
hash of the exact control message bytes, so different Welcome and Commit bytes
can refer to the same head without creating different heads. Verify its
Ed25519 signatures using the previous policy (or pinned invite authority), with
JCS encoding excluding `signatures` and domain separator
`pigeon.private-control.v1` followed by a zero byte. The candidate MLS context
must match `mlsContextHash` before committing state.

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
