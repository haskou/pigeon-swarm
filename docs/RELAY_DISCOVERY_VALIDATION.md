# Automatic relay discovery and recovery

Run the deployment acceptance test against an immutable application image:

```sh
export PIGEON_TEST_IMAGE=sha256:<local-image-id>
npm run test:relay
```

A published `ghcr.io/haskou/pigeon-swarm@sha256:<digest>` is also accepted.
The `Validate wrapper` workflow runs this test against the same image built from
its pinned backend and client revisions. Docker must be running; the test builds
a small Alpine/iptables helper. No browser packages or local backend checkout are
required for this test.

## Topology and fault isolation

The fixture starts four independent public DHT bootstrap containers and three
complete application containers on an internal Docker network. Each has a distinct
IPv4 address. The deliberately globally classified `11.254.0.0/24` subnet exercises
the production DHT address filter without a test mapper. Docker does not expose
host ports or attach these containers to an external network. If that subnet
overlaps an existing Docker network, setup fails without changing that network.

Each application is configured through its HTTP API with public relay listening
on port 4100, private relay publication and discovery enabled, and an empty manual
relay address list. Only public bootstrap addresses and a fresh private network
key are supplied. Relays must discover every other private relay automatically;
the expected topology is a full mesh.

Public relay mode explicitly advertises the directory endpoint. A private-only
publisher without public relay mode depends on libp2p address verification; this
fixture does not claim to validate that separate configuration or AutoNAT.

The IPv4-only fixture disables IPv6 and blocks mDNS before an application starts. Network namespaces live in
separate helper containers, so the rules survive an application restart. A cold
node must remain disconnected while public directory traffic is blocked, providing
a negative control against accidental local discovery.

A test-only preload retains handles returned by the image's original Helia
factories and exposes diagnostics and connection closure on container loopback.
Factory arguments and results, routing, discovery and application delivery remain
unchanged. Closing a private connection is checked to affect both peer links.
Every mesh assertion also compares the live peer identity with the saved key.
The preload is mounted only by this fixture; it is not added to the production
image or enabled by normal startup.

## Acceptance matrix

| Scenario                                                                                                   | Required evidence                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A starts before B; B initially cannot reach the public directory                                           | No premature private connection; automatic A–B connection after restoring public traffic                                             |
| C joins an already working A–B network                                                                     | All three relays discover each other without private address injection                                                               |
| Both C links are closed twice                                                                              | Full mesh and fresh application traffic recover after each interruption                                                              |
| All public directory traffic is blocked; the chosen initiator cannot make new private outbound connections | Firewall counters prove rejected attempts; another relay restores the cached private path within 90 seconds, including fresh traffic |
| C's application process restarts                                                                           | Persisted private peer identity, retained mDNS block, restored full mesh and fresh traffic                                           |

The first full-image run exposed a startup race: concurrent key creation could
give the live relay a different identity from the one saved on disk. The backend
now shares a pending load or creation across startup consumers and fails on an
unreadable existing key instead of replacing it. This regression is why the test
checks both the saved key and identity persistence, in addition to connectivity.

Every phase creates a new community, roster and voice channel through signed HTTP
requests. Every participating node must return the complete expected community
document. Native authenticated WebSockets then receive fresh call signals over
each adjacent node pair. Assertions include the delivery ID, sender, recipient,
network, call, unique payload and valid expiry. A successful HTTP POST or a peer
count alone cannot pass the traffic probe. Test identities and storage are
disposable; cleanup removes only containers and the network created by this run.

Before starting the topology, an isolated container checks the compiled backend against a real filesystem: a partial `ENOSPC` write must leave no final key or temporary directory, twelve concurrent callers must share the persisted identity, reload must preserve it, and an exclusive-publication race must preserve the competing key. Key files must have mode `0600`; no private key material is printed.

## Bounds and scope

Discovery runs every 2 seconds, connected discovery every 4 seconds, publication
every 2 seconds, and public peer waits are 1 second. Records remain valid for
10 minutes. These accelerated fixture settings are not production latency
guarantees. The production 45-second fallback dial window remains unchanged.
Individual mesh waits are bounded at 120 seconds and the test has a 10-minute
outer timeout. Phase timing includes fresh traffic where reported.

The local acceptance run on 2026-09-14, with backend `a09b84e84c9b` and client
`8fab1731015e`, completed in 91.2 seconds. Delayed public recovery took 4.6 seconds,
late publisher startup 6.0 seconds, repeated link recovery 2.9 and 3.0 seconds,
cached recovery with 47 rejected outbound attempts 50.5 seconds, and process
restart recovery 5.3 seconds. These measurements describe that isolated run only.

Cache expiry, replacement, coalesced discovery, bounded retry delays and duplicate
dial protection are additionally covered by the backend's
[relay acceptance suite](https://github.com/haskou/pigeon-swarm-node/blob/main/docs/relay-recovery-acceptance.md).
This finite topology does not establish resistance to an unbounded malicious
publisher population.

This validates application discovery, replicated state and call signalling in an
isolated deployment. It does not establish public NAT/CGNAT reachability, audible
media, anonymity, or end-to-end confidentiality from a malicious network member.
TURN and browser audio have separate acceptance tests. The private-data security
work remains tracked independently.
