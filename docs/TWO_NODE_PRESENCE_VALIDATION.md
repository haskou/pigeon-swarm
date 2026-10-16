# Two-node contact presence validation

Contacts who share their status in a direct conversation see each other's
status through end-to-end encrypted presence inboxes. Each inbox lives on its
reader's home node, so a contact whose home is another node must receive the
update on that node. This suite checks that path with two real nodes and the
real client in Chromium
([pigeon-swarm-ui#453](https://github.com/haskou/pigeon-swarm-ui/issues/453)).
The single-node half runs in the UI real-node suite
(`e2e/contact-presence.spec.ts` in pigeon-swarm-ui).

```sh
npm ci --ignore-scripts
export PIGEON_TEST_IMAGE='<published digest or local sha256: image ID>'
# In a pigeon-swarm-ui checkout at the pinned PIGEON_SWARM_UI_SHA:
#   yarn install --frozen-lockfile
#   VITE_INDEPENDENT_CLIENT=true yarn build
export PIGEON_CLIENT_DIST=/absolute/path/pigeon-swarm-ui/dist
npm run test:e2e:presence
```

The client must be the independent build. Each user connects it to their own
node, and the client publishes that node as the user's mailbox home.

## Topology

The fixture is the two-node bring-up of
[the two-node workflow suite](TWO_NODE_CALL_VALIDATION.md), shared through
`tests/two-node-fixture.mjs`: two application containers with separate storage
on one internal Docker network, a private libp2p network bootstrapped by
explicit addresses, restarted one node at a time and checked converged before
any browser step. The browser container serves the client from
`http://127.0.0.1:8445` and reaches node A at `https://localhost:8443` and
node B at `https://localhost:8444` through disposable HTTPS gateways. The
browser half is `tests/two-node-presence-browser.mjs`; the runner is
`tests/two-node-presence.integration.mjs`.

Node A is Alice's home. Node B is Bob's.

## Scenario

1. Alice and Bob register through the UI on their own nodes. Each waits until
   the other's identity is readable from its own node and the private network
   reports converged.
2. Alice invites Bob by identity id and Bob accepts from his notifications.
   Bob's row for Alice shows no status.
3. Bob turns on "Share status" in the conversation menu. His client creates
   and reads his presence inbox on node B. Bob sees Alice offline.
4. Alice turns on "Share status"; her client creates and reads her presence
   inbox on node A. Bob must see Alice online within 90 s. Alice's update must
   have been appended with a 2xx status to Bob's presence inbox on node B, and
   never accepted on node A.
5. Alice must see Bob online within 240 s. Bob's first update was refused
   because Alice's inbox did not exist yet, so his client paused for two
   minutes before refreshing. His update must have been appended with a 2xx
   status to Alice's presence inbox on node A, and never accepted on node B.
6. Alice picks Invisible from her profile menu. Bob must see her offline
   within 180 s: the 90 s lifetime of her last update, the 30 s read interval,
   and the 5 s re-evaluation. Bob never sees the Invisible status.

The logs carry stages, ports, statuses and counts only: no status of a user,
mailbox ids, tokens or envelope bodies.

## What this proves

- A presence update reaches a contact whose home is another node, in both
  directions, through the contact's home and not the sender's node.
- The contact's client reads the update from its own home and shows the
  shared status.
- Invisible sends nothing across nodes: the contact sees the last update
  expire and shows the user offline.

## What this does not prove

- Idle and Do not disturb, sign-out, or turning sharing off.
- Delivery when the contact's home is down: presence uses the primary route
  only, with no availability servers.
- The image's bundled client, which both users would load from one node.
- Public reachability. Both nodes and the gateways run on one internal Docker
  network on one host; NAT, CGNAT, DNS and TLS with public certificates are
  outside this test.
