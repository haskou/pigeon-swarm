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
`sha256:` image ID. The test prints it at startup so evidence can be tied to
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
Before the cross-node invitation, each browser waits for its node to report the private network converged with the peer connected, so keychain metadata published during registration has replicated.
The scenario checks:

- Invitation acceptance and bidirectional private-message decryption.
- Community creation, discovery, instant membership and bidirectional text delivery.
- Direct and community voice calls with increasing inbound audio in both browsers.
- Recovery when each client initially receives `409 CallParticipantNotFoundError`
  for all signalling requests during a 300 ms participant-replication window.
- Non-NAT runs restart the callee's node (`app-b`) during the direct call. The
  callee's realtime connection must close and be acknowledged again, both
  browsers must keep the call, each must hold exactly one live peer connection,
  and inbound relay audio must keep increasing in both. The runner then waits
  until both nodes report the private network converged again. The runner does
  not restart the callee's separate TURN service. The service must detect that
  it lost `app-b`'s network namespace and rejoin through its restart policy.
  Media must then recover through ICE restart.
- Leaving and rejoining voice, including another call after password login.
- Removing participants after a normal departure and after a client loses network access and closes without a successful leave request.
- Three explicit logout/password-login cycles, with exact retained private
  and community messages.
- A synthetic plaintext canary is sent as a private message and must be displayed in both browsers and after logins. After the run, both nodes are stopped and each data volume is scanned by a one-off container; container logs are checked too. The scan must find no copy of the canary in any encoding defined by `tests/canary-scan.mjs`: raw, hex (lower and upper case), JSON `\uXXXX` escapes, UTF-16LE and UTF-16BE, and base64 and base64url at each of the three byte offsets. A planted control copy of each encoding must be detected.
- Non-NAT runs also restore from stopped copies: after both nodes stop, `app-a`'s volumes are copied with `scripts/restore-copy.sh` and a third node started from the copies keeps `caller-1`'s identity, its node network list and its private network peer ID, after start and after restart. The canary scan then covers the restored volumes. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
- Fresh channel reads after departures, with no stale participant rows.

The temporary signalling rejection is injected at the HTTP boundary; subsequent
requests go to the real nodes. The test verifies that both clients exercised the
rejection path. No test code copies SDP or ICE candidates between browsers or
inserts call records into a database.

Failure diagnostics distinguish preview requests from timeline history and
report response status, result count, pagination and call operation/signal type.
They exclude message bodies, identity IDs and key material.
Decryption timeouts also report per-node counts of message items and encrypted states (decrypt-failed or missing-key), classified by DOM class and copy presence without logging message text.
Each closed call peer reports why it closed: the function names on the stack that called `close()`, and the last call event the page received before that call (event type, call id, live call revision and joined participant count). Signal events, identity IDs and payloads are left out.
The canary scan covers the encodings listed above in application data files and container logs. It does not cover encrypted or compressed storage contents, browser storage, DHT, push, or traffic captures.

For media verification, each browser is restricted to the UDP TURN URL advertised
by its own backend, retaining the backend-issued credentials. Both selected
candidates must be relays and their addresses must match the two different TURN
containers. Received audio packets and bytes must increase on the same connected
peer in each browser. The output contains phase names and packet deltas, excluding
credentials, user keys, SDP and candidate addresses.

Containers, volumes and temporary certificates are disposable. Cleanup runs on
success and failure; a cleanup failure identifies the generated project name.

## Coverage limits

For the same UI workflow across two simulated home NATs, run
`npm run test:e2e:nat`. See [NAT call validation](NAT_CALL_VALIDATION.md) for the
isolated topology, negative network controls and remaining coverage limits.

This is automated evidence for application signalling and bidirectional media
between independent relays on a local Docker network. It does not establish public
reachability, real home NAT/CGNAT behavior, blocked-UDP fallback, or recovery of an
active call after a TURN relay restart without a node restart. It also does not
establish every feature or
security guarantee in issue #34: concurrent three-node mutations, revocation,
captures of DHT and push traffic, and retention and storage migration remain
separate acceptance scenarios. The existing single-server media test covers
UDP/TCP/TLS media before and after restarting the application container, which
supervises coturn. External acceptance remains open in
[issue #29](https://github.com/haskou/pigeon-swarm/issues/29) and in the unchecked
external criteria of closed [issue #24](https://github.com/haskou/pigeon-swarm/issues/24).
