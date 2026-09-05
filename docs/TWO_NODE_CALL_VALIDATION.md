# Two-node application call validation

Run this test when changing call signalling, TURN credential issuance, client
negotiation or the deployment scripts. It complements the single-server
UDP/TCP/TLS transport probe with the actual application workflow.

```sh
npm ci --ignore-scripts
docker pull ghcr.io/haskou/pigeon-swarm:latest
export PIGEON_TEST_IMAGE="$(docker image inspect ghcr.io/haskou/pigeon-swarm:latest --format '{{index .RepoDigests 0}}')"
npm run test:calls
```

`PIGEON_TEST_IMAGE` must contain the immutable application image digest. The test
prints it with its result so evidence can be tied to a particular build. Testing
local source changes requires publishing an image containing those changes first.

The fixture starts two application containers with separate storage, two coturn
services with independent secrets, and two isolated Chromium sessions. All services
share an internal Docker network without published host ports. Disposable HTTPS
gateways inside the browser container provide secure browser contexts and forward
HTTP and WebSocket traffic to the corresponding application node. Only those test
certificates are accepted by the browser contexts.

The applications join a generated private libp2p network using explicit bootstrap
addresses, avoiding dependence on Docker multicast discovery. It restarts the apps
one at a time and verifies their addresses and peer identities: restarting both
together can exchange Docker-assigned IPs and invalidate those bootstrap addresses.
Registration starts only after both nodes report the expected peer and converged
OrbitDB stores. Users register through the interface with a password and a
generated recovery key. The test
creates a direct conversation and a discoverable public community inside that
private network, then exercises direct and community voice calls through the
normal application controls. No test code copies SDP or ICE candidates between
browsers or inserts call records into a database.

For media verification, each browser is restricted to the UDP TURN URL advertised
by its own backend, retaining the backend-issued credentials. Both selected
candidates must be relays and their addresses must match the two different TURN
containers. Received audio packets and bytes must increase on the same connected
peer in each browser. The output contains phase names and packet deltas, excluding
credentials, user keys, SDP and candidate addresses.

Containers, volumes and temporary certificates are disposable. Cleanup runs on
success and failure; a cleanup failure identifies the generated project name.

## What this establishes

This is automated evidence for application signalling and bidirectional media
between independent relays on a local Docker network. It does not establish public
reachability, real home NAT/CGNAT behavior, blocked-UDP fallback, or recovery of an
active call after a relay restart. The existing single-server media test covers
UDP/TCP/TLS and new calls after coturn restart. External acceptance remains tracked
in [issue #24](https://github.com/haskou/pigeon-swarm/issues/24) and
[issue #29](https://github.com/haskou/pigeon-swarm/issues/29).
