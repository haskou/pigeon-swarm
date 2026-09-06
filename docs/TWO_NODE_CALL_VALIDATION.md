# Two-node application end-to-end validation

The integrated workflow suite belongs in `pigeon-swarm`, where the image combines
the client, backend, cryptographic package and network runtime. Keep focused
component regressions in the repository that owns the behavior. Run this suite
when changing messaging, sessions, community membership, calls or deployment. It complements the single-server
UDP/TCP/TLS transport probe with the actual application workflow.

```sh
npm ci --ignore-scripts
docker pull ghcr.io/haskou/pigeon-swarm:latest
export PIGEON_TEST_IMAGE="$(docker image inspect ghcr.io/haskou/pigeon-swarm:latest --format '{{index .RepoDigests 0}}')"
npm run test:e2e
```

`PIGEON_TEST_IMAGE` accepts a published immutable image digest or a local
`sha256:` image ID. The test prints it with its result so evidence can be tied to
a particular build. `npm run test:calls` remains an alias for existing automation.

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
generated recovery key. All subsequent actions use normal application controls.
The scenario checks:

- Invitation acceptance and bidirectional private-message decryption.
- Community creation, discovery, instant membership and bidirectional text delivery.
- Direct and community voice calls with increasing inbound audio in both browsers.
- Leaving and rejoining voice, including another call after password login.
- Removing participants after a normal departure and after a client loses network access and closes without a successful leave request.
- Remembered-session restoration, explicit logout/login, and retained private and community history.
- Fresh channel reads after departures, with no stale participant rows.

No test code copies SDP or ICE candidates between
browsers or inserts call records into a database.

For media verification, each browser is restricted to the UDP TURN URL advertised
by its own backend, retaining the backend-issued credentials. Both selected
candidates must be relays and their addresses must match the two different TURN
containers. Received audio packets and bytes must increase on the same connected
peer in each browser. The output contains phase names and packet deltas, excluding
credentials, user keys, SDP and candidate addresses.

Containers, volumes and temporary certificates are disposable. Cleanup runs on
success and failure; a cleanup failure identifies the generated project name.

## Coverage limits

This is automated evidence for application signalling and bidirectional media
between independent relays on a local Docker network. It does not establish public
reachability, real home NAT/CGNAT behavior, blocked-UDP fallback, or recovery of an
active call after a relay restart. It also does not establish every feature or
security guarantee in issue #34: attachment delivery, concurrent three-node
mutations, revocation, traffic-analysis resistance and storage migration remain
separate acceptance scenarios. The existing single-server media test covers
UDP/TCP/TLS and new calls after coturn restart. External acceptance remains tracked
in [issue #24](https://github.com/haskou/pigeon-swarm/issues/24) and
[issue #29](https://github.com/haskou/pigeon-swarm/issues/29).
