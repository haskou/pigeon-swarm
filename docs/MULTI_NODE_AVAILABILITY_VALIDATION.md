# Multi-node direct inbox availability validation

A direct-message inbox lives on its owner's home node. A client built with
mailbox availability servers also keeps a copy of the inbox on each listed
node, announces those servers to its peers, and reads them on every sync pass.
A sender appends each message to the recipient's home and to every announced
server under one envelope id. This suite checks that path end to end with two
real nodes and the real client in Chromium
([pigeon-swarm-node#290](https://github.com/haskou/pigeon-swarm-node/issues/290),
[pigeon-swarm-ui#368](https://github.com/haskou/pigeon-swarm-ui/pull/368)).

```sh
npm ci --ignore-scripts
export PIGEON_TEST_IMAGE='<published digest or local sha256: image ID>'
# In a pigeon-swarm-ui checkout at the pinned PIGEON_SWARM_UI_SHA:
#   yarn install --frozen-lockfile
#   VITE_INDEPENDENT_CLIENT=true \
#     VITE_MAILBOX_AVAILABILITY_SERVERS=https://localhost:8443/api,https://localhost:8444/api \
#     yarn build --outDir /absolute/path/availability-client-dist
export PIGEON_AVAILABILITY_CLIENT_DIST=/absolute/path/availability-client-dist
npm run test:e2e:availability
```

The client must be the independent build: the image's bundled client is built
without `VITE_MAILBOX_AVAILABILITY_SERVERS`, so it has no availability servers.
Both test gateways are listed; a client skips the node it is connected to, so
each user's availability server is the other node.

## Topology

The fixture is the two-node bring-up of
[the two-node workflow suite](TWO_NODE_CALL_VALIDATION.md), shared through
`tests/two-node-fixture.mjs`: two application containers with separate storage
on one internal Docker network, a private libp2p network bootstrapped by
explicit addresses, restarted one node at a time and checked converged before
any browser step. The browser container serves the client from
`http://127.0.0.1:8445` and reaches node A at `https://localhost:8443` and
node B at `https://localhost:8444` through disposable HTTPS gateways. A gateway
answers 502 while its node is down. The browser half is
`tests/multi-node-availability-browser.mjs`; the runner is
`tests/multi-node-availability.integration.mjs`.

Node A is home for Alice's two devices, `alice-1` and `alice-2`. Node B is home
for Bob.

## Scenario

1. Alice and Bob register through the UI on their own nodes. Each waits until
   the other's identity is readable from its own node and the private network
   reports converged.
2. Alice invites Bob by identity id; Bob accepts from his notifications. One
   message each way renders exactly once on both sides.
3. `alice-2` is paired through the UI pairing flow on node A and opens the
   conversation. A message from Bob renders exactly once on all three devices.
4. Bob's client records Alice's announced availability server (node B). Bob
   then sends a message: his client must append it with a 2xx status to the
   same Alice inbox on node A and on node B. Both Alice devices render it
   exactly once, and `alice-2` must have read the inbox from node B.
5. `alice-1` revokes `alice-2` from Manage devices; the device list drops to
   one. `alice-1` must then read the inbox on node B again; its client prunes
   the inbox readers before each first read under a new root.
6. The runner kills node A (`docker compose kill app-a`) and confirms the
   container exited. Node A then answers 502 through its gateway.
7. Bob sends a message. His append to Alice's inbox on node B must succeed.
   `alice-1`, still loaded and still connected to the dead node A, must render
   it exactly once within 90 s, from a node B read that returned envelopes; no
   node A read may succeed after the kill.
8. After 20 s more, the revoked `alice-2` must not render that message. Every
   read capability `alice-2` presented to node B before the revoke is replayed
   against node B and must be refused with 404, while a capability of
   `alice-1` for the same inbox on node B must still be answered with 200.

The logs carry stages, ports, statuses and counts only: no message text,
mailbox ids, tokens or envelope bodies.

## What this proves

- A sender fans a direct message out to the recipient's home and the announced
  availability server, and the recipient's devices deduplicate the two copies.
- With the recipient's home node killed mid-session, the recipient's open
  client keeps receiving direct messages through the availability server
  without reconnecting or reloading.
- A device revoked across nodes stops reading the inbox on the other node: its
  earlier read capabilities are refused there and it renders nothing new.

## What this does not prove

- Sending while one's own home node is down. Alice's client is connected to
  node A, which handles her session, identity lookups and sends; the suite
  does not claim that she can send during the outage.
- Recovery or replay when node A comes back, and envelope retention limits on
  the availability server.
- The image's bundled client: it has no availability servers configured.
- Public reachability. Both nodes and the gateways run on one internal Docker
  network on one host; NAT, CGNAT, DNS and TLS with public certificates are
  outside this test ([NAT call validation](NAT_CALL_VALIDATION.md) covers
  simulated NAT for calls only).
- More than one availability server, a malicious availability server, or a
  sender whose stored announcement is stale.
- Forgetting a device by password re-login, community or group conversations,
  attachments and calls during the outage.
