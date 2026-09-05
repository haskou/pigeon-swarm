# Current private-data inventory

Snapshot: backend `4f43437`, UI `5682be6`, reviewed 2026-09-06. This is a code
inventory, not production telemetry. “No bounded TTL established” means the
inspected path supplies no basis for promising expiry or erasure; it is not a
claim that every installation keeps data forever.

The current replication unit is a private **network**, not a conversation.
[OrbitDBPrivateNetworkStores](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/shared/infrastructure/orbitdb/OrbitDBPrivateNetworkStores.ts) opens deterministic stores and synchronizes 17 families. [OrbitDBRuntimeAdapter](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/shared/infrastructure/orbitdb/OrbitDBRuntimeAdapter.ts) uses `write: ['*']` within that network. [OrbitDBReplicatedStateRegistry](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/shared/infrastructure/orbitdb/OrbitDBReplicatedStateRegistry.ts) forwards application documents without a participant-level encryption step.

The inference is that a participating replica operator can inspect replicated
metadata even when its HTTP API filters results by user. This does **not** prove
that private-network blocks are automatically readable from the public DHT.
Public and private IPFS stores/routing must be distinguished in every capture.

| Data | Current fields and source | Copies / readers | Current lifetime evidence | Target boundary |
| --- | --- | --- | --- | --- |
| Conversation graph | [id, networkId, participantIds, name/type, timestamps](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/conversations/infrastructure/orbitdb/documents/OrbitDBConversationDocument.ts) | OrbitDB conversations; private-network replica operators | No bounded history TTL established | Encrypted participant vault; no network-wide conversation catalog |
| Messages and reply graph | [authorId, recipientIds, conversationId/messageId, previous/reply/target IDs, type, signature, timestamps; encryptedPayload](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/conversations/infrastructure/orbitdb/documents/OrbitDBConversationMessageDocument.ts) | OrbitDB messages; operators can correlate graph despite payload encryption | No bounded history TTL established | Entire operation and its metadata encrypted to participants |
| Membership and roles | [owner, members, banned identities, roles/permissions, channels/visibility, profile and deletion markers](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/communities/infrastructure/orbitdb/documents/OrbitDBCommunityDocument.ts) | OrbitDB communities, including private visibility fields | Deletion markers do not prove historical erasure | Roster and signed policy only in admitted scopes |
| Invitations | [communityId, creatorIdentityId, token, usage limit/count, expiry, optional encrypted community key](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/communities/infrastructure/orbitdb/documents/OrbitDBCommunityInviteDocument.ts) | Replicated invite documents; token and creator linkage are explicit | Expiry limits use, not established removal of old copies | Single-use bootstrap capability; no replicated plaintext token |
| Calls | [creatorIdentityId, participantIds, join/leave/decline/missed times, scope IDs and call status](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/calls/infrastructure/orbitdb/documents/OrbitDBCallDocument.ts) | OrbitDB calls; network operators see call relationships/history | No bounded history TTL established | Local encrypted history; 60-second encrypted signalling only |
| Call signalling | [call/signal/network/owner-node IDs, sender/recipient/participant IDs, signalType, payload, retry and expiry](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/calls/domain/events/CallSignalSentAttributes.ts) | Runtime delivery state and network-key-encrypted events; all key holders can decode observed events | Event expiry does not retract captured events | Participant-scoped delivery, no shared-network event fan-out |
| Identity publication | [publicKey, encryptedPrivateKey/masterKey, derivation parameters, networks, profile, previousCid, signature/version/time](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/identities/infrastructure/ipfs/documents/IpfsIdentityDocument.ts) | IPFS JSON and identity/handle routing records; retrievers see unencrypted fields and version linkage | Content-addressed old copies may remain | Public profile is opt-in and minimal; private network/device/recovery data stays protected |
| Keychain | [owner ID, encrypted payload, previousCid, signature/version/time](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/keychains/infrastructure/ipfs/documents/IpfsKeychainDocument.ts) | IPFS ciphertext plus owner-to-CID routing; encrypted relationships are not a public plaintext roster | Historical ciphertext and linkage may remain | Encrypted local vault and explicit encrypted device transfer/export |
| Attachment registry | [CID, owner identity, networks, filename/type/size, context/priority/timestamps](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/content-replication/domain/ContentReplication.ts) | OrbitDB replication registry plus IPFS bytes; registry links owner and content | No remote erasure guarantee established | Private expiring blobs; manifest and ownership inside encrypted operations |
| Replica claims | [CID, node, network and time](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/content-replication/domain/ContentReplicaClaim.ts) | OrbitDB claims expose location/copy relationships | Claim expiry/removal cannot retract blocks | At most two selected blob/mailbox copies; no public replica catalog |
| Presence | [identity, ownerNodeId, status/custom message, activity/heartbeat times](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/presence/domain/IdentityPresence.ts) | Runtime leases and network events map identities to nodes/activity | Lease expiry is not capture erasure | Opt-in relationship scope, encrypted, 90-second expiry |
| Push subscriptions | [endpoint, identity, p256dh/auth, expiry/createdAt](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/push-notifications/infrastructure/local-db/LocalPushSubscriptionRepository.ts) | Local Level; node operator can map identity to delivery endpoint | Subscription expiry exists; full backup/log retention not established | Optional opaque installation subscription; generic wakeup, no private event IDs |
| Push failure logs | [Full endpoint and endpoint host on failure](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/push-notifications/infrastructure/web-push/WebPushNotificationDelivery.ts) | Node logs add another endpoint copy | Log retention not established | Redact endpoint/capability entirely; bounded request-local diagnostics |
| Local node database | [JSON records and namespace/index keys](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/shared/infrastructure/local-db/EmbeddedLocalDatabase.ts) | Level JSON, no record-encryption wrapper at this layer | Application-specific; no general privacy TTL | Opaque queues and configuration only; atomic expiry/outbox handling |

## Additional relationship indexes and client copies

- [Reactions](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/conversations/infrastructure/orbitdb/documents/OrbitDBMessageReactionDocument.ts): Actor, conversation/message references, emoji, timestamps and removal status add an activity graph to replicated documents.
- [Conversation repository](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/conversations/infrastructure/orbitdb/OrbitDBConversationRepository.ts): Read-marker head keys include conversation and recipient identity. Encryption of a message body does not protect these keys.
- [Moderation entries](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/contexts/communities/domain/entities/moderation/CommunityModerationLogEntry.ts): Actor, target, details and timestamps disclose administration relationships to recipients of the moderation store.

- [Client keychain entries](https://github.com/haskou/pigeon-swarm-ui/blob/5682be6bbb1247091185adbf9331da785f96c90c/src/contexts/identities/infrastructure/keychain/ConversationKeyEntry.ts): Conversation/community IDs, peer identity, symmetric keys and creation/version fields are inside the encrypted keychain payload. No separate contacts repository was identified; these entries and conversation membership are existing contact-like representations.
- [Attachment manifests](https://github.com/haskou/pigeon-swarm-ui/blob/5682be6bbb1247091185adbf9331da785f96c90c/src/contexts/attachments/application/contracts/MessageAttachment.ts): CID, filename, MIME/size, chunk references and previews identify content. The companion encryption contract contains key/IV material; it belongs only inside an encrypted message.
- [Workspace persistence](https://github.com/haskou/pigeon-swarm-ui/blob/5682be6bbb1247091185adbf9331da785f96c90c/src/app/presentation/workspace/components/workspacePersistence.ts): Per-identity localStorage records retain selected conversations/communities/channels and unread state alongside encrypted drafts. Local metadata is readable even when draft content is encrypted.
- [Saved credentials](https://github.com/haskou/pigeon-swarm-ui/blob/5682be6bbb1247091185adbf9331da785f96c90c/src/contexts/identities/infrastructure/storage/savedCredentials.ts): The current code stores the identity ID and removes legacy password fields. This inventory does not claim that the current UI stores plaintext passwords.

These local/history copies need an encrypted vault and an explicit export and
retention policy. A compromised unlocked device or malicious client script can
still read them. Verifiable client distribution is a dependency, not an optional
hardening step when using an untrusted backend operator.

## Transport and secondary copies

[Libp2pGossipsubAdapter](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/shared/infrastructure/messageBus/libp2p/Libp2pGossipsubMessageBusAdapter.ts) selects networks from event attributes; it does not select cryptographic recipients. [PubSubNetworkMessageCodec](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/shared/infrastructure/messageBus/libp2p/PubSubNetworkMessageCodec.ts) encrypts private-network envelopes with AES-256-GCM and a key derived from the shared network key. Public-network envelopes are clear. [PubSubTopicResolver](https://github.com/haskou/pigeon-swarm-node/blob/4f43437f18a70ee4588fc05b8651f47bc5d23a0f/src/shared/infrastructure/messageBus/libp2p/PubSubTopicResolver.ts) exposes network/context topic structure.

Node error logs can include network/store IDs, document/head keys and missing
CIDs. Notification recipient indexes and read-marker indexes encode identities.
Operator backups, exported history, browser storage, IPFS blockstores, OrbitDB
logs and remote replicas are distinct copies; deleting the current document is
not evidence that all these copies disappeared.

Public IPFS provider metadata can disclose PeerIDs and offered CIDs; transport
encryption is not content-access control. See the primary
[IPFS privacy documentation](https://docs.ipfs.tech/concepts/privacy-and-encryption/).
The target default therefore excludes private envelopes, indexes, manifests and
blobs from public IPFS, rather than relying on an eventual unpin to retract them.

The [ADR](ADR-001-private-data.md) supplies the actor boundaries, target retention
and transition policy for every category above. New private-mode release tests
must inspect raw storage and traffic as a nonparticipant, not only query the
application API as an authorized user.
